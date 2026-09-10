import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MissionBudget, MissionUsage } from '@/types'
import { tightestCap } from './mission-budget'

const usage = (over: Partial<MissionUsage> = {}): MissionUsage => ({
  usdSpent: 0, tokensUsed: 0, toolCallsUsed: 0, turnsRun: 0, wallclockMsElapsed: 0,
  startedAt: null, lastUpdatedAt: 0, warnFractionsHit: [], ...over,
})

const budget = (over: MissionBudget = {}): MissionBudget => ({ ...over })

describe('tightestCap', () => {
  it('returns null when the mission has no caps', () => {
    assert.equal(tightestCap({ budget: budget(), usage: usage() }), null)
  })

  it('picks the cap closest to being hit, not the first one', () => {
    const cap = tightestCap({
      budget: budget({ maxUsd: 10, maxTurns: 50 }),
      usage: usage({ usdSpent: 1, turnsRun: 45 }),
    })
    assert.equal(cap?.label, '45 / 50 turns')
    assert.equal(cap?.fraction, 0.9)
  })

  it('formats a dollar cap with two decimals', () => {
    const cap = tightestCap({ budget: budget({ maxUsd: 5 }), usage: usage({ usdSpent: 3.1 }) })
    assert.equal(cap?.label, '$3.10 / $5.00')
  })

  it('warns at 0.8 and turns dangerous at 0.95', () => {
    assert.equal(tightestCap({ budget: budget({ maxUsd: 10 }), usage: usage({ usdSpent: 5 }) })?.tone, 'normal')
    assert.equal(tightestCap({ budget: budget({ maxUsd: 10 }), usage: usage({ usdSpent: 8 }) })?.tone, 'warn')
    assert.equal(tightestCap({ budget: budget({ maxUsd: 10 }), usage: usage({ usdSpent: 9.5 }) })?.tone, 'danger')
  })

  it('clamps an overrun to 1 so the bar cannot overflow', () => {
    const cap = tightestCap({ budget: budget({ maxUsd: 1 }), usage: usage({ usdSpent: 4 }) })
    assert.equal(cap?.fraction, 1)
  })

  it('ignores a null or non-positive cap', () => {
    const cap = tightestCap({
      budget: budget({ maxUsd: null, maxTokens: 0, maxTurns: 10 }),
      usage: usage({ turnsRun: 2 }),
    })
    assert.equal(cap?.label, '2 / 10 turns')
  })

  it('reads wallclock in minutes', () => {
    const cap = tightestCap({
      budget: budget({ maxWallclockSec: 600 }),
      usage: usage({ wallclockMsElapsed: 300_000 }),
    })
    assert.equal(cap?.label, '5 / 10 min')
  })

  it('does not lose a sub-minute wallclock cap to rounding-to-zero', () => {
    const cap = tightestCap({
      budget: budget({ maxWallclockSec: 20 }),
      usage: usage({ wallclockMsElapsed: 10_000 }),
    })
    assert.equal(cap?.label, '10 / 20 sec')
    assert.equal(cap?.fraction, 0.5)
  })

  it('computes a sub-minute wallclock fraction from raw seconds, not rounded minutes', () => {
    const cap = tightestCap({
      budget: budget({ maxWallclockSec: 40 }),
      usage: usage({ wallclockMsElapsed: 20_000 }),
    })
    assert.equal(cap?.label, '20 / 40 sec')
    assert.equal(cap?.fraction, 0.5)
  })

  it('skips a NaN usage value instead of letting it mask a tighter cap', () => {
    const cap = tightestCap({
      budget: budget({ maxUsd: 10, maxTurns: 10 }),
      usage: usage({ usdSpent: Number.NaN, turnsRun: 9 }),
    })
    assert.equal(cap?.label, '9 / 10 turns')
    assert.equal(cap?.fraction, 0.9)
    assert.equal(cap?.tone, 'warn')
  })

  it('uses the mission\'s own warnAtFractions schedule instead of the hardcoded thresholds', () => {
    const cap = tightestCap({
      budget: budget({ maxUsd: 10, warnAtFractions: [0.3, 0.6, 0.9] }),
      usage: usage({ usdSpent: 6.5 }),
    })
    // 0.65 fraction: hardcoded thresholds (0.8/0.95) would say 'normal',
    // this mission's own schedule (warn 0.6, danger 0.9) says 'warn'.
    assert.equal(cap?.fraction, 0.65)
    assert.equal(cap?.tone, 'warn')

    const dangerCap = tightestCap({
      budget: budget({ maxUsd: 10, warnAtFractions: [0.3, 0.6, 0.9] }),
      usage: usage({ usdSpent: 9 }),
    })
    assert.equal(dangerCap?.tone, 'danger')
  })

  it('falls back to defaults for an empty warnAtFractions array', () => {
    const cap = tightestCap({
      budget: budget({ maxUsd: 10, warnAtFractions: [] }),
      usage: usage({ usdSpent: 8.5 }),
    })
    assert.equal(cap?.tone, 'warn')
  })

  it('collapses warn and danger to the same threshold for a single-entry warnAtFractions array', () => {
    const belowCap = tightestCap({
      budget: budget({ maxUsd: 10, warnAtFractions: [0.9] }),
      usage: usage({ usdSpent: 8.9 }),
    })
    assert.equal(belowCap?.tone, 'normal')

    const atCap = tightestCap({
      budget: budget({ maxUsd: 10, warnAtFractions: [0.9] }),
      usage: usage({ usdSpent: 9 }),
    })
    assert.equal(atCap?.tone, 'danger')
  })
})
