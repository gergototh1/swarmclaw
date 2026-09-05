import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { NARRATION_CONTRACT, NARRATION_CONTRACT_VERSION, STATUS_FIELDS, SYNTHESIS_FIELDS, createNarrationContract } from '../src/contract.mjs'
import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createRpc } from '../src/rpc.mjs'
import { TTS_KODOK, TtsError } from '../src/soniox.mjs'
import { createSynthesizer } from '../src/synthesize.mjs'
import { memStorage } from './helpers.mjs'

/**
 * The contract, driven the way the host drives it: each method called with
 * one argument object and awaited. Every test injects `fetchImpl` and
 * `execFileImpl`; no request leaves the machine.
 */
const MP3 = Buffer.from('ID3fake-bytes-for-test')

/** What the host's validator requires of a `provides` entry, repeated here so a declaration the host would refuse fails this suite first. */
const MAX_SUMMARY = 200
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/

function setup({ settings = {}, fetchImpl } = {}) {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const calls = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-contract-'))
  const state = {
    repo: createRepo(s),
    log: { info() {}, warn() {}, error() {} },
    settings: () => ({ apiKey: 'titkos-kulcs', endpoint: 'https://tts.example.test/v1', hangGyoker: dir, ...settings }),
    fetchImpl: fetchImpl || (async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    }),
    execFileImpl: async () => ({ stdout: '1.2\n', stderr: '' }),
  }
  const synth = createSynthesizer(state)
  return { state, calls, dir, synth, contract: createNarrationContract(synth) }
}

test('the declaration is one the host validator accepts: version, a summary under the cap, and named async methods', () => {
  const { contract } = setup()
  assert.equal(NARRATION_CONTRACT, 'narration')
  assert.ok(NAME_RE.test(NARRATION_CONTRACT))
  assert.equal(contract.version, NARRATION_CONTRACT_VERSION)
  assert.ok(Number.isInteger(contract.version) && contract.version >= 1)
  assert.ok(contract.summary.trim().length > 0)
  assert.ok(contract.summary.length <= MAX_SUMMARY, `summary is ${contract.summary.length} chars, the host refuses above ${MAX_SUMMARY}`)
  assert.deepEqual(Object.keys(contract.methods).sort(), ['status', 'synthesize'])
  for (const name of Object.keys(contract.methods)) {
    assert.ok(NAME_RE.test(name))
    assert.equal(typeof contract.methods[name], 'function')
  }
})

test('synthesize answers exactly the listed fields, with the voice, model and language the file was made with', async () => {
  const { state, calls, dir, contract } = setup()
  const cel = path.join(dir, 'narracio', '0.mp3')
  const r = await contract.methods.synthesize({ szoveg: 'Szia, világ.', celFajl: cel })
  assert.deepEqual(Object.keys(r).sort(), [...SYNTHESIS_FIELDS].sort())
  assert.equal(r.cache, false)
  assert.equal(r.fajl, cel)
  assert.equal(r.hosszMs, 1200)
  assert.deepEqual([r.hang, r.modell, r.nyelv], ['Kenji', 'tts-rt-v1', 'hu'])
  assert.equal(typeof r.kerelemId, 'string')
  assert.equal(calls.length, 1)
  assert.equal(JSON.stringify(r).includes('Szia'), false, 'the answer does not repeat the text')
  assert.equal(state.repo.kerelmek(1)[0].kerte, 'contract', 'the row records the route, not a consumer name this side cannot verify')
  const again = await contract.methods.synthesize({ szoveg: 'Szia, világ.', celFajl: path.join(dir, 'narracio', '1.mp3') })
  assert.equal(again.cache, true)
  assert.equal(again.kerelemId, r.kerelemId)
  assert.equal(calls.length, 1)
})

test('status answers exactly the listed fields and never the key value', async () => {
  const { contract } = setup()
  const s = await contract.methods.status({})
  assert.deepEqual(Object.keys(s).sort(), [...STATUS_FIELDS].sort())
  assert.equal(s.kulcsBeallitva, true)
  assert.equal(s.vegpontBeallitva, true)
  assert.equal(s.maiMasodperc, 0)
  assert.equal(s.napiKeret, 900)
  assert.deepEqual([s.hang, s.modell, s.nyelv], ['Kenji', 'tts-rt-v1', 'hu'])
  assert.equal(JSON.stringify(s).includes('titkos-kulcs'), false)
})

