/**
 * Standing rules: what the owner told an agent to do, delivered in full.
 *
 * WHY A SEPARATE BLOCK. Rules used to share the recall block's six slots with
 * pinned notes, and the pinned notes were taken first. On the live store nine
 * pinned notes filled every slot, so no `preference/*` or `identity/*` entry
 * reached an agent at all, and a `protocol/*` rule ("every development task
 * goes to the Developer agent") was not even eligible. Recall by keyword does
 * not rescue a rule either: "ezeket csináld meg" shares no word with it.
 *
 * Hermes solves the same problem by never retrieving rules: a small USER.md is
 * copied into the prompt in full, under a character cap, and a write that
 * would overflow the cap is refused so the agent has to consolidate. This is
 * that design. The cap lives here so the reader (the preamble) and the writer
 * (the memory tool) enforce the same number.
 */

import { createHash } from 'node:crypto'
import { filterMemoriesByScope, getMemoryDb, type MemoryScopeFilter } from '@/lib/server/memory/memory-db'
import { getMemoryTier, shouldHideFromDurableRecall } from '@/lib/server/memory/memory-tiers'
import type { MemoryEntry } from '@/types'

/**
 * Category roots that carry an instruction rather than a fact.
 *
 * `identity` is who the owner is and how they want to be dealt with,
 * `preference` is what they want done, `protocol` is how the agent must work
 * (delegation, memory hygiene). Everything else is content, and content
 * recalled into a prompt stays framed as content.
 */
export const STANDING_RULE_ROOTS = ['identity', 'preference', 'protocol'] as const

/**
 * Total characters of rule content one agent may carry. The live set was 3947
 * characters when this was written; Hermes allows 1375 + 2200. The block is
 * sent once per CLI transcript, so this is paid once, not per turn.
 */
export const STANDING_RULES_CHAR_BUDGET = 5000

/** The most rows the block will consider; far above any sane rule count. */
const MAX_RULE_ROWS = 200

/**
 * `identity/*` also files facts about other people. Those are looked up by
 * sender, can number in the hundreds, and are not instructions, so they stay
 * out of the rules block and out of its budget.
 */
const IDENTITY_FACT_CATEGORIES = new Set([
  'identity/contacts',
  'identity/relationships',
  'identity/events',
  'identity/routines',
  'identity/goals',
])

