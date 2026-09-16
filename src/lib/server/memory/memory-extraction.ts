import { HumanMessage, SystemMessage } from '@langchain/core/messages'

import { buildLLM } from '@/lib/server/build-llm'
import { getMemoryDb, defaultImportanceForCategory, type MemoryCandidate } from '@/lib/server/memory/memory-db'
import { log } from '@/lib/server/logger'
import { checkStandingRulesBudget, listStandingRules } from '@/lib/server/memory/standing-rules'

/**
 * Turning conversations into memories.
 *
 * WHY. In the live store 122 of 165 rows are machine-written and every one of
 * them is excluded from recall by design — session archives, working-tier turn
 * dumps, consolidation digests. What actually reaches an agent is only what it
 * chose to write by hand: 43 entries, roughly one per five to eight sessions.
 * Not for lack of material — there are 94 full transcripts — but because
 * nothing ever distilled them.
 *
 * A comparable fleet on the same machine holds 3658 extracted candidates,
 * because it extracts on EVERY turn, asynchronously, with a cheap model. That
 * is the whole difference, and this is that step.
 *
 * WHAT IT DOES NOT DO. It does not write memories. Extraction is cheap and runs
 * often, so a bad turn would otherwise leave rubbish in recall that nobody can
 * tell from a real fact. It writes candidates; `promoteCandidates` decides.
 */

/** One turn rarely contains more than a few durable facts; more is the model padding. */
export const MAX_FACTS_PER_TURN = 5
/** Below this, an exchange is an acknowledgement, not material. */
const MIN_TURN_CHARS = 80
/** A "fact" shorter than this is a word, not a sentence worth keeping. */
const MIN_FACT_CHARS = 20
/** Enough of a turn to judge it; the rest is rarely where the fact is. */
const MAX_TURN_CHARS = 6_000

const EXTRACTION_SYSTEM = [
  'You extract durable facts from one exchange between a user and their assistant.',
  '',
  'Keep only what will still matter in a month: a preference the user stated, a correction they made,',
  'a decision and its reason, a stable fact about their environment, conventions or workflow, or the',
  'solution to a problem that will recur.',
  '',
  'Drop everything else. No task progress, no "what we did today", no restating the question, nothing',
  'that the code or the file system already says, nothing you would have to be in this conversation to',
  'understand.',
  '',
  'Write each fact as one self-contained sentence, in the language the user writes in, with the',
  'specifics in it — a name, a path, a number, a date.',
  '',
  'Separately, list the standing rules the USER gave: an instruction about how the assistant or its',
  'agents must work from now on — who gets which kind of work, which language to answer in, a',
  'workflow step to always or never take. Only what the user said or explicitly confirmed; never a',
  'suggestion the assistant made, never a one-off request for this task ("do these now", "fix this").',
  'Write each rule as one self-contained instruction in the user\'s language. The rules already on',
  'record are listed below the exchange: leave out any rule they already cover. If the user changed',
  'one of them, return the new full wording with "replaces" set to that rule\'s id.',
  '',
  'Answer with JSON only: {"facts": ["...", "..."], "rules": [{"text": "...", "replaces": "<id or null>"}]}.',
  'An exchange with nothing durable in it is {"facts": [], "rules": []}, and that is the common case.',
].join('\n')

/** Rules are rarer than facts; a turn that yields more is the model over-reading. */
export const MAX_RULES_PER_TURN = 2
/** How much of each recorded rule the extractor sees; enough to recognise it. */
const RULE_PREVIEW_CHARS = 160
/** Candidate source for an extracted rule; `:<id>` names the rule it replaces. */
const RULE_SOURCE = 'chat-turn-rule'
/** Category for a promoted rule, so the owner can tell learned rules apart. */
const LEARNED_RULE_CATEGORY = 'preference/learned'

export interface ExtractedRule {
  text: string
  replaces: string | null
}

export interface ExtractionTurn {
  agentId: string
  sessionId?: string | null
  message: string
  response: string
}

