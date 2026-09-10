import type { Mission } from '@/types'
import { DEFAULT_MISSION_WARN_FRACTIONS } from '@/types'

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

interface ToneThresholds {
  warn: number
  danger: number
}

/**
 * Derives the warn/danger thresholds from the mission's own
 * `budget.warnAtFractions` (the same schedule `recordTurnUsage` fires
 * "Budget X% reached" milestones at), falling back to
 * `DEFAULT_MISSION_WARN_FRACTIONS` when the mission hasn't configured one.
 * The highest configured fraction becomes the danger threshold and the
 * next-highest becomes warn. A single-entry schedule has no "next-highest"
 * to draw from, so warn and danger collapse to the same value — the bar
 * jumps straight from normal to danger with no amber band, which is the
 * honest reflection of a mission that only defined one threshold.
 */
function toneThresholds(budget: Pick<Mission['budget'], 'warnAtFractions'>): ToneThresholds {
  const configured = budget.warnAtFractions
  const sorted = [...(configured && configured.length > 0 ? configured : DEFAULT_MISSION_WARN_FRACTIONS)].sort(
    (a, b) => a - b,
  )
  const danger = sorted[sorted.length - 1]
  const warn = sorted.length > 1 ? sorted[sorted.length - 2] : danger
  return { warn, danger }
}

function tone(fraction: number, thresholds: ToneThresholds): TightestCap['tone'] {
  if (fraction >= thresholds.danger) return 'danger'
  if (fraction >= thresholds.warn) return 'warn'
  return 'normal'
}

/** A sub-minute wallclock cap reads in seconds so it doesn't round to "0 / 1 min". */
function wallclockLabel(usedSec: number, maxSec: number): string {
  if (maxSec > 0 && maxSec < 60) {
    return `${Math.round(usedSec)} / ${Math.round(maxSec)} sec`
  }
  return `${Math.round(usedSec / 60)} / ${Math.round(maxSec / 60)} min`
}

/**
 * A mission can carry five caps at once. Showing five bars is noise; the one
 * worth drawing is whichever is closest to being hit, because that is the one
 * that will actually stop the mission. Candidates with a non-positive/missing
 * max, or a non-finite fraction (e.g. a NaN usage value), are skipped so they
 * can't silently mask a tighter, legitimate cap. The tone thresholds come from
 * the mission's own `budget.warnAtFractions` (falling back to
 * `DEFAULT_MISSION_WARN_FRACTIONS`) so the bar agrees with the milestone log.
 */
export function tightestCap(mission: Pick<Mission, 'budget' | 'usage'>): TightestCap | null {
  const { budget, usage } = mission
  const money = (value: number) => `$${value.toFixed(2)}`
  const wallclockUsedSec = usage.wallclockMsElapsed / 1000
  const wallclockMaxSec = budget.maxWallclockSec ?? 0
  const candidates: Candidate[] = [
    { used: usage.usdSpent, max: budget.maxUsd ?? 0, label: `${money(usage.usdSpent)} / ${money(budget.maxUsd ?? 0)}` },
    { used: usage.tokensUsed, max: budget.maxTokens ?? 0, label: `${usage.tokensUsed.toLocaleString()} / ${(budget.maxTokens ?? 0).toLocaleString()} tokens` },
    { used: usage.toolCallsUsed, max: budget.maxToolCalls ?? 0, label: `${usage.toolCallsUsed} / ${budget.maxToolCalls ?? 0} tool calls` },
    { used: usage.turnsRun, max: budget.maxTurns ?? 0, label: `${usage.turnsRun} / ${budget.maxTurns ?? 0} turns` },
    {
      used: wallclockUsedSec,
      max: wallclockMaxSec,
      label: wallclockLabel(wallclockUsedSec, wallclockMaxSec),
    },
  ]

  let best: { candidate: Candidate; fraction: number } | null = null
  for (const candidate of candidates) {
    if (!(candidate.max > 0)) continue
    const fraction = Math.min(1, candidate.used / candidate.max)
    if (!Number.isFinite(fraction)) continue
    if (!best || fraction > best.fraction) best = { candidate, fraction }
  }
  if (!best) return null
  return { label: best.candidate.label, fraction: best.fraction, tone: tone(best.fraction, toneThresholds(budget)) }
}