export function isStandingRuleCategory(category: unknown): boolean {
  const normalized = typeof category === 'string' ? category.trim().toLowerCase() : ''
  if (IDENTITY_FACT_CATEGORIES.has(normalized)) return false
  for (const fact of IDENTITY_FACT_CATEGORIES) {
    if (normalized.startsWith(`${fact}/`)) return false
  }
  return STANDING_RULE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

/**
 * Two memories are the same fact when their content is. The live store holds
 * facts in triplicate — one copy per agent, written before sharing worked —
 * and with sharing on, all copies reach the same reader.
 */
export function memoryFactKey(entry: MemoryEntry): string {
  // An ingested document is stored as many chunks of one source; they are one
  // fact for recall purposes.
  const meta = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata as Record<string, unknown> : null
  const sourceId = typeof meta?.sourceId === 'string' ? meta.sourceId.trim() : ''
  if (sourceId) return `s:${sourceId}`
  const hash = typeof entry.contentHash === 'string' ? entry.contentHash.trim() : ''
  if (hash) return `h:${hash}`
  return `c:${String(entry.content || entry.title || '').replace(/\s+/g, ' ').trim().toLowerCase()}`
}

function rootRank(category: unknown): number {
  const normalized = typeof category === 'string' ? category.trim().toLowerCase() : ''
  const index = STANDING_RULE_ROOTS.findIndex((root) => normalized === root || normalized.startsWith(`${root}/`))
  return index === -1 ? STANDING_RULE_ROOTS.length : index
}

/**
 * The rules an agent must follow, oldest first within each root so the order
 * is stable across turns and a new rule lands at the end of its group.
 */
export function listStandingRules(agentId: string, scope?: MemoryScopeFilter): MemoryEntry[] {
  const rows = getMemoryDb().listByCategoryRoots([...STANDING_RULE_ROOTS], agentId || undefined, MAX_RULE_ROWS)
  const visible = scope ? filterMemoriesByScope(rows, scope) : rows
  const seen = new Set<string>()
  const rules: MemoryEntry[] = []
  for (const entry of visible) {
    if (!entry?.id) continue
    if (!isStandingRuleCategory(entry.category)) continue
    if (shouldHideFromDurableRecall(entry)) continue
    if (getMemoryTier(entry) !== 'durable') continue
    const key = memoryFactKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    rules.push(entry)
  }
  return rules.sort((a, b) => (rootRank(a.category) - rootRank(b.category))
    || ((a.createdAt || 0) - (b.createdAt || 0))
    || a.id.localeCompare(b.id))
}

/** What a rule costs against the budget: its content, as rendered. */
export function standingRuleChars(entry: Pick<MemoryEntry, 'content' | 'title'>): number {
  return String(entry.content || entry.title || '').replace(/\s+/g, ' ').trim().length
}

export function standingRulesTotalChars(entries: Array<Pick<MemoryEntry, 'content' | 'title'>>): number {
  return entries.reduce((sum, entry) => sum + standingRuleChars(entry), 0)
}

function renderRuleLine(entry: MemoryEntry): string {
  const category = String(entry.category || 'rule').replace(/\s+/g, ' ').trim()
  const title = String(entry.title || 'Untitled').replace(/\s+/g, ' ').trim()
  let body = String(entry.content || '').replace(/\s+/g, ' ').trim()
  // Many notes open with their own title; do not print it twice.
  if (title && body.toLowerCase().startsWith(title.toLowerCase())) {
    body = body.slice(title.length).replace(/^[\s:.—-]+/, '')
  }
  const pin = entry.pinned ? ' [pinned]' : ''
  return body ? `- [${category}]${pin} ${title}: ${body}` : `- [${category}]${pin} ${title}`
}

export interface StandingRulesBlock {
  /** The rendered section, or null when the agent has no rules. */
  text: string | null
  /** Identifies this exact rule set; a changed rule changes it. */
  key: string
  /** Rules rendered in full. */
  included: MemoryEntry[]
  /** Rules that did not fit the budget; named, never silently dropped. */
  overflow: MemoryEntry[]
}

export function buildStandingRulesBlock(
  rules: MemoryEntry[],
  options: { budget?: number; refreshed?: boolean } = {},
): StandingRulesBlock {
  const budget = options.budget ?? STANDING_RULES_CHAR_BUDGET
  // Content, not just the timestamp: two edits inside one millisecond share an
  // updatedAt, and the second would otherwise never be re-sent.
  const fingerprint = rules.map((entry) => `${entry.id}:${entry.category}:${entry.title}:${entry.content}`).join('\u0000')
  const key = `rules:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`
  if (!rules.length) return { text: null, key, included: [], overflow: [] }

  const included: MemoryEntry[] = []
  const overflow: MemoryEntry[] = []
  let used = 0
  for (const entry of rules) {
    const cost = standingRuleChars(entry)
    if (used + cost <= budget) {
      included.push(entry)
      used += cost
    } else {
      overflow.push(entry)
    }
  }

  const lines = [
    '## Standing rules the owner gave me',
    options.refreshed
      ? 'These are instructions, and they still apply. This list replaces any earlier copy in this conversation.'
      : 'These are instructions, and they still apply.',
    ...included.map(renderRuleLine),
  ]
  if (overflow.length) {
    // Over budget is an error state the owner must fix, not a reason to hide
    // a rule: name every rule that did not fit so the agent can fetch it.
    lines.push(`More rules did not fit (${used}/${budget} characters used). Read each before acting on anything it may cover, and consolidate the rules with the \`memory\` tool:`)
    for (const entry of overflow) {
      lines.push(`- [${entry.category}] ${String(entry.title || 'Untitled').replace(/\s+/g, ' ').trim()} (memory_get id ${entry.id})`)
    }
  }
  return { text: lines.join('\n'), key, included, overflow }
}

/**
 * Whether writing `next` (replacing `replacingId`, if given) keeps the agent's
 * rule set within budget. Returns null when it fits, or the refusal the memory
 * tool should hand back.
 */
export function checkStandingRulesBudget(input: {
  agentId: string | null
  next: Pick<MemoryEntry, 'category' | 'content' | 'title'>
  replacingId?: string | null
  budget?: number
}): string | null {
  if (!isStandingRuleCategory(input.next.category)) return null
  const budget = input.budget ?? STANDING_RULES_CHAR_BUDGET
  const existing = input.agentId
    ? listStandingRules(input.agentId)
    // No writer agent: only global rules reach every reader, so only they count.
    : listStandingRules('', { mode: 'global' })
  const others = existing.filter((entry) => entry.id !== input.replacingId)
  const nextKey = String(input.next.content || '').replace(/\s+/g, ' ').trim().toLowerCase()
  // A copy of a rule already present costs nothing extra.
  if (others.some((entry) => String(entry.content || '').replace(/\s+/g, ' ').trim().toLowerCase() === nextKey)) return null
  const used = standingRulesTotalChars(others)
  const cost = standingRuleChars(input.next)
  if (used + cost <= budget) return null

  const listing = others.map((entry) => `- ${entry.id} [${entry.category}] ${String(entry.title || '').replace(/\s+/g, ' ').trim()} (${standingRuleChars(entry)} chars)`)
  return [
    `Error: standing rules are full (${used}/${budget} characters used; this rule needs ${cost}).`,
    'Rules (identity/*, preference/*, protocol/*) are sent to the agent in full on every new conversation, so their total is capped.',
    'Make room in this same turn: merge overlapping rules with `memory_update`, shorten long ones, or delete obsolete ones — then write this rule again.',
    'Current rules:',
    ...listing,
  ].join('\n')
}
