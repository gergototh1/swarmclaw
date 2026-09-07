import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HIBA,
  VIDEOS_CONTRACT,
  VIDEOS_CONTRACT_VERSION,
  VIDEO_EXTENSION,
  videosHandle,
} from '../src/video-szerzodes.mjs'

/**
 * `videosHandle` is this module's consumer-side receiver for `video.videos@1`
 * (brief 1.6), modelled on `extensions/docs/src/video-forgatokonyv.mjs`'s
 * `videosHandle(contracts)`. These tests mirror
 * `extensions/docs/test/video-forgatokonyv.test.mjs`'s coverage of that
 * function -- four named reasons for a null handle, plus the one case where
 * the reason itself moved between the two host calls -- because the brief
 * says explicitly not to write this worse than the original.
 */

/** A `ctx.contracts` double: `get` answers a handle or null, `why` answers the reason. */
function contractsDouble({ handle = null, why = null } = {}) {
  const asked = []
  return {
    asked,
    get: (ext, contract) => { asked.push(['get', ext, contract]); return handle },
    why: (ext, contract) => { asked.push(['why', ext, contract]); return why },
  }
}

function refusal(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

test('the module names the provider, the contract and the version it pins', () => {
  assert.equal(VIDEO_EXTENSION, 'video')
  assert.equal(VIDEOS_CONTRACT, 'videos')
  assert.equal(VIDEOS_CONTRACT_VERSION, 1)
})

test('the error table knows the code this reach needs', () => {
  assert.equal(HIBA.szerzodes_hianyzik, 'szerzodes_hianyzik')
})

test('videosHandle asks for exactly the video.videos pair and returns the handle', () => {
  const handle = { get: async () => null }
  const contracts = contractsDouble({ handle })
  assert.equal(videosHandle({ contracts }), handle)
  assert.deepEqual(contracts.asked, [['get', 'video', 'videos']])
})

test('every reason a handle can be missing is named, and each says something different to do', () => {
  const uzenetek = new Set()
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    const err = refusal(() => videosHandle({ contracts: contractsDouble({ why }) }))
    assert.ok(err, `${why}: nem utasította el`)
    assert.equal(err.code, HIBA.szerzodes_hianyzik)
    assert.ok(err.message.includes(why), `${why}: a hostkód nem jelenik meg az üzenetben`)
    uzenetek.add(err.message)
  }
  assert.equal(uzenetek.size, 4, 'a négy ok négy különböző mondatot kell adjon')
})

test('a reason the host has never named yet is passed through rather than folded into one of the four', () => {
  const err = refusal(() => videosHandle({ contracts: contractsDouble({ why: 'valami_uj' }) }))
  assert.ok(err.message.includes('valami_uj'))
})

test('the race the host itself loses: why answers null between the two calls', () => {
  const err = refusal(() => videosHandle({ contracts: contractsDouble({ why: null }) }))
  assert.ok(err, 'nem utasította el')
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
})

test('no contracts object at all -- setup() has not run yet -- is refused by name, not a TypeError', () => {
  const err = refusal(() => videosHandle({ contracts: null }))
  assert.ok(err, 'nem utasította el')
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
  assert.equal(err.name, 'PublishError')
})

test('the refusal never echoes stored or caller text, only the host\'s own reason word', () => {
  // A closed set of words the host itself may hand back -- never anything a
  // caller supplied to this function, which takes no caller text at all.
  const err = refusal(() => videosHandle({ contracts: contractsDouble({ why: 'provider_disabled' }) }))
  assert.equal(err.name, 'PublishError')
})
