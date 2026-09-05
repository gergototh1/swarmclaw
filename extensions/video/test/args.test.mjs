import assert from 'node:assert/strict'
import { test } from 'node:test'

import { VideoError, agentIdOf, guard, readArray, readBoolean, readEnum, readString, readWholeNumber, refuse, sessionIdOf } from '../src/args.mjs'

/** Asserts that `fn` refuses with a VideoError carrying `code`, and returns the error. */
function refused(fn, code = 'argumentum_hibas') {
  let caught = null
  try { fn() } catch (err) { caught = err }
  assert.ok(caught instanceof VideoError, 'expected a VideoError')
  assert.equal(caught.code, code)
  return caught
}

test('readWholeNumber refuses a negative value by name', () => {
  const err = refused(() => readWholeNumber('limit', -1, { min: 1, max: 100, fallback: 10 }))
  assert.match(err.message, /^limit:/)
})

test('readWholeNumber refuses above max instead of capping', () => {
  refused(() => readWholeNumber('x', 999, { min: 1, max: 100, fallback: 10 }))
})

test('readWholeNumber returns the fallback for an absent or blank value', () => {
  assert.equal(readWholeNumber('x', undefined, { fallback: 26 }), 26)
  assert.equal(readWholeNumber('x', null, { min: 1, max: 100, fallback: 26 }), 26)
  assert.equal(readWholeNumber('x', '', { min: 1, max: 100, fallback: 26 }), 26)
  assert.equal(readWholeNumber('x', '   ', { min: 1, max: 100, fallback: 26 }), 26)
})

test('readWholeNumber reads a numeric string and refuses a boolean, an array, a fraction and an unsafe integer', () => {
  assert.equal(readWholeNumber('x', '42', { min: 1, max: 100, fallback: 1 }), 42)
  assert.equal(readWholeNumber('x', 7, { min: 1, max: 100, fallback: 1 }), 7)
  refused(() => readWholeNumber('x', true, { min: 0, max: 100, fallback: 1 }))
  refused(() => readWholeNumber('x', [5], { min: 0, max: 100, fallback: 1 }))
  refused(() => readWholeNumber('x', 1.5, { min: 0, max: 100, fallback: 1 }))
  refused(() => readWholeNumber('x', 'abc', { min: 0, max: 100, fallback: 1 }))
  refused(() => readWholeNumber('x', 1e21, { min: 0, max: Number.MAX_VALUE, fallback: 1 }))
})

test('readWholeNumber uses the given code and refuses to run without bounds', () => {
  refused(() => readWholeNumber('x', 5, { min: 1, max: 2, fallback: 1, code: 'sapka_tul_nagy' }), 'sapka_tul_nagy')
  assert.throws(() => readWholeNumber('x', 5, { fallback: 1 }), /bounds/)
})

test('readEnum refuses an unknown member with the given code and names the list, not the value', () => {
  const err = refused(() => readEnum('tipus', 'szamm', ['cimlap', 'szam'], { code: 'tipus_ismeretlen' }), 'tipus_ismeretlen')
  assert.match(err.message, /cimlap, szam/)
  assert.doesNotMatch(err.message, /szamm/)
  refused(() => readEnum('tipus', 3, ['cimlap', 'szam']))
})

test('readEnum returns the fallback for an absent or blank value and refuses a required one', () => {
  assert.equal(readEnum('order', undefined, ['a', 'b'], { fallback: 'a' }), 'a')
  assert.equal(readEnum('order', '', ['a', 'b'], { fallback: 'a' }), 'a')
  assert.equal(readEnum('order', 'b', ['a', 'b'], { fallback: 'a' }), 'b')
  refused(() => readEnum('order', '', ['a', 'b'], { required: true }))
  refused(() => readEnum('order', null, ['a', 'b'], { required: true, code: 'order_kell' }), 'order_kell')
})

test('readString refuses a non-string, a blank required one and one over max; an optional blank comes back as sent', () => {
  assert.equal(readString('cim', undefined), undefined)
  assert.equal(readString('cim', ''), '')
  assert.equal(readString('cim', 'x'), 'x')
  refused(() => readString('cim', 5))
  refused(() => readString('cim', undefined, { required: true }))
  refused(() => readString('cim', '  ', { required: true }))
  refused(() => readString('cim', 'abc', { max: 2 }))
  assert.equal(readString('cim', 'ab', { max: 2 }), 'ab')
})

