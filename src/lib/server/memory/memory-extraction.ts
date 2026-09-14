import { HumanMessage, SystemMessage } from '@langchain/core/messages'

import { buildLLM } from '@/lib/server/build-llm'
import { getMemoryDb, defaultImportanceForCategory } from '@/lib/server/memory/memory-db'
import { log } from '@/lib/server/logger'

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
  'Answer with JSON only: {"facts": ["...", "..."]}. An exchange with nothing durable in it is',
  '{"facts": []}, and that is the common case.',
].join('\n')

export interface ExtractionTurn {
  agentId: string
  sessionId?: string | null
  message: string
  response: string
}

export interface ExtractionDeps {
  /** Injected in tests; production asks the utility model. */
  generate?: (prompt: string, turn: ExtractionTurn) => Promise<string>
}

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

function renderTurn(turn: ExtractionTurn): string {
  return [
    `User: ${turn.message.replace(/\s+/g, ' ').slice(0, MAX_TURN_CHARS)}`,
    `Assistant: ${turn.response.replace(/\s+/g, ' ').slice(0, MAX_TURN_CHARS)}`,
  ].join('\n\n')
}

async function defaultGenerate(prompt: string, turn: ExtractionTurn): Promise<string> {
  const { llm } = await buildLLM({
    sessionId: turn.sessionId || null,
    agentId: turn.agentId,
    responseFormat: 'json_object',
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
    const raw = await generate(renderTurn({ ...turn, message, response }), turn)
    const facts = parseExtractedFacts(raw)
    if (!facts.length) return 0

    const db = getMemoryDb()
    let stored = 0
    for (const text of facts) {
      try {
        db.addCandidate({ agentId: turn.agentId, sessionId: turn.sessionId || null, text, source: 'chat-turn' })
        stored++
      } catch { /* one unusable fact must not lose the others */ }
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
    try {
      const title = candidate.text.length > 70 ? `${candidate.text.slice(0, 70).trimEnd()}...` : candidate.text
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
