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
  /** Set when the reconcile was asked for one extension; absent for all of them. */
  extensionId?: string
  createdAgents?: string[]
  updatedAgents?: string[]
  createdSchedules?: string[]
  updatedSchedules?: string[]
  createdProjects?: string[]
  updatedProjects?: string[]
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
  const createdProjects = count(result?.createdProjects)
  const updatedProjects = count(result?.updatedProjects)
  const skipped = Array.isArray(result?.skipped) ? result.skipped : []
  const touched = createdAgents + updatedAgents + createdSchedules + updatedSchedules + createdProjects + updatedProjects

  const parts = [
    `agents ${createdAgents} created, ${updatedAgents} updated`,
    `routines ${createdSchedules} created, ${updatedSchedules} updated`,
    `projects ${createdProjects} created, ${updatedProjects} updated`,
  ]
  if (skipped.length > 0) {
    parts.push(`${plural(skipped.length, 'declaration', 'declarations')} skipped (${skipReasons(skipped).join(', ')})`)
  }

  if (touched === 0 && skipped.length === 0) {
    // The subject of the sentence follows what was asked for. A run over every
    // extension that reports "this extension declared no agents or routines"
    // names an extension the operator never picked.
    return {
      ok: false,
      text: result?.extensionId
        ? 'Reconcile created and updated nothing: this extension declared no agents or routines the host could act on.'
        : 'Reconcile created and updated nothing: no installed extension declared agents or routines the host could act on.',
    }
  }
  return { ok: skipped.length === 0, text: `Reconcile: ${parts.join('; ')}.` }
}

/**
 * The outcome the host attaches to an install, an enable or an upgrade.
 *
 * Mirrors `ExtensionLifecycleReconcileOutcome` in
 * `src/lib/server/extension-managed-resources.ts`, restated here because this
 * module is imported by client components and must not pull in server code.
 * Every field is optional: it arrives as parsed JSON from a route, so nothing
 * here may assume the shape it hoped for.
 */
export interface ManagedReconcileLifecycleOutcomeShape {
  trigger?: string
  extensionId?: string
  status?: string
  result?: ManagedReconcileResultShape
  error?: string
}

/**
 * One sentence about the reconcile a lifecycle transition ran, or `null` when
 * there is nothing to say.
 *
 * `null` is returned for a missing outcome and for `not_declared`, and those
 * are the same answer: the extension declared no agents and no routines, so no
 * reconcile was attempted and the operator has no reason to be told about one.
 * A caller shows no message on `null` rather than inventing a reassuring one.
 *
 * A status this code does not recognise is reported as unrecognised rather
 * than treated as a success, because the alternative is a silent pass for a
 * shape a future host might send.
 */
export function summarizeLifecycleReconcile(
  outcome: ManagedReconcileLifecycleOutcomeShape | null | undefined,
): ManagedReconcileSummary | null {
  if (!outcome || outcome.status === 'not_declared') return null

  if (outcome.status === 'failed') {
    const reason = typeof outcome.error === 'string' && outcome.error ? outcome.error : 'no reason given'
    return {
      ok: false,
      text: `The extension is installed, but creating the agents and routines it declares failed: ${reason}. Use Reconcile on its card to retry.`,
    }
  }

  if (outcome.status === 'reconciled') {
    return summarizeManagedReconcile(outcome.result)
  }

  return {
    ok: false,
    text: `The host reported an unrecognised reconcile status (${outcome.status ?? 'none'}); whether the declared agents and routines exist is unknown. Use Reconcile on the extension's card to find out.`,
  }
}