test('readArray refuses a non-list and one over max, and treats a blank as absent', () => {
  assert.equal(readArray('jelenetek', undefined), undefined)
  assert.equal(readArray('jelenetek', ''), undefined)
  assert.deepEqual(readArray('jelenetek', [1]), [1])
  refused(() => readArray('jelenetek', 'a'))
  refused(() => readArray('jelenetek', {}))
  refused(() => readArray('jelenetek', undefined, { required: true }))
  refused(() => readArray('jelenetek', [1, 2, 3], { max: 2 }))
})

test('readBoolean accepts only a boolean', () => {
  assert.equal(readBoolean('f', undefined, { fallback: true }), true)
  assert.equal(readBoolean('f', false, { fallback: true }), false)
  refused(() => readBoolean('f', 'true', { fallback: true }))
  refused(() => readBoolean('f', 1, { fallback: true }))
})

test('refuse throws a VideoError with the code, message and extra', () => {
  const err = refused(() => refuse('render_folyamatban', 'fut', { renderId: 'r1' }), 'render_folyamatban')
  assert.equal(err.message, 'fut'); assert.deepEqual(err.extra, { renderId: 'r1' }); assert.equal(err.name, 'VideoError')
  assert.equal(refused(() => refuse('x'), 'x').message, 'x', 'a missing message falls back to the code')
})

test('guard turns a VideoError into the error object with its extra', async () => {
  assert.deepEqual(await guard(() => refuse('render_folyamatban', 'már fut', { renderId: 'r1' })), { error: { code: 'render_folyamatban', message: 'már fut', renderId: 'r1' } })
  assert.deepEqual(await guard(async () => ({ ok: 1 })), { ok: 1 })
})

test('guard rethrows a plain Error, so a bug reaches the host counter instead of the agent', async () => {
  await assert.rejects(guard(() => { throw new Error('bug') }), /bug/)
})

test('guard names a contract failure after the extension that failed', async () => {
  const threw = Object.assign(new Error('tts.narration threw'), { code: 'provider_threw', extensionId: 'tts.mjs', consumerId: 'video.mjs', cause: new Error('tts_keret_kimerult') })
  assert.deepEqual(await guard(() => { throw threw }), { error: { code: 'szerzodes_hiba', message: 'tts.narration threw: tts_keret_kimerult', extension: 'tts.mjs' } })
  const missing = Object.assign(new Error('tts is not installed'), { code: 'provider_missing', extensionId: 'tts.mjs', consumerId: 'video.mjs' })
  assert.deepEqual(await guard(() => { throw missing }), { error: { code: 'szerzodes_hianyzik', message: 'tts is not installed', extension: 'tts.mjs' } })
  // The host's own shape: code `unavailable` with the reason beside it, which the answer carries as `why`.
  const disabled = Object.assign(new Error('contract aisignal.signals.list is no longer available to video.mjs: provider_disabled'), { code: 'unavailable', reason: 'provider_disabled', extensionId: 'aisignal', consumerId: 'video.mjs' })
  assert.deepEqual(await guard(() => { throw disabled }), { error: { code: 'szerzodes_hianyzik', message: disabled.message, extension: 'aisignal', why: 'provider_disabled' } })
})

test('agentIdOf reads the session only and answers blank for a session with no agent', () => {
  assert.equal(agentIdOf({ session: { agentId: null } }), '')
  assert.equal(agentIdOf({ session: { agentId: '' } }), '')
  assert.equal(agentIdOf({ session: { agentId: 'a1' }, args: { agentId: 'spoof' } }), 'a1')
  assert.equal(agentIdOf({}), ''); assert.equal(agentIdOf(null), '')
  assert.equal(sessionIdOf({ session: { id: 's1' } }), 's1'); assert.equal(sessionIdOf({ session: {} }), ''); assert.equal(sessionIdOf(undefined), '')
})
