import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HIBA,
  NEM_ERHETO_EL,
  SZERZODES_OKOK,
  VIDEOS_CONTRACT,
  VIDEOS_CONTRACT_VERSION,
  VIDEO_EXTENSION,
  videosHandle,
} from '../src/video-szerzodes.mjs'

/** The four words the host itself may hand back as `reason`, each with its own sentence. */
const NEGY_OK = ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']

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
  for (const why of NEGY_OK) {
    const err = refusal(() => videosHandle({ contracts: contractsDouble({ why }) }))
    assert.ok(err, `${why}: nem utasította el`)
    assert.equal(err.code, HIBA.szerzodes_hianyzik, `${why}: rossz hibakód`)
    assert.match(err.message, new RegExp(why), `${why}: az üzenet nem nevezi meg az okot`)
    uzenetek.add(err.message)
  }
  assert.equal(uzenetek.size, 4, 'két ok ugyanazt a mondatot kapta')
})

test('provider_missing tells the operator to install, provider_disabled to switch on', () => {
  // Ez a két ok fut össze a leggyakrabban, és a teendő az ellentéte egymásnak.
  assert.match(refusal(() => videosHandle({ contracts: contractsDouble({ why: 'provider_missing' }) })).message, /telepít/i)
  assert.match(refusal(() => videosHandle({ contracts: contractsDouble({ why: 'provider_disabled' }) })).message, /kapcsold be/i)
})

test('a reason the host has never named yet is passed through rather than folded into one of the four', () => {
  const err = refusal(() => videosHandle({ contracts: contractsDouble({ why: 'valami_uj' }) }))
  assert.ok(err.message.includes('valami_uj'))
})

test('the race the host itself loses: why answers null between the two calls', () => {
  // A kód és a "dobott" önmagában a TARTALÉK ágon is igaz (`okMondat(null)`),
  // tehát semmit nem bizonyít erről az ágról. Az eredeti,
  // `extensions/docs/test/video-forgatokonyv.test.mjs`, két állítással köti le:
  // a mondat MEGMONDJA a teendőt (kérdezz újra), és NEM állítja a négy ok
  // egyikét sem -- egyiket sem figyelte meg senki.
  const err = refusal(() => videosHandle({ contracts: contractsDouble({ why: null }) }))
  assert.ok(err, 'nem utasította el')
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
  assert.match(err.message, /újra/i)
  for (const why of NEGY_OK) {
    assert.doesNotMatch(err.message, new RegExp(why), `nem megfigyelt okot állít: ${why}`)
  }
})

test('the empty string is the same fact as null: the reason moved, not a fifth reason', () => {
  const err = refusal(() => videosHandle({ contracts: contractsDouble({ why: '' }) }))
  assert.ok(err, 'nem utasította el')
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
  assert.match(err.message, /újra/i)
  for (const why of NEGY_OK) {
    assert.doesNotMatch(err.message, new RegExp(why), `nem megfigyelt okot állít: ${why}`)
  }
})

test('a provider offering videos@1 without a get method is refused by name, not by TypeError', () => {
  // A host a nevet és a verziót egyezteti, a metódus-listát nem. Egy ilyen
  // handle ép, és a hívó egy sorral lejjebb `TypeError`-ba fut, amin nincs
  // `code` -- pont az a névtelen elutasítás, ami ellen ez a modul készül.
  const err = refusal(() => videosHandle({ contracts: contractsDouble({ handle: { list: async () => [] } }) }))
  assert.ok(err, 'nem utasította el')
  assert.equal(err.name, 'PublishError')
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
  assert.match(err.message, /get/)
  assert.match(err.message, /frissítsd/i)
})

test('no contracts object at all -- setup() has not run yet -- is refused by name, not a TypeError', () => {
  const err = refusal(() => videosHandle({ contracts: null }))
  assert.ok(err, 'nem utasította el')
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
  assert.equal(err.name, 'PublishError')
})

test('the refusal never echoes stored or caller text: it is assembled from this module\'s own constants', () => {
  // A modul-szintű megkötés: az elutasítás mondata a modul SAJÁT konstansaiból
  // áll össze, plusz a host saját ok-szava. Az egyenlőség az egyetlen állítás,
  // ami ezt tényleg leköti -- bármi, ami a mondatba szivárogna (egy tárolt
  // `nev`, egy hívó által küldött érték, egy driver-szöveg), megbuktatja.
  const err = refusal(() => videosHandle({ contracts: contractsDouble({ why: 'provider_disabled' }) }))
  assert.equal(err.name, 'PublishError')
  assert.equal(err.message, `${NEM_ERHETO_EL}${SZERZODES_OKOK.provider_disabled}`)
  for (const why of NEGY_OK) {
    assert.equal(SZERZODES_OKOK[why].includes(why), true, `${why}: a host saját ok-szava kimaradt a mondatból`)
  }
})
