import type { OperationPulseAction, OperationPulseActionKind } from '@/types'

/**
 * The operations pulse already ranks approvals, budgets and missions, which is
 * exactly where it collides with the home page's "Needs you" block. Rather
 * than let both render the same row, the kinds are partitioned: each one
 * belongs to exactly one surface, and the test asserts the split is total and
 * disjoint. A new kind added to `OperationPulseActionKind` fails that test
 * until somebody decides where it goes.
 */
export const ALL_PULSE_KINDS: readonly OperationPulseActionKind[] = [
  'mission', 'run', 'approval', 'connector', 'gateway', 'budget', 'quality',
]

/** Decisions waiting on a person — Tier 1. */
export const NEEDS_YOU_PULSE_KINDS: readonly OperationPulseActionKind[] = ['mission', 'budget']

/** Infrastructure health — Tier 3, behind the collapse. */
export const OPERATIONS_PULSE_KINDS: readonly OperationPulseActionKind[] = ['connector', 'gateway', 'run', 'quality']

/** Shown from `useApprovalStore` instead, which is live rather than polled. */
export const HOME_SUPPRESSED_PULSE_KINDS: readonly OperationPulseActionKind[] = ['approval']

export function filterPulseActions(
  actions: readonly OperationPulseAction[],
  kinds: readonly OperationPulseActionKind[] | undefined,
): OperationPulseAction[] {
  if (!kinds) return [...actions]
  const allowed = new Set(kinds)
  return actions.filter((action) => allowed.has(action.kind))
}
