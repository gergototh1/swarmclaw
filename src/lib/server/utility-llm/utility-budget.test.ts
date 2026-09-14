import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  DEFAULT_UTILITY_DAILY_CAP,
  DEFAULT_UTILITY_MAX_CONCURRENT,
  DEFAULT_UTILITY_COOLDOWN_SEC,
  resolveUtilityBudget,
  __resetUtilityBudgetForTests,
  claimUtilityCall,
  releaseUtilityCall,
} from './utility-budget'

/*
 * A segédhívás az előfizetést költi, tehát fékezni kell.
 *
 * A Hermes `retain_every_n_turns: 1`-gyel dolgozik -- MINDEN fordulóban
 * kivonatol --, és az ő jelölt-táblájában 3658 sor van, forgalmas napokon
 * 342-438. Ugyanez fék nélkül egy előfizetésen észrevétlenül nagyot költ.
 *
 * Három fék, mind felülírható a settingsben:
 *   - napi plafon (a fleet egészére),
 *   - egyidejűség (a maradék sorban vár),
 *   - sessiononkénti hűtés (egy beszélgetés ne hívja percenként hússzor).
 *
 * A plafon 0-ra állítva kikapcsolja a segédmunkát -- ez a kikapcsoló.
 */
describe('resolveUtilityBudget', () => {
  it('has a cap, a concurrency limit and a cooldown out of the box', () => {
    const budget = resolveUtilityBudget({})
    assert.equal(budget.dailyCap, DEFAULT_UTILITY_DAILY_CAP)
    assert.equal(budget.maxConcurrent, DEFAULT_UTILITY_MAX_CONCURRENT)
    assert.equal(budget.cooldownSec, DEFAULT_UTILITY_COOLDOWN_SEC)
  })

  it('lets the operator raise or lower each one', () => {
    const budget = resolveUtilityBudget({
      utilityDailyCap: 40,
      utilityMaxConcurrent: 1,
      utilityPerSessionCooldownSec: 120,
    })
    assert.deepEqual(budget, { dailyCap: 40, maxConcurrent: 1, cooldownSec: 120 })
  })

  it('treats a zero cap as "off" rather than as unset', () => {
    assert.equal(resolveUtilityBudget({ utilityDailyCap: 0 }).dailyCap, 0)
  })

  it('refuses a nonsensical value rather than taking it literally', () => {
    // Egy negatív plafon vagy nulla egyidejűség némán megállítaná a segédmunkát.
    assert.equal(resolveUtilityBudget({ utilityDailyCap: -5 }).dailyCap, DEFAULT_UTILITY_DAILY_CAP)
    assert.equal(resolveUtilityBudget({ utilityMaxConcurrent: 0 }).maxConcurrent, DEFAULT_UTILITY_MAX_CONCURRENT)
    assert.equal(resolveUtilityBudget({ utilityMaxConcurrent: 999 }).maxConcurrent, DEFAULT_UTILITY_MAX_CONCURRENT)
  })
})

describe('claimUtilityCall', () => {
  beforeEach(() => { __resetUtilityBudgetForTests() })

  const budget = { dailyCap: 3, maxConcurrent: 2, cooldownSec: 60 }

  it('allows a call when nothing is in flight', () => {
    assert.equal(claimUtilityCall({ sessionId: 's1', budget, now: 1_000 }).ok, true)
  })

  it('blocks a second call for the same session inside the cooldown', () => {
    claimUtilityCall({ sessionId: 's1', budget, now: 1_000 })
    const second = claimUtilityCall({ sessionId: 's1', budget, now: 1_000 + 30_000 })
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.reason, 'cooldown')
  })

  it('allows the same session again once the cooldown has passed', () => {
    claimUtilityCall({ sessionId: 's1', budget, now: 1_000 })
    releaseUtilityCall()
    assert.equal(claimUtilityCall({ sessionId: 's1', budget, now: 1_000 + 61_000 }).ok, true)
  })

  it('does not hold one session\'s cooldown against another', () => {
    claimUtilityCall({ sessionId: 's1', budget, now: 1_000 })
    assert.equal(claimUtilityCall({ sessionId: 's2', budget, now: 1_000 }).ok, true)
  })

  it('blocks once too many calls are already running', () => {
    claimUtilityCall({ sessionId: 's1', budget, now: 1_000 })
    claimUtilityCall({ sessionId: 's2', budget, now: 1_000 })
    const third = claimUtilityCall({ sessionId: 's3', budget, now: 1_000 })
    assert.equal(third.ok, false)
    assert.equal(third.ok === false && third.reason, 'busy')
  })

  it('frees a slot when a call finishes', () => {
    claimUtilityCall({ sessionId: 's1', budget, now: 1_000 })
    claimUtilityCall({ sessionId: 's2', budget, now: 1_000 })
    releaseUtilityCall()
    assert.equal(claimUtilityCall({ sessionId: 's3', budget, now: 1_000 }).ok, true)
  })

  it('stops at the daily cap', () => {
    for (let i = 0; i < 3; i++) {
      assert.equal(claimUtilityCall({ sessionId: `s${i}`, budget, now: 1_000 }).ok, true, `call ${i}`)
      releaseUtilityCall()
    }
    const over = claimUtilityCall({ sessionId: 's9', budget, now: 1_000 })
    assert.equal(over.ok, false)
    assert.equal(over.ok === false && over.reason, 'daily_cap')
  })

  it('starts a new day with a fresh cap', () => {
    for (let i = 0; i < 3; i++) { claimUtilityCall({ sessionId: `s${i}`, budget, now: 1_000 }); releaseUtilityCall() }
    const nextDay = 1_000 + 25 * 3600_000
    assert.equal(claimUtilityCall({ sessionId: 's9', budget, now: nextDay }).ok, true)
  })

  it('refuses everything when the cap is zero, which is the off switch', () => {
    const off = claimUtilityCall({ sessionId: 's1', budget: { ...budget, dailyCap: 0 }, now: 1_000 })
    assert.equal(off.ok, false)
    assert.equal(off.ok === false && off.reason, 'disabled')
  })

  it('applies no cooldown to a call with no session', () => {
    // A napi konszolidáció nem egy beszélgetéshez tartozik; a hűtés
    // sessiononkénti, tehát rá nem vonatkozik.
    claimUtilityCall({ sessionId: null, budget, now: 1_000 })
    releaseUtilityCall()
    assert.equal(claimUtilityCall({ sessionId: null, budget, now: 1_100 }).ok, true)
  })
})
