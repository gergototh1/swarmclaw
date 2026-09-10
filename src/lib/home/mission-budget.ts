import type { Mission } from '@/types'

export interface TightestCap {
  label: string
  /** Clamped to [0, 1] so a bar drawn from it cannot overflow. */
  fraction: number
  tone: 'normal' | 'warn' | 'danger'
}

interface Candidate {
  used: number
  max: number
  label: string
}

function tone(fraction: number): TightestCap['tone'] {
  if (fraction >= 0.95) return 'danger'
  if (fraction >= 0.8) return 'warn'
  return 'normal'
}

/**
 * A mission can carry five caps at once. Showing five bars is noise; the one
 * worth drawing is whichever is closest to being hit, because that is the one
 * that will actually stop the mission.
 */
export function tightestCap(mission: Pick<Mission, 'budget' | 'usage'>): TightestCap | null {
  const { budget, usage } = mission
  const money = (value: number) => `$${value.toFixed(2)}`
  const candidates: Candidate[] = [
    { used: usage.usdSpent, max: budget.maxUsd ?? 0, label: `${money(usage.usdSpent)} / ${money(budget.maxUsd ?? 0)}` },
    { used: usage.tokensUsed, max: budget.maxTokens ?? 0, label: `${usage.tokensUsed.toLocaleString()} / ${(budget.maxTokens ?? 0).toLocaleString()} tokens` },
    { used: usage.toolCallsUsed, max: budget.maxToolCalls ?? 0, label: `${usage.toolCallsUsed} / ${budget.maxToolCalls ?? 0} tool calls` },
    { used: usage.turnsRun, max: budget.maxTurns ?? 0, label: `${usage.turnsRun} / ${budget.maxTurns ?? 0} turns` },
    {
      used: Math.round(usage.wallclockMsElapsed / 60_000),
      max: Math.round((budget.maxWallclockSec ?? 0) / 60),
      label: `${Math.round(usage.wallclockMsElapsed / 60_000)} / ${Math.round((budget.maxWallclockSec ?? 0) / 60)} min`,
    },
  ]

  let best: { candidate: Candidate; fraction: number } | null = null
  for (const candidate of candidates) {
    if (!(candidate.max > 0)) continue
    const fraction = Math.min(1, candidate.used / candidate.max)
    if (!best || fraction > best.fraction) best = { candidate, fraction }
  }
  if (!best) return null
  return { label: best.candidate.label, fraction: best.fraction, tone: tone(best.fraction) }
}
