import type { OperationPulseAction, OperationPulseActionKind } from '@/types'

/**
 * The operations pulse already ranks approvals, budgets and missions, which is
 * exactly where it collides with the home page's "Needs you" block. Rather
 * than let both render the same row, each kind is assigned to exactly one
 * tier below. `PULSE_KIND_TIER` is a `Record` keyed by the full
 * `OperationPulseActionKind` union, so adding a member to that union without
 * assigning it a tier here is a compile error, not just a failing test — the
 * exported lists are derived from this record, so disjointness is structural
 * (a key cannot sit in two tiers) rather than merely asserted. The colocated
 * test still pins each kind to its specific tier, so a kind quietly sliding
 * between tiers (e.g. `budget` moving out of "needs you") still fails a test.
 */
type PulseTier = 'needs-you' | 'operations' | 'home-suppressed'

const PULSE_KIND_TIER: Record<OperationPulseActionKind, PulseTier> = {
  mission: 'needs-you',
  budget: 'needs-you',
  connector: 'operations',
  gateway: 'operations',
  run: 'operations',
  quality: 'operations',
  approval: 'home-suppressed',
}

const kindsInTier = (tier: PulseTier): readonly OperationPulseActionKind[] =>
  (Object.keys(PULSE_KIND_TIER) as OperationPulseActionKind[]).filter((kind) => PULSE_KIND_TIER[kind] === tier)

export const ALL_PULSE_KINDS: readonly OperationPulseActionKind[] =
  Object.keys(PULSE_KIND_TIER) as OperationPulseActionKind[]

/** Decisions waiting on a person — Tier 1. */
export const NEEDS_YOU_PULSE_KINDS: readonly OperationPulseActionKind[] = kindsInTier('needs-you')

/** Infrastructure health — Tier 3, behind the collapse. */
export const OPERATIONS_PULSE_KINDS: readonly OperationPulseActionKind[] = kindsInTier('operations')

/**
 * Shown from `useApprovalStore` instead of the pulse -- not because that store
 * is live, but because home already calls `loadApprovals()` once on mount to
 * populate it. In truth the store is the less fresh of the two: `addApproval`
 * and `removeApproval` are never called anywhere in the codebase, so the list
 * is a one-shot snapshot that never updates again for the rest of the visit,
 * while the pulse itself is at least re-fetched each time this page mounts.
 * An approval that arrives while the user is already sitting on home will not
 * appear until they navigate away and back.
 */
export const HOME_SUPPRESSED_PULSE_KINDS: readonly OperationPulseActionKind[] = kindsInTier('home-suppressed')

export function filterPulseActions(
  actions: readonly OperationPulseAction[],
  kinds: readonly OperationPulseActionKind[] | undefined,
): OperationPulseAction[] {
  if (!kinds) return [...actions]
  const allowed = new Set(kinds)
  return actions.filter((action) => allowed.has(action.kind))
}
