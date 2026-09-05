import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { DEFAULT_LIMIT, MAX_IMPORT_SOROK, MAX_LIMIT, createRpc, readWholeNumber, shimRuntime } from '../src/rpc.mjs'
import { createSynthesizer } from '../src/synthesize.mjs'
import { memStorage } from './helpers.mjs'

/**
 * Every test injects `fetchImpl` and `execFileImpl`: no request leaves the
 * machine and no ffprobe is needed. The bytes start with an ID3 tag so the
 * mp3 check passes; nothing here decodes them.
 */
const MP3 = Buffer.from('ID3fake-bytes-for-test')

function setup({ settings = {}, fetchImpl, execFileImpl } = {}) {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const calls = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-rpc-'))
  const state = {
    repo: createRepo(s),
    log: { info() {}, warn() {}, error() {} },
    settings: () => ({ apiKey: 'titkos-kulcs', endpoint: 'https://tts.example.test/v1', hangGyoker: dir, ...settings }),
    fetchImpl: fetchImpl || (async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    }),
    execFileImpl: execFileImpl || (async () => ({ stdout: '0.5\n', stderr: '' })),
  }
  const synth = createSynthesizer(state)
  return { state, calls, dir, synth, rpc: createRpc(state, synth, { workspaceDir: '/ws/tts_mjs', portFile: '/home/run/port.json' }) }
}

// --- health and status ---

test('health and status never carry the key value and report the counts, the port file and the shim', async () => {
  const { rpc } = setup()
  const h = await rpc.health({})
  assert.equal(h.kulcsBeallitva, true)
  assert.equal(h.vegpontBeallitva, true)
  assert.equal(JSON.stringify(h).includes('titkos-kulcs'), false)
  assert.deepEqual(h.counts, { kerelmek: 0, kesz: 0, hiba: 0 })
  assert.equal(h.portFile, '/home/run/port.json')
  assert.equal(h.shim, '/ws/tts_mjs/mcp/server.mjs')
  const s = await rpc.status()
  assert.equal(JSON.stringify(s).includes('titkos-kulcs'), false)
  assert.equal('counts' in s, false, 'status is the shim view and carries no page diagnostics')
})

test('health and status tell an empty key from an empty endpoint', async () => {
  const noKey = setup({ settings: { apiKey: '' } })
  assert.deepEqual([(await noKey.rpc.health({})).kulcsBeallitva, (await noKey.rpc.health({})).vegpontBeallitva], [false, true])
  const noEndpoint = setup({ settings: { endpoint: '' } })
  assert.deepEqual([(await noEndpoint.rpc.status({})).kulcsBeallitva, (await noEndpoint.rpc.status({})).vegpontBeallitva], [true, false])
})

test('a setting that cannot be honoured makes health throw by name rather than answer with a default', async () => {
  const { rpc } = setup({ settings: { napiKeretMp: 'sok' } })
  await assert.rejects(rpc.health({}), (err) => err.code === 'tts_beallitas_hibas' && /napiKeretMp/.test(err.message))
})

test('the no-argument methods refuse an argument by name instead of ignoring it', async () => {
  const { rpc } = setup()
  for (const method of ['status', 'health', 'mcpConfig']) {
    await assert.rejects(rpc[method]({ hang: 'Anna' }), (err) => err.code === 'tts_beallitas_hibas' && /hang/.test(err.message) && !/Anna/.test(err.message), method)
    await assert.doesNotReject(rpc[method]({}), method)
    await assert.doesNotReject(rpc[method](), method)
  }
})

// --- synthesize over rpc: a refusal is a value with its code ---

test('synthesize over rpc returns a named error object instead of throwing', async () => {
  const { rpc } = setup({ settings: { apiKey: '' } })
  const r = await rpc.synthesize({ szoveg: 'x', celFajl: '/abs/a.mp3' })
  assert.equal(r.error.code, 'tts_kulcs_hianyzik')
  assert.equal(typeof r.error.message, 'string')
})

