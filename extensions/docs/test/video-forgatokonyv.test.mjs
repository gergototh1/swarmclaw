import assert from 'node:assert/strict'
import test from 'node:test'

import { ERR } from '../src/errors.mjs'
import {
  FORRAS_FIGYELMEZTETES,
  VIDEOS_CONTRACT,
  VIDEOS_CONTRACT_VERSION,
  VIDEO_EXTENSION,
  forgatokonyv,
  videoLekerdez,
  videosHandle,
} from '../src/video-forgatokonyv.mjs'
import { contractError, videoRow } from './helpers.mjs'

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
  assert.equal(ERR.contract_missing, 'contract_missing')
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
  const messages = new Set()
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    const err = refusal(() => videosHandle(contractsDouble({ why })))
    assert.ok(err, `${why}: nem utasította el`)
    assert.equal(err.code, ERR.contract_missing, `${why}: rossz hibakód`)
    assert.match(err.message, new RegExp(why), `${why}: az üzenet nem nevezi meg az okot`)
    messages.add(err.message)
  }
  assert.equal(messages.size, 4, 'két ok ugyanazt a mondatot kapta')
})

test('provider_missing tells the operator to install, provider_disabled to switch on', () => {
  // Ez a két ok fut össze a leggyakrabban, és a teendő az ellentéte egymásnak.
  assert.match(refusal(() => videosHandle(contractsDouble({ why: 'provider_missing' }))).message, /telepít/i)
  assert.match(refusal(() => videosHandle(contractsDouble({ why: 'provider_disabled' }))).message, /kapcsold be/i)
})

test('a reason that moved between the two reads is reported as that, not as one of the four', () => {
  const err = refusal(() => videosHandle(contractsDouble({ why: null })))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /újra/i)
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    assert.doesNotMatch(err.message, new RegExp(why), `nem megfigyelt okot állít: ${why}`)
  }
})

test('an unknown reason word is passed through rather than swallowed', () => {
  const err = refusal(() => videosHandle(contractsDouble({ why: 'valami_uj_ok' })))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /valami_uj_ok/)
})

test('a host that handed over no contracts object is a named refusal, not a TypeError', () => {
  const err = refusal(() => videosHandle(undefined))
  assert.equal(err.code, ERR.contract_missing)
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

async function refusalOf(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('a handle that carries no get is a named contract failure, not a TypeError', async () => {
  // A host a szerződés NEVÉT és VERZIÓJÁT egyezteti, a metódusait nem. Egy
  // `videos@1`-et kínáló szolgáltató `get` nélkül ép handle-t ad, és a hívás
  // sima TypeError-ral dőlne el: azt a `szerzodesHiba` nem ismeri fel, tehát a
  // tool generikus ága `invalid_argument: "videos.get is not a function"`-t
  // adna az ügynöknek. Ez az utolsó ajtó, amin ez a párosítás bejöhetett.
  const contracts = contractsDouble({ handle: { lista: async () => [] } })
  const err = await refusalOf(videoLekerdez(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  // Idézőjelekkel: a `/get/` egy magyar mondatra nézve majdnem bármire illik,
  // és a metódus NEVE az, amit a mondatnak ki kell mondania.
  assert.match(err.message, /"get"/)
  assert.doesNotMatch(err.message, /is not a function/)
})

test('a provider that went away between the handle and the call is named, not generic', async () => {
  // A host minden híváskor újra feloldja a szerződést (callContractMethod),
  // tehát ugyanaz a verseny, amit a videosHandle egy sorral feljebb kezel,
  // itt dobott `unavailable`-ként érkezik. Kezeletlenül a tool generikus
  // ágára esne, és invalid_argument-t adna egy stack-szövegre.
  const contracts = contractsDouble({
    handle: { get: async () => { throw contractError('unavailable', { reason: 'provider_disabled' }) } },
  })
  const err = await refusalOf(videoLekerdez(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /unavailable/)
  // Az ok szava a hosté; ugyanaz a mondat jár rá, mint feloldáskor.
  assert.match(err.message, /provider_disabled/)
  assert.match(err.message, /kapcsold be/i)
})

test('an unavailable with no reason word says to retry rather than guessing one', async () => {
  const contracts = contractsDouble({ handle: { get: async () => { throw contractError('unavailable') } } })
  const err = await refusalOf(videoLekerdez(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /unavailable/)
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    assert.doesNotMatch(err.message, new RegExp(why), `nem megfigyelt okot állít: ${why}`)
  }
})

test('a provider whose own code threw is a different fact from a provider that is gone', async () => {
  const contracts = contractsDouble({ handle: { get: async () => { throw contractError('provider_threw') } } })
  const err = await refusalOf(videoLekerdez(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /provider_threw/)
  // A bővítmény telepítve van és be van kapcsolva: a Bővítmények lapon nincs
  // mit tenni, a napló a következő lépés.
  assert.match(err.message, /napló/i)
  assert.doesNotMatch(err.message, /Bővítmények lapon/)
})

test('a host code this module has not learnt is still a contract failure, not a bad argument', async () => {
  const contracts = contractsDouble({ handle: { get: async () => { throw contractError('unknown_method') } } })
  const err = await refusalOf(videoLekerdez(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /unknown_method/)
})

test('an error that is not the host contract shape is rethrown untouched', async () => {
  // Ez a modul nem birtokolja, és nem talál ki rá mondatot: a tool generikus
  // ága a helye.
  const boom = new Error('ETIMEDOUT')
  const contracts = contractsDouble({ handle: { get: async () => { throw boom } } })
  assert.equal(await refusalOf(videoLekerdez(contracts, 'vid_1')), boom)
})

test('videoLekerdez hands the video back untouched when the call goes through', async () => {
  const contracts = contractsDouble({ handle: { get: async (args) => ({ ...videoRow(), id: args.id }) } })
  assert.equal((await videoLekerdez(contracts, 'vid_9')).id, 'vid_9')
})

test('a reason word that names an Object prototype member takes the unknown fallback', async () => {
  // A kulcsot a host adja, nem ez a modul: sima objektumon a
  // SZERZODES_OKOK['constructor'] egy függvényt adna vissza, és az kerülne
  // bele az operátor üzenetébe.
  for (const why of ['constructor', 'toString', '__proto__']) {
    const err = refusal(() => videosHandle(contractsDouble({ why })))
    assert.equal(err.code, ERR.contract_missing, why)
    assert.match(err.message, /nem oldható fel/, why)
    assert.doesNotMatch(err.message, /function|\[object/i, `${why}: prototípus-tag szivárgott az üzenetbe`)
  }
})
