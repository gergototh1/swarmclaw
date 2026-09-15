/**
 * One delegation tool per teammate.
 *
 * WHY. `spawn_subagent` is a single generic tool whose `agentId` is a bare
 * string with no enum and no roster. The named list was appended to its
 * description only under `delegationTargetMode === 'selected'`, so an agent set
 * to `'all'` — the default — was told "Delegate tasks to other agents" and
 * nothing more. It could not know that `777e99a7` is called "Fejlesztő" or that
 * it writes code, and Anthropic's own tool guidance says the opposite: resolve
 * "arbitrary alphanumeric UUIDs to more semantically meaningful and
 * interpretable language".
 *
 * Meanwhile Claude Code's own `Agent` tool arrives with a fully named and
 * described agent list. Given two menus the model used the legible one: across
 * a two-day, 31-turn build, session `70dd3e11` produced zero `delegation_jobs`
 * rows while calling the built-in `Agent` tool throughout.
 *
 * The shape here is the one both reference implementations converged on — the
 * OpenAI Agents SDK renders each handoff as its own `transfer_to_<agent_name>`
 * tool carrying the target's own description, and LangGraph Swarm's
 * `create_handoff_tool` does the same. This is that, with a `delegate_to_`
 * prefix.
 *
 * `spawn_subagent` stays: batch, swarm, status and wait have no per-agent form.
 */

/** Small enough that the tool table stays readable, large enough for a real fleet. */
export const MAX_DELEGATION_TOOLS = 12

export interface DelegationTargetAgent {
  id: string
  name?: string | null
  description?: string | null
  soul?: string | null
  trashedAt?: number | null
}

export interface DelegationTargetContext {
  agentId?: string | null
  delegationEnabled?: boolean
  delegationTargetMode?: 'all' | 'selected'
  delegationTargetAgentIds?: string[] | null
}

export interface DelegationTarget {
  id: string
  name: string
  description: string
  toolName: string
}

/** Latin letters with diacritics, folded rather than dropped, so "Kutató" stays "kutato". */
function foldToAscii(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/**
 * The tool name for one teammate.
 *
 * Kept pure and exported so the naming rule is pinned by a test: a name that
 * folds away to nothing must still produce a callable tool, and two agents
 * sharing a display name must not collapse onto one entry.
 */
export function delegateToolName(agentName: string, agentId?: string): string {
  const slug = foldToAscii(String(agentName || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  const idSuffix = String(agentId || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8)
  if (!slug) return `delegate_to_agent_${idSuffix || 'unnamed'}`
  return `delegate_to_${slug}`
}

/** One line describing what this teammate is for, from whatever the record has. */
function summarize(agent: DelegationTargetAgent): string {
  const source = String(agent.description || agent.soul || '').trim()
  if (!source) return 'No description on file.'
  const firstLine = source.split('\n').map((line) => line.trim()).find(Boolean) || source
  return firstLine.length > 300 ? `${firstLine.slice(0, 300).trimEnd()}...` : firstLine
}

/**
 * Which teammates this agent may hand work to, and under what tool name.
 *
 * Reads the same two fields the runtime enforces (`delegationEnabled`, and the
 * `selected` allow-list), so a tool can never appear for a target
 * `validateAllowedSubagentTarget` would then reject.
 */
export function resolveDelegationTargets(
  ctx: DelegationTargetContext,
  agents: Record<string, DelegationTargetAgent>,
): DelegationTarget[] {
  if (!ctx.delegationEnabled) return []

  const selected = ctx.delegationTargetMode === 'selected'
    ? (Array.isArray(ctx.delegationTargetAgentIds) ? ctx.delegationTargetAgentIds : [])
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : null

  const callerId = typeof ctx.agentId === 'string' ? ctx.agentId : ''
  const candidates = Object.values(agents || {})
    .filter((agent) => agent && typeof agent.id === 'string' && agent.id)
    // An agent delegating to itself spends a second subscription to do what it
    // was about to do anyway.
    .filter((agent) => agent.id !== callerId)
    .filter((agent) => !agent.trashedAt)
    .filter((agent) => (selected === null ? true : selected.includes(agent.id)))
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))

  const used = new Set<string>()
  const targets: DelegationTarget[] = []
  for (const agent of candidates) {
    if (targets.length >= MAX_DELEGATION_TOOLS) break
    const name = String(agent.name || agent.id)
    let toolName = delegateToolName(name)
    // Two teammates may share a display name. Falling back to the id keeps both
    // reachable instead of silently dropping the second.
    if (used.has(toolName)) toolName = delegateToolName(name, agent.id).replace(/^delegate_to_/, `delegate_to_${agent.id.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8)}_`)
    if (used.has(toolName)) continue
    used.add(toolName)
    targets.push({ id: agent.id, name, description: summarize(agent), toolName })
  }
  return targets
}

/** True for any name `resolveDelegationTargets` can produce. */
export function isDelegateToolName(name: string): boolean {
  return /^delegate_to_[a-z0-9_]+$/.test(name)
}