export interface ExtractionDeps {
  /** Injected in tests; production asks the utility model. */
  generate?: (prompt: string, turn: ExtractionTurn) => Promise<string>
  /** Injected in tests so a retry does not make the suite wait. */
  retryDelayMs?: number
}

/**
 * How many times to wait out a busy helper.
 *
 * The classifier and working-state extraction run WITH the turn, so they always
 * ask for a slot first; memory extraction starts after the turn and, on a fleet
 * where scheduled runs overlap, always lost the race. Measured live: the
 * classifier completed and extraction was refused `busy` on the same turn.
 *
 * Nobody waits on extraction, so it can afford to wait. That is the difference
 * between a brake and starvation.
 */
const BUSY_RETRIES = 3
const BUSY_RETRY_DELAY_MS = 4_000

/** A refusal that a moment's patience can fix. A spent cap cannot. */
function isTransientRefusal(err: unknown): boolean {
  return /refused by budget: busy/i.test(err instanceof Error ? err.message : String(err))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Strip the framing a small model tends to wrap around its answer. */
function firstJsonBlock(raw: string): string | null {
  const text = String(raw || '').trim()
  if (!text) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.search(/[[{]/)
  if (start < 0) return null
  return body.slice(start)
}

export function parseExtractedFacts(raw: string): string[] {
  const block = firstJsonBlock(raw)
  if (!block) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    // A truncated or malformed answer is not worth salvaging: half a fact is
    // worse than none, because it still looks like a memory afterwards.
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { facts?: unknown }).facts))
        ? (parsed as { facts: unknown[] }).facts
        : []

  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    const text = typeof entry === 'string' ? entry.replace(/\s+/g, ' ').trim() : ''
    if (text.length < MIN_FACT_CHARS) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= MAX_FACTS_PER_TURN) break
  }
  return out
}

export function parseExtractedRules(raw: string): ExtractedRule[] {
  const block = firstJsonBlock(raw)
  if (!block) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    return []
  }
  const list = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { rules?: unknown }).rules)
    ? (parsed as { rules: unknown[] }).rules
    : []

  const out: ExtractedRule[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
    const rawText = typeof entry === 'string' ? entry : typeof record?.text === 'string' ? record.text : ''
    const text = rawText.replace(/\s+/g, ' ').trim()
    if (text.length < MIN_FACT_CHARS) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const replaces = typeof record?.replaces === 'string' && /^[\w-]{1,64}$/.test(record.replaces.trim())
      ? record.replaces.trim()
      : null
    out.push({ text, replaces })
    if (out.length >= MAX_RULES_PER_TURN) break
  }
  return out
}

function renderTurn(turn: ExtractionTurn, recordedRules: string[]): string {
  return [
    `User: ${turn.message.replace(/\s+/g, ' ').slice(0, MAX_TURN_CHARS)}`,
    `Assistant: ${turn.response.replace(/\s+/g, ' ').slice(0, MAX_TURN_CHARS)}`,
    `Rules already on record:\n${recordedRules.length ? recordedRules.join('\n') : '(none)'}`,
  ].join('\n\n')
}

function recordedRuleLines(agentId: string): { lines: string[]; ids: Set<string> } {
  try {
    const rules = listStandingRules(agentId)
    return {
      lines: rules.map((entry) => {
        const body = String(entry.content || entry.title || '').replace(/\s+/g, ' ').trim()
        const preview = body.length > RULE_PREVIEW_CHARS ? `${body.slice(0, RULE_PREVIEW_CHARS).trimEnd()}...` : body
        return `- ${entry.id}: ${preview}`
      }),
      ids: new Set(rules.map((entry) => entry.id)),
    }
  } catch {
    return { lines: [], ids: new Set() }
  }
}

async function defaultGenerate(prompt: string, turn: ExtractionTurn): Promise<string> {
  const { llm } = await buildLLM({
    sessionId: turn.sessionId || null,
    agentId: turn.agentId,
    responseFormat: 'json_object',
    // Named, so the once-a-minute limit is extraction's own and not shared with
    // the classifier and working-state, which run on the same turn.
    purpose: 'memory-extraction',
  })
  const answer = await llm.invoke([new SystemMessage(EXTRACTION_SYSTEM), new HumanMessage(prompt)])
  return typeof answer.content === 'string' ? answer.content : JSON.stringify(answer.content)
}