test('a field the synthesizer or the rpc grows for the page does not cross the contract', async () => {
  const { dir, synth } = setup()
  const grown = {
    synthesize: async (args) => ({ ...(await synth.synthesize(args)), szoveg: args.szoveg, bajt: 22 }),
    status: () => ({ ...synth.status(), portFile: '/run/port.json', counts: { kerelmek: 0 } }),
  }
  const contract = createNarrationContract(grown)
  const r = await contract.methods.synthesize({ szoveg: 'Nő a válasz.', celFajl: path.join(dir, 'a.mp3') })
  assert.deepEqual(Object.keys(r).sort(), [...SYNTHESIS_FIELDS].sort())
  assert.equal('szoveg' in r, false)
  const s = await contract.methods.status({})
  assert.deepEqual(Object.keys(s).sort(), [...STATUS_FIELDS].sort())
  assert.equal('portFile' in s, false)
  // The rpc over the same synthesizer is the wider surface and does carry the page fields.
  const rpc = createRpc({ repo: { counts: () => ({ kerelmek: 0, kesz: 0, hiba: 0 }) } }, grown, { workspaceDir: '/ws', portFile: '/run/port.json' })
  assert.equal((await rpc.health({})).portFile, '/run/port.json')
})

test('a refusal is thrown as the TtsError itself, with its code from the closed set, and the balance refusal keeps its name', async () => {
  const noKey = setup({ settings: { apiKey: '' } })
  await assert.rejects(noKey.contract.methods.synthesize({ szoveg: 'x', celFajl: path.join(noKey.dir, 'a.mp3') }), (err) => {
    assert.ok(err instanceof TtsError)
    assert.equal(err.code, 'tts_kulcs_hianyzik')
    return true
  })
  const refused = setup({ fetchImpl: async () => new Response('', { status: 402 }) })
  await assert.rejects(refused.contract.methods.synthesize({ szoveg: 'Egy mondat.', celFajl: path.join(refused.dir, 'a.mp3') }), (err) => {
    assert.ok(err instanceof TtsError)
    assert.equal(err.code, 'tts_egyenleg_kimerult')
    assert.equal(err.httpStatus, 402)
    assert.equal(err.message.includes('Egy mondat'), false)
    return true
  })
  const capped = setup({ settings: { napiKeretMp: 1 } })
  await assert.rejects(capped.contract.methods.synthesize({ szoveg: 'Ez a mondat hosszabb, mint amennyi egy másodpercbe belefér.', celFajl: path.join(capped.dir, 'a.mp3') }), (err) => err.code === 'tts_keret_kimerult' && err.napiKeret === 1)
  assert.equal(capped.calls.length, 0)
  const bad = setup()
  await assert.rejects(bad.contract.methods.synthesize({ szoveg: 'x', celFajl: 'relativ.mp3' }), (err) => err.code === 'tts_celfajl_ervenytelen')
  await assert.rejects(bad.contract.methods.synthesize({ szoveg: '', celFajl: path.join(bad.dir, 'a.mp3') }), (err) => err.code === 'tts_szoveg_ervenytelen')
  await assert.rejects(bad.contract.methods.synthesize({}), (err) => err.code === 'tts_szoveg_ervenytelen')
  for (const code of ['tts_kulcs_hianyzik', 'tts_egyenleg_kimerult', 'tts_keret_kimerult', 'tts_celfajl_ervenytelen', 'tts_szoveg_ervenytelen', 'tts_beallitas_hibas']) {
    assert.ok(TTS_KODOK.includes(code), `${code} is in the closed set`)
  }
})

test('an argument the contract cannot honour is refused by name, never spoken over with the configured voice', async () => {
  const { calls, dir, contract } = setup()
  for (const extra of [{ hang: 'Anna-marker' }, { nyelv: 'xx-marker' }, { modell: 'model-marker' }, { kerte: 'route-marker' }]) {
    await assert.rejects(contract.methods.synthesize({ szoveg: 'Szia.', celFajl: path.join(dir, 'a.mp3'), ...extra }), (err) => {
      assert.ok(err instanceof TtsError)
      assert.equal(err.code, 'tts_beallitas_hibas')
      const [key, value] = Object.entries(extra)[0]
      assert.match(err.message, new RegExp(key))
      assert.equal(err.message.includes(value), false, 'the value is not repeated')
      return true
    })
  }
  assert.equal(calls.length, 0)
  // Present with undefined is absent: a consumer spreading an optional field sends no opinion.
  const ok = await contract.methods.synthesize({ szoveg: 'Szia.', celFajl: path.join(dir, 'a.mp3'), hang: undefined })
  assert.equal(ok.cache, false)
  await assert.rejects(contract.methods.synthesize('Szia.'), (err) => err.code === 'tts_beallitas_hibas')
  await assert.rejects(contract.methods.status({ hang: 'Anna' }), (err) => err.code === 'tts_beallitas_hibas' && !/Anna/.test(err.message))
  await assert.doesNotReject(contract.methods.status())
})