test('synthesize over rpc succeeds with the synthesizer answer and records the mcp route', async () => {
  const { state, calls, dir, rpc } = setup()
  const cel = path.join(dir, 'a.mp3')
  const r = await rpc.synthesize({ szoveg: 'Szia.', celFajl: cel })
  assert.equal(r.cache, false)
  assert.equal(r.fajl, cel)
  assert.equal(r.hosszMs, 500)
  assert.deepEqual([r.hang, r.modell, r.nyelv], ['Kenji', 'tts-rt-v1', 'hu'])
  assert.equal(calls.length, 1)
  assert.equal(state.repo.kerelmek(1)[0].kerte, 'mcp')
})

test('synthesize over rpc names an exhausted balance, an exhausted daily cap and a text refusal as three different codes', async () => {
  const refused = setup({ fetchImpl: async () => new Response('{"error":"insufficient credits"}', { status: 403, headers: { 'content-type': 'application/json' } }) })
  const a = await refused.rpc.synthesize({ szoveg: 'Egy mondat.', celFajl: path.join(refused.dir, 'a.mp3') })
  assert.equal(a.error.code, 'tts_egyenleg_kimerult')
  assert.equal(a.error.httpStatus, 403)
  assert.equal(a.error.alap, 'hibaszoveg')
  assert.equal(JSON.stringify(a).includes('Egy mondat'), false, 'the text never enters the error')

  const capped = setup({ settings: { napiKeretMp: 1 } })
  const b = await capped.rpc.synthesize({ szoveg: 'Ez a mondat hosszabb, mint amennyi belefér egy másodperc keretbe.', celFajl: path.join(capped.dir, 'b.mp3') })
  assert.equal(b.error.code, 'tts_keret_kimerult')
  assert.equal(b.error.napiKeret, 1)
  assert.equal(b.error.maiMasodperc, 0)
  assert.equal(capped.calls.length, 0, 'the cap refuses before any request')

  const c = await capped.rpc.synthesize({ szoveg: '', celFajl: path.join(capped.dir, 'c.mp3') })
  assert.equal(c.error.code, 'tts_szoveg_ervenytelen')
})

test('synthesize over rpc refuses an argument it cannot honour by name and never speaks over it', async () => {
  const { calls, dir, rpc } = setup()
  const r = await rpc.synthesize({ szoveg: 'Szia.', celFajl: path.join(dir, 'a.mp3'), hang: 'Anna' })
  assert.equal(r.error.code, 'tts_beallitas_hibas')
  assert.match(r.error.message, /hang/)
  assert.equal(r.error.message.includes('Anna'), false, 'the value is not repeated')
  assert.equal(calls.length, 0)
  const odd = await rpc.synthesize({ szoveg: 'Szia.', celFajl: path.join(dir, 'a.mp3'), 'x y': 1 })
  assert.equal(odd.error.code, 'tts_beallitas_hibas')
  assert.equal(odd.error.message.includes('x y'), false, 'a key that is not an identifier is not repeated')
})

test('synthesize over rpc lets a fault that is not a TtsError throw, so it reaches the log as a 500', async () => {
  // Each setup() has its own root, and a target is judged against the root of
  // the synthesizer it is handed to, so the two are kept apart by name here.
  const { rpc, dir: probeDir } = setup({ execFileImpl: async () => { throw new TypeError('double fault') } })
  // A failed probe is a TtsError (tts_hossz_meres_sikertelen) and comes back
  // as a value; a repository fault is not, and must not be dressed as one.
  const { state, dir } = setup()
  const broken = createRpc({ ...state, repo: { ...state.repo, cacheHit: () => { throw new RangeError('db gone') } } }, createSynthesizer({ ...state, repo: { ...state.repo, cacheHit: () => { throw new RangeError('db gone') } } }), { workspaceDir: '/ws', portFile: '/p' })
  await assert.rejects(broken.synthesize({ szoveg: 'x', celFajl: path.join(dir, 'a.mp3') }), RangeError)
  const r = await rpc.synthesize({ szoveg: 'x', celFajl: path.join(probeDir, 'b.mp3') })
  assert.equal(r.error.code, 'tts_hossz_meres_sikertelen')
})