/**
 * Read one finished turn and file whatever durable facts it holds.
 *
 * Best-effort throughout: a helper that cannot run — no model, budget spent,
 * a malformed answer — must never cost the user their turn.
 */
export async function extractTurnCandidates(turn: ExtractionTurn, deps: ExtractionDeps = {}): Promise<number> {
  const message = String(turn.message || '').trim()
  const response = String(turn.response || '').trim()
  if (!turn.agentId) return 0
  // A two-word exchange is not worth a model call, and there are a lot of them.
  if (message.length + response.length < MIN_TURN_CHARS) return 0

  try {
    const generate = deps.generate ?? defaultGenerate
    const recorded = recordedRuleLines(turn.agentId)
    const prompt = renderTurn({ ...turn, message, response }, recorded.lines)
    const delayMs = typeof deps.retryDelayMs === 'number' ? deps.retryDelayMs : BUSY_RETRY_DELAY_MS

    let raw = ''
    for (let attempt = 0; ; attempt++) {
      try {
        raw = await generate(prompt, turn)
        break
      } catch (err) {
        if (attempt >= BUSY_RETRIES || !isTransientRefusal(err)) throw err
        await sleep(delayMs)
      }
    }

    const facts = parseExtractedFacts(raw)
    const rules = parseExtractedRules(raw)
    if (!facts.length && !rules.length) return 0

    const db = getMemoryDb()
    let stored = 0
    for (const text of facts) {
      try {
        db.addCandidate({ agentId: turn.agentId, sessionId: turn.sessionId || null, text, source: 'chat-turn' })
        stored++
      } catch { /* one unusable fact must not lose the others */ }
    }
    for (const rule of rules) {
      // Only an id the extractor was shown may be replaced; anything else is
      // a guess, and a guessed id would overwrite an unrelated memory.
      const replaces = rule.replaces && recorded.ids.has(rule.replaces) ? rule.replaces : null
      try {
        db.addCandidate({
          agentId: turn.agentId,
          sessionId: turn.sessionId || null,
          text: rule.text,
          source: replaces ? `${RULE_SOURCE}:${replaces}` : RULE_SOURCE,
        })
        stored++
      } catch { /* same as above */ }
    }
    return stored
  } catch (err) {
    log.debug('memory-extraction', 'turn extraction skipped', {
      agentId: turn.agentId,
      sessionId: turn.sessionId || null,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}

/** Category for a promoted fact until something smarter classifies it. */
const PROMOTED_CATEGORY = 'knowledge/facts'

function shortTitle(text: string): string {
  return text.length > 70 ? `${text.slice(0, 70).trimEnd()}...` : text
}

/**
 * File an extracted rule where the rules block reads it.
 *
 * A rule the owner stated in conversation used to land in `knowledge/facts`,
 * which is recalled only by keyword and framed as background -- so "from now
 * on, send coding work to the Developer" never became an instruction. It is
 * filed as `preference/learned` now, under the same budget as a hand-written
 * rule. When the budget is full the rule is kept as a searchable fact and the
 * owner is told in the log; it is never dropped.
 */
function promoteRuleCandidate(candidate: MemoryCandidate): boolean {
  const db = getMemoryDb()
  const replacesId = candidate.source.startsWith(`${RULE_SOURCE}:`)
    ? candidate.source.slice(RULE_SOURCE.length + 1)
    : null
  try {
    const target = replacesId ? db.get(replacesId) : null
    // Only a rule this agent owns. A global rule is the owner's own wording for
    // the whole fleet; one agent's conversation does not get to rewrite it.
    const canReplace = !!target && !!candidate.agentId && target.agentId === candidate.agentId
    const sameText = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
    const existingCopy = listStandingRules(candidate.agentId || '')
      .find((entry) => sameText(entry.content || '') === sameText(candidate.text))
    if (existingCopy) {
      db.markCandidate(candidate.id, 'promoted', { memoryId: existingCopy.id })
      return true
    }
    const refusal = checkStandingRulesBudget({
      agentId: candidate.agentId,
      next: { category: LEARNED_RULE_CATEGORY, title: shortTitle(candidate.text), content: candidate.text },
      replacingId: canReplace ? target.id : null,
    })

    if (refusal) {
      const entry = db.add({
        agentId: candidate.agentId,
        sessionId: candidate.sessionId,
        category: PROMOTED_CATEGORY,
        title: shortTitle(candidate.text),
        content: candidate.text,
        importance: defaultImportanceForCategory(PROMOTED_CATEGORY, false),
        metadata: { origin: 'turn-extraction', candidateId: candidate.id, ruleNotApplied: 'standing-rules-budget-full' },
      })
      db.markCandidate(candidate.id, 'promoted', { memoryId: entry.id })
      log.warn('memory-extraction', 'A rule the user gave was kept as a fact: the standing rules are full', {
        agentId: candidate.agentId,
        memoryId: entry.id,
      })
      return true
    }

    if (canReplace && target) {
      const updated = db.update(target.id, { content: candidate.text })
      if (!updated) throw new Error(`rule ${replacesId} vanished before it could be replaced`)
      db.markCandidate(candidate.id, 'promoted', { memoryId: updated.id })
      log.info('memory-extraction', 'Updated a standing rule from conversation', { agentId: candidate.agentId, memoryId: updated.id })
      return true
    }

    const entry = db.add({
      agentId: candidate.agentId,
      sessionId: candidate.sessionId,
      category: LEARNED_RULE_CATEGORY,
      title: shortTitle(candidate.text),
      content: candidate.text,
      importance: defaultImportanceForCategory(LEARNED_RULE_CATEGORY, false),
      metadata: { origin: 'turn-extraction', candidateId: candidate.id },
    })
    db.markCandidate(candidate.id, 'promoted', { memoryId: entry.id })
    log.info('memory-extraction', 'Learned a standing rule from conversation', { agentId: candidate.agentId, memoryId: entry.id })
    return true
  } catch (err) {
    db.markCandidate(candidate.id, 'rejected')
    log.debug('memory-extraction', 'rule candidate rejected', {
      candidateId: candidate.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Decide what the extractor found.
 *
 * The store's own content-hash dedup does the hard part: a fact it already
 * holds comes back as a reinforcement rather than a second row. The candidate
 * is marked either way, so the same sentence is never queued twice.
 */
export async function promoteCandidates(opts: { limit?: number } = {}): Promise<{ promoted: number; rejected: number }> {
  const db = getMemoryDb()
  const pending = db.listCandidates({ state: 'candidate', limit: opts.limit ?? 50 })
  let promoted = 0
  let rejected = 0

  for (const candidate of pending) {
    if (candidate.source === RULE_SOURCE || candidate.source.startsWith(`${RULE_SOURCE}:`)) {
      if (promoteRuleCandidate(candidate)) promoted++
      else rejected++
      continue
    }
    try {
      const title = shortTitle(candidate.text)
      const entry = db.add({
        agentId: candidate.agentId,
        sessionId: candidate.sessionId,
        category: PROMOTED_CATEGORY,
        title,
        content: candidate.text,
        // Scored here rather than left at 0: importance is the salience
        // multiplier, and an unscored entry never outranks anything.
        importance: defaultImportanceForCategory(PROMOTED_CATEGORY, false),
        metadata: { origin: 'turn-extraction', candidateId: candidate.id },
      })
      db.markCandidate(candidate.id, 'promoted', { memoryId: entry.id })
      promoted++
    } catch (err) {
      // A candidate the store refuses is not going to become acceptable later.
      db.markCandidate(candidate.id, 'rejected')
      rejected++
      log.debug('memory-extraction', 'candidate rejected', {
        candidateId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { promoted, rejected }
}
