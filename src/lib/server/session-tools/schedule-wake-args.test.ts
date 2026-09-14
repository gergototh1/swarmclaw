import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeWakeRequest } from './schedule'

/*
 * A "szólok ha kész" ígéret ezen bukott el.
 *
 * A `schedule_wake` MCP-n paraméter nélküli sémával ment ki, tehát az agent
 * kitalálta az argumentumneveket -- és elvétette. A régi őr
 * (`delayMinutes < 0 || delayMinutes > 43_200`) `undefined`-ra MINDKÉT ágon
 * hamis, így az `undefined` átcsúszott, `runAt` `NaN` lett, és a `watch_jobs`
 * táblába egy soha nem tüzelő sor került: 1df02819902d384c2365, leírása
 * "Scheduled wake in undefined minutes", `runAt: null`, két nap után is
 * `active`, `lastTriggeredAt: null`.
 *
 * Nem hibaüzenet volt, amiből az agent tanulhatott volna, hanem csendes halál.
 * Azóta egyszer sem próbálkozott újra.
 */
describe('normalizeWakeRequest', () => {
  it('refuses a missing delayMinutes instead of persisting undefined', () => {
    const result = normalizeWakeRequest({ message: 'kész a merge' })
    assert.ok('error' in result, 'a wake with no delay must not be accepted')
    assert.match(result.error, /delayMinutes/)
  })

  it('refuses a non-finite delayMinutes', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'soon', null]) {
      const result = normalizeWakeRequest({ delayMinutes: bad, message: 'x' })
      assert.ok('error' in result, `delayMinutes=${String(bad)} must be rejected`)
    }
  })

  it('refuses a missing message, because a wake with nothing to say is a no-op', () => {
    const result = normalizeWakeRequest({ delayMinutes: 5 })
    assert.ok('error' in result)
    assert.match(result.error, /message/)
  })

  it('names the argument and its unit so the agent can correct itself', () => {
    // Anthropic tool guidance: an error should "clearly communicate specific
    // and actionable improvements". "delayMinutes must be..." is actionable;
    // silently writing a dead row is not.
    const result = normalizeWakeRequest({})
    assert.ok('error' in result)
    assert.match(result.error, /minutes/i)
  })

  it('keeps the range guard', () => {
    assert.ok('error' in normalizeWakeRequest({ delayMinutes: -1, message: 'x' }))
    assert.ok('error' in normalizeWakeRequest({ delayMinutes: 43_201, message: 'x' }))
  })

  it('accepts a valid request', () => {
    const result = normalizeWakeRequest({ delayMinutes: 30, message: 'nézd meg a mergét' })
    assert.deepEqual(result, { delayMinutes: 30, message: 'nézd meg a mergét' })
  })

  it('accepts zero, which is the immediate-wake path', () => {
    const result = normalizeWakeRequest({ delayMinutes: 0, message: 'most' })
    assert.deepEqual(result, { delayMinutes: 0, message: 'most' })
  })

  it('accepts a numeric string, which is what a CLI agent often sends', () => {
    const result = normalizeWakeRequest({ delayMinutes: '15', message: 'x' })
    assert.deepEqual(result, { delayMinutes: 15, message: 'x' })
  })
})