// --- mcpConfig ---

test('mcpConfig names the shim, the port file and the key variable, without a key value', async () => {
  const { rpc } = setup()
  const c = await rpc.mcpConfig({})
  assert.equal(c.id, 'tts')
  assert.equal(c.transport, 'stdio')
  assert.deepEqual(c.args, ['/ws/tts_mjs/mcp/server.mjs'])
  assert.equal(c.env.SWARMCLAW_PORT_FILE, '/home/run/port.json')
  assert.match(c.env.SWARMCLAW_ACCESS_KEY, /ACCESS_KEY/)
  assert.equal(JSON.stringify(c).includes('titkos-kulcs'), false)
})

// The word `node` is what a GUI-launched host cannot resolve: launchd gives it
// `/usr/bin:/bin:/usr/sbin:/sbin`, and no Node installation puts a binary in
// any of those. So the entry has to name a runtime by its path, and the only
// path that is certain to exist is the one the host is running on.
test('mcpConfig names a runtime that exists rather than the bare word node', async () => {
  const { rpc } = setup()
  const c = await rpc.mcpConfig({})
  assert.equal(c.command, process.execPath)
  assert.equal(path.isAbsolute(c.command), true, 'the command has to be a path, not a name to look up')
  assert.equal(fs.existsSync(c.command), true, `mcpConfig names ${c.command}, which does not exist`)
})

test('shimRuntime adds ELECTRON_RUN_AS_NODE exactly when the host is an Electron build', () => {
  const plain = shimRuntime({ execPath: '/usr/local/bin/node', electronVersion: undefined })
  assert.equal(plain.command, '/usr/local/bin/node')
  assert.deepEqual(plain.env, {})

  // The desktop app's server already runs this way; the shim it spawns has to
  // be told the same thing, or the Electron binary starts a browser instead.
  const electron = shimRuntime({ execPath: '/Applications/SwarmClaw.app/Contents/MacOS/SwarmClaw', electronVersion: '33.4.11' })
  assert.equal(electron.command, '/Applications/SwarmClaw.app/Contents/MacOS/SwarmClaw')
  assert.deepEqual(electron.env, { ELECTRON_RUN_AS_NODE: '1' })
})

// --- importCache ---

test('importCache fills the cache from existing files and refuses bad rows by index', async () => {
  const { state, dir, rpc } = setup()
  const good = path.join(dir, 'regi.mp3')
  fs.writeFileSync(good, MP3)
  const wav = path.join(dir, 'wav-alnev.mp3')
  fs.writeFileSync(wav, 'RIFF....WAVEfmt ')
  const r = await rpc.importCache({ sorok: [
    { szoveg: 'Régi mondat.', fajl: good },
    { szoveg: '', fajl: good },
    { szoveg: 'Nincs fájl.', fajl: path.join(dir, 'nincs.mp3') },
    { szoveg: 'Régi mondat.', fajl: good },
    { szoveg: 'Relatív.', fajl: 'relativ.mp3' },
    'nem sor',
    { szoveg: 'Nem mp3.', fajl: wav },
    { szoveg: 'Könyvtár.', fajl: path.join(dir, 'mappa.mp3') },
  ] })
  assert.equal(r.imported, 1)
  assert.equal(r.skipped, 1)
  assert.deepEqual(r.refused.map((x) => [x.index, x.ok]), [
    [1, 'szoveg_ervenytelen'], [2, 'fajl_hianyzik'], [4, 'fajl_ervenytelen'], [5, 'sor_ervenytelen'], [6, 'fajl_nem_mp3'], [7, 'fajl_hianyzik'],
  ])
  assert.equal(state.repo.counts().kesz, 1)
  const row = state.repo.kerelmek(1)[0]
  assert.equal(row.kerte, 'import')
  assert.equal(row.hossz_ms, 500)
  assert.equal(row.bajt, MP3.length)
  assert.equal(row.fajl, good)
  await assert.rejects(rpc.importCache({ sorok: 'nope' }), /sorok/)
  await assert.rejects(rpc.importCache({}), /sorok/)
  await assert.rejects(rpc.importCache({ sorok: new Array(MAX_IMPORT_SOROK + 1).fill({ szoveg: 'x', fajl: good }) }), /sorok/)
})

