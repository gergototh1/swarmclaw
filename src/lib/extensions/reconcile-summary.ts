/**
 * What a reconcile actually did, in one sentence, for whichever surface asks.
 *
 * WHY THIS IS SHARED CODE AND NOT A TEMPLATE STRING AT THE CALL SITE. A
 * reconcile has four ways of doing nothing and one of them is a failure. It can
 * create resources; it can find them all already correct and update them; it
 * can refuse a declaration and skip it (a schedule naming an agent that is not
 * declared, a cron the timing parser will not take); and it can be given an
 * extension that declares nothing at all. The first two are success, the last
 * two are not, and a message built from `created.length + updated.length` alone
 * reports every one of them as "Reconciled 0 agents and 0 schedules" -- which
 * an operator reads as success, goes to the routines list, finds empty, and has
 * no way to tell whether the button worked. That is the exact shape of the
 * defect this module exists to make impossible: a run that did nothing and a
 * run that worked must not look the same.
 *
 * `ok` is therefore false whenever a declaration was skipped, and false when
 * nothing was created and nothing updated. The caller shows a failure toast on
 * a false, so a skipped declaration is never dressed as a success.
 */

export interface ManagedReconcileSkip {
  resourceKind: string
  resourceKey: string
  reason: string
}

export interface ManagedReconcileResultShape {
  createdAgents?: string[]
  updatedAgents?: string[]
  createdSchedules?: string[]
  updatedSchedules?: string[]
  skipped?: ManagedReconcileSkip[]
}

export interface ManagedReconcileSummary {
  /** True only when something was created or updated and nothing was skipped. */
  ok: boolean
  /** One sentence naming every number, including the zeroes. */
  text: string
}

function count(list: string[] | undefined): number {
  return Array.isArray(list) ? list.length : 0
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The distinct reasons behind the skipped declarations, in first-seen order.
 *
 * Reasons are the server's own vocabulary (`missing_agent_ref`,
 * `invalid_schedule_declaration`, a timing parser's word), not free text from
 * an extension: the reconcile picks them from a fixed set. They are rendered as
 * text by the caller, never parsed by it.
 */
function skipReasons(skipped: ManagedReconcileSkip[]): string[] {
  const seen: string[] = []
  for (const entry of skipped) {
    const reason = typeof entry?.reason === 'string' && entry.reason ? entry.reason : 'unknown'
    if (!seen.includes(reason)) seen.push(reason)
  }
  return seen
}

export function summarizeManagedReconcile(result: ManagedReconcileResultShape | null | undefined): ManagedReconcileSummary {
  const createdAgents = count(result?.createdAgents)
  const updatedAgents = count(result?.updatedAgents)
  const createdSchedules = count(result?.createdSchedules)
  const updatedSchedules = count(result?.updatedSchedules)
  const skipped = Array.isArray(result?.skipped) ? result.skipped : []
  const touched = createdAgents + updatedAgents + createdSchedules + updatedSchedules

  const parts = [
    `agents ${createdAgents} created, ${updatedAgents} updated`,
    `routines ${createdSchedules} created, ${updatedSchedules} updated`,
  ]
  if (skipped.length > 0) {
    parts.push(`${plural(skipped.length, 'declaration', 'declarations')} skipped (${skipReasons(skipped).join(', ')})`)
  }

  if (touched === 0 && skipped.length === 0) {
    return { ok: false, text: 'Reconcile created and updated nothing: this extension declared no agents or routines the host could act on.' }
  }
  return { ok: skipped.length === 0, text: `Reconcile: ${parts.join('; ')}.` }
}
