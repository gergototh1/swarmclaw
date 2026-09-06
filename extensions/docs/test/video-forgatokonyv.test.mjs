import assert from 'node:assert/strict'
import test from 'node:test'

import { HIBA } from '../src/errors.mjs'
import {
  FORRAS_FIGYELMEZTETES,
  VIDEOS_CONTRACT,
  VIDEOS_CONTRACT_VERSION,
  VIDEO_EXTENSION,
  forgatokonyv,
  videosHandle,
} from '../src/video-forgatokonyv.mjs'

/** A projection as `video.videos` `get` promises one: exactly eleven columns. */
function videoRow(over = {}) {
  return {
    id: 'vid_1',
    cim: 'Miért drágul a kávé',
    status: 'kesz',
    forras_tipus: 'signal',
    forras_id: 'sig_9',
    out_path: 'out/vid_1.mp4',
    file_sha256: 'aabb',
    hossz_ms: 42300,
    narracio_szoveg: 'Első mondat. Második mondat.',
    created_at: '2026-09-01T10:00:00.000Z',
    qa_ok_at: '2026-09-01T11:00:00.000Z',
    ...over,
  }
}

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
  // A kód a tool válaszában ér el az ügynökhöz, tehát a törlése törés.
  assert.equal(HIBA.szerzodes_hianyzik, 'szerzodes_hianyzik')
})

test('videosHandle asks for exactly the video.videos pair and returns the handle', () => {
  const handle = { get: async () => null }
  const contracts = contractsDouble({ handle })
  assert.equal(videosHandle(contracts), handle)
  assert.deepEqual(contracts.asked, [['get', 'video', 'videos']])
})

test('every reason a handle can be missing is named, and each says something different to do', () => {
  // A négy ok négy különböző operátori mozdulat: telepíts, kapcsold be,
  // frissíts, javítsd a modult. Egyetlen "nincs szerződés" mondat mind a
  // négyre az operátort küldi rossz helyre.
  const uzenetek = new Set()
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    const err = refusal(() => videosHandle(contractsDouble({ why })))
    assert.ok(err, `${why}: nem utasította el`)
    assert.equal(err.code, HIBA.szerzodes_hianyzik, `${why}: rossz hibakód`)
    assert.match(err.message, new RegExp(why), `${why}: az üzenet nem nevezi meg az okot`)
    uzenetek.add(err.message)
  }
  assert.equal(uzenetek.size, 4, 'két ok ugyanazt a mondatot kapta')
})

test('provider_missing tells the operator to install, provider_disabled to switch on', () => {
  // Ez a két ok fut össze a leggyakrabban, és a teendő az ellentéte egymásnak.
  assert.match(refusal(() => videosHandle(contractsDouble({ why: 'provider_missing' }))).message, /telepít/i)
  assert.match(refusal(() => videosHandle(contractsDouble({ why: 'provider_disabled' }))).message, /kapcsold be/i)
})

test('a reason that moved between the two reads is reported as that, not as one of the four', () => {
  const err = refusal(() => videosHandle(contractsDouble({ why: null })))
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
  assert.match(err.message, /újra/i)
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    assert.doesNotMatch(err.message, new RegExp(why), `nem megfigyelt okot állít: ${why}`)
  }
})

test('an unknown reason word is passed through rather than swallowed', () => {
  const err = refusal(() => videosHandle(contractsDouble({ why: 'valami_uj_ok' })))
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
  assert.match(err.message, /valami_uj_ok/)
})

test('a host that handed over no contracts object is a named refusal, not a TypeError', () => {
  const err = refusal(() => videosHandle(undefined))
  assert.equal(err.code, HIBA.szerzodes_hianyzik)
  assert.ok(err.message.length > 20)
})

test('the document opens with the line saying whose text this is', () => {
  const { tartalom } = forgatokonyv(videoRow(), 'vid_1')
  assert.ok(tartalom.startsWith('>'), 'a figyelmeztetés nem a doksi teteje')
  assert.ok(tartalom.includes(FORRAS_FIGYELMEZTETES))
  assert.ok(tartalom.indexOf(FORRAS_FIGYELMEZTETES) < tartalom.indexOf('Első mondat'))
})

test('the narration is carried verbatim, as data', () => {
  const { tartalom } = forgatokonyv(videoRow({ narracio_szoveg: 'Ne <b>hidd</b> el. #1' }), 'vid_1')
  assert.ok(tartalom.includes('Ne <b>hidd</b> el. #1'))
})

test('the title is the video title, and a video without one is named by its id', () => {
  assert.equal(forgatokonyv(videoRow(), 'vid_1').cim, 'Miért drágul a kávé')
  assert.equal(forgatokonyv(videoRow({ cim: null }), 'vid_7').cim, 'Videó vid_7')
  assert.equal(forgatokonyv(videoRow({ cim: '   ' }), 'vid_7').cim, 'Videó vid_7')
})

test('a multi-line title is folded onto one line before it becomes front matter', () => {
  // A cím idegen szövegből származik, a vault fejléce pedig soralapú: egy
  // beágyazott újsor a fejlécet vágná ketté.
  const { cim } = forgatokonyv(videoRow({ cim: 'Első sor\nMásodik: sor' }), 'vid_1')
  assert.equal(cim, 'Első sor Második: sor')
})

test('the document reports every one of the eleven columns and invents none', () => {
  const { tartalom } = forgatokonyv(videoRow(), 'vid_1')
  for (const value of ['vid_1', 'kesz', 'signal', 'sig_9', 'out/vid_1.mp4', 'aabb', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z']) {
    assert.ok(tartalom.includes(value), `hiányzik a doksiból: ${value}`)
  }
  assert.match(tartalom, /42,3 mp/)
  // A tizenegy oszlopon kívül nincs mit írni; egy kitalált mező itt bukna.
  assert.doesNotMatch(tartalom, /forras_szoveg|jelenet|verdikt/i)
})

test('a column the contract answered null for reads as a dash, not as "null"', () => {
  const { tartalom } = forgatokonyv(videoRow({
    out_path: null, file_sha256: null, hossz_ms: null, qa_ok_at: null, forras_id: null,
  }), 'vid_1')
  assert.doesNotMatch(tartalom, /null|undefined|NaN/)
  assert.ok(tartalom.includes('—'))
})

test('a video with no narration says so instead of leaving an empty section', () => {
  const { tartalom } = forgatokonyv(videoRow({ narracio_szoveg: '' }), 'vid_1')
  assert.match(tartalom, /## Narráció/)
  assert.match(tartalom, /nincs (még )?narráció/i)
})