test('an imported sentence is a cache hit for a later call, byte for byte, and a trimmed variant is not', async () => {
  const { calls, dir, rpc, synth } = setup()
  const good = path.join(dir, 'regi.mp3')
  fs.writeFileSync(good, MP3)
  await rpc.importCache({ sorok: [{ szoveg: 'Régi mondat. ', fajl: good }] })
  const hit = await synth.synthesize({ szoveg: 'Régi mondat. ', celFajl: path.join(dir, 'uj.mp3'), kerte: 'contract' })
  assert.equal(hit.cache, true)
  assert.equal(calls.length, 0)
  const miss = await synth.synthesize({ szoveg: 'Régi mondat.', celFajl: path.join(dir, 'uj2.mp3'), kerte: 'contract' })
  assert.equal(miss.cache, false)
  assert.equal(calls.length, 1)
})

test('importCache refuses a file ffprobe cannot measure and stores nothing for it', async () => {
  const { state, dir, rpc } = setup({ execFileImpl: async () => { const e = new Error('spawn'); e.code = 'ENOENT'; throw e } })
  const good = path.join(dir, 'regi.mp3')
  fs.writeFileSync(good, MP3)
  const r = await rpc.importCache({ sorok: [{ szoveg: 'Régi mondat.', fajl: good }] })
  assert.deepEqual(r.refused.map((x) => [x.index, x.ok]), [[0, 'hossz_meres_sikertelen']])
  assert.match(r.refused[0].uzenet, /ffprobe/)
  assert.equal(state.repo.counts().kerelmek, 0)
})

test('importCache under a malformed setting refuses by name rather than importing under a guessed voice', async () => {
  const { rpc } = setup({ settings: { hang: 12 } })
  await assert.rejects(rpc.importCache({ sorok: [] }), (err) => err.code === 'tts_beallitas_hibas' && /hang/.test(err.message))
})

// --- kerelmek ---

test('kerelmek reads the limit by the rule and refuses a negative one or one above the cap', async () => {
  const { rpc, synth, dir } = setup()
  assert.deepEqual(await rpc.kerelmek({}), [])
  await assert.rejects(rpc.kerelmek({ limit: -1 }), /limit/)
  await assert.rejects(rpc.kerelmek({ limit: 0 }), /limit/)
  await assert.rejects(rpc.kerelmek({ limit: MAX_LIMIT + 1 }), /limit/)
  await assert.rejects(rpc.kerelmek({ limit: [] }), /limit.*array/)
  await synth.synthesize({ szoveg: '<script>x</script>', celFajl: path.join(dir, 'a.mp3'), kerte: 'contract' })
  const rows = await rpc.kerelmek({ limit: '1' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].szoveg, '<script>x</script>', 'the text comes back byte for byte for the page to render as text')
  assert.equal(rows[0].kerte, 'contract')
})

test('readWholeNumber: absent is the default, a string number is honoured, above max is refused not clamped', () => {
  const rule = { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT }
  assert.equal(readWholeNumber('limit', undefined, rule), DEFAULT_LIMIT)
  assert.equal(readWholeNumber('limit', null, rule), DEFAULT_LIMIT)
  assert.equal(readWholeNumber('limit', '', rule), DEFAULT_LIMIT)
  assert.equal(readWholeNumber('limit', '7', rule), 7)
  assert.equal(readWholeNumber('limit', MAX_LIMIT, rule), MAX_LIMIT)
  assert.throws(() => readWholeNumber('limit', MAX_LIMIT + 1, rule), /limit/)
  assert.throws(() => readWholeNumber('limit', 1.5, rule), /limit/)
  assert.throws(() => readWholeNumber('limit', 'sok', rule), /limit/)
  assert.throws(() => readWholeNumber('limit', {}, rule), /limit.*object/)
})
