import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { REQUEST_TIMEOUT_MS, TTS_KODOK, TtsError, classifyRefusal, looksLikeMp3, synthesizeRemote } from '../src/soniox.mjs'
import { BECSULT_KARAKTER_PER_MP, MAX_SZOVEG, celFajlEllenorzes, createSynthesizer, probeDurationMs } from '../src/synthesize.mjs'
import { memStorage } from './helpers.mjs'

/**
 * Every test injects `fetchImpl` and `execFileImpl`: no request leaves the
 * machine and no ffprobe is needed. The bytes start with an ID3 tag so the
 * mp3 check passes; nothing here decodes them.
 */
const MP3 = Buffer.from('ID3fake-bytes-for-test')
const today = () => new Date().toISOString().slice(0, 10)

function setup({ settings = {}, fetchImpl, probeMs = 1200, execFileImpl } = {}) {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const calls = []
  const state = {
    repo: createRepo(s),
    log: { info() {}, warn() {}, error() {} },
    settings: () => ({ apiKey: 'k', endpoint: 'https://tts.example.test/v1', ...settings }),
    fetchImpl: fetchImpl || (async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    }),
    execFileImpl: execFileImpl || (async () => ({ stdout: `${probeMs / 1000}\n`, stderr: '' })),
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'))
  return { state, calls, dir, synth: createSynthesizer(state), cel: (n) => path.join(dir, 'narracio', `${n}.mp3`) }
}

/** The code of the TtsError a call throws, or null when it does not throw. */
async function codeOf(label, fn) {
  try {
    await fn()
    return null
  } catch (e) {
    assert.ok(e instanceof TtsError, `${label}: not a TtsError: ${e}`)
    return e.code
  }
}

test('a first call goes to the provider, writes the file, measures and counts; a second is a cache hit copied to the new target', async () => {
  const { state, calls, synth, cel } = setup()
  const a = await synth.synthesize({ szoveg: 'Szia, világ.', celFajl: cel('a'), kerte: 'contract' })
  assert.equal(a.cache, false)
  assert.equal(a.hosszMs, 1200)
  assert.equal(a.hang, 'Kenji')
  assert.equal(a.modell, 'tts-rt-v1')
  assert.equal(a.fajl, cel('a'))
  assert.equal(fs.readFileSync(cel('a')).equals(MP3), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://tts.example.test/v1')
  assert.equal(calls[0].init.method, 'POST')
  assert.match(calls[0].init.headers.authorization, /^Bearer k$/)
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'the request carries the deadline signal')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Szia, világ.', model: 'tts-rt-v1', voice: 'Kenji', language: 'hu', audio_format: 'mp3' })

  const b = await synth.synthesize({ szoveg: 'Szia, világ.', celFajl: cel('b'), kerte: 'mcp' })
  assert.equal(b.cache, true)
  assert.equal(b.kerelemId, a.kerelemId)
  assert.equal(b.fajl, cel('b'))
  assert.equal(b.hosszMs, 1200)
  assert.equal(fs.readFileSync(cel('b')).equals(MP3), true)
  assert.equal(calls.length, 1, 'the cache hit made no request')
  assert.equal(state.repo.maiMasodperc(today()), 1.2)
  assert.deepEqual(state.repo.counts(), { kerelmek: 1, kesz: 1, hiba: 0 })
})

test('a cache row whose file is gone is re-synthesised, not returned', async () => {
  const { state, calls, synth, cel } = setup()
  const first = await synth.synthesize({ szoveg: 'Eltűnik.', celFajl: cel('x'), kerte: 'contract' })
  fs.unlinkSync(cel('x'))
  const again = await synth.synthesize({ szoveg: 'Eltűnik.', celFajl: cel('y'), kerte: 'contract' })
  assert.equal(again.cache, false)
  assert.notEqual(again.kerelemId, first.kerelemId)
  assert.equal(calls.length, 2)
  // The lost row released the key and the new one holds it.
  assert.equal(state.repo.counts().kesz, 1)
})

test('the settings decide the voice and the cache key, a blank field is the default', async () => {
  const { calls, synth, cel } = setup({ settings: { hang: '  Mira ', modell: '', nyelv: 'en' } })
  const r = await synth.synthesize({ szoveg: 'Hello.', celFajl: cel('a'), kerte: 'mcp' })
  assert.equal(r.hang, 'Mira')
  assert.equal(r.modell, 'tts-rt-v1')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Hello.', model: 'tts-rt-v1', voice: 'Mira', language: 'en', audio_format: 'mp3' })
  assert.deepEqual(synth.status(), { kulcsBeallitva: true, vegpontBeallitva: true, maiMasodperc: 1.2, napiKeret: 900, hang: 'Mira', modell: 'tts-rt-v1', nyelv: 'en' })
})

test('refusals are named: missing key, missing endpoint, bad target, bad text, exhausted budget, bad setting', async () => {
  const noKey = setup({ settings: { apiKey: '' } })
  assert.equal(await codeOf('key', () => noKey.synth.synthesize({ szoveg: 'x', celFajl: noKey.cel('a'), kerte: 'mcp' })), 'tts_kulcs_hianyzik')
  assert.equal(noKey.calls.length, 0)

  const noEndpoint = setup({ settings: { endpoint: '' } })
  assert.equal(await codeOf('endpoint', () => noEndpoint.synth.synthesize({ szoveg: 'x', celFajl: noEndpoint.cel('a'), kerte: 'mcp' })), 'tts_vegpont_hianyzik')

  const ok = setup()
  assert.equal(await codeOf('rel', () => ok.synth.synthesize({ szoveg: 'x', celFajl: 'relative.mp3', kerte: 'mcp' })), 'tts_celfajl_ervenytelen')
  assert.equal(await codeOf('dotdot', () => ok.synth.synthesize({ szoveg: 'x', celFajl: `${ok.dir}/../a.mp3`, kerte: 'mcp' })), 'tts_celfajl_ervenytelen')
  assert.equal(await codeOf('ext', () => ok.synth.synthesize({ szoveg: 'x', celFajl: path.join(ok.dir, 'a.wav'), kerte: 'mcp' })), 'tts_celfajl_ervenytelen')
  assert.equal(await codeOf('newline', () => ok.synth.synthesize({ szoveg: 'x', celFajl: path.join(ok.dir, 'a\nb.mp3'), kerte: 'mcp' })), 'tts_celfajl_ervenytelen')
  assert.equal(await codeOf('missing', () => ok.synth.synthesize({ szoveg: 'x', kerte: 'mcp' })), 'tts_celfajl_ervenytelen')
  assert.equal(await codeOf('empty', () => ok.synth.synthesize({ szoveg: '   ', celFajl: ok.cel('a'), kerte: 'mcp' })), 'tts_szoveg_ervenytelen')
  assert.equal(await codeOf('not a string', () => ok.synth.synthesize({ szoveg: 42, celFajl: ok.cel('a'), kerte: 'mcp' })), 'tts_szoveg_ervenytelen')
  assert.equal(await codeOf('long', () => ok.synth.synthesize({ szoveg: 'a'.repeat(MAX_SZOVEG + 1), celFajl: ok.cel('a'), kerte: 'mcp' })), 'tts_szoveg_ervenytelen')
  assert.equal(ok.calls.length, 0, 'no refusal reached the provider')
  assert.deepEqual(ok.state.repo.counts(), { kerelmek: 0, kesz: 0, hiba: 0 }, 'an argument refused before the call leaves no row')

  const tight = setup({ settings: { napiKeretMp: 1 } })
  await assert.rejects(
    tight.synth.synthesize({ szoveg: 'a'.repeat(BECSULT_KARAKTER_PER_MP * 10), celFajl: tight.cel('a'), kerte: 'mcp' }),
    (e) => e instanceof TtsError && e.code === 'tts_keret_kimerult' && e.maiMasodperc === 0 && e.napiKeret === 1,
  )
  assert.equal(tight.calls.length, 0)

  // A present setting that cannot be honoured is refused by name, not coerced.
  for (const napiKeretMp of [0, -5, 'sok', {}]) {
    const bad = setup({ settings: { napiKeretMp } })
    assert.equal(await codeOf(`napiKeretMp ${JSON.stringify(napiKeretMp)}`, () => bad.synth.synthesize({ szoveg: 'x', celFajl: bad.cel('a'), kerte: 'mcp' })), 'tts_beallitas_hibas')
    assert.throws(() => bad.synth.status(), (e) => e instanceof TtsError && e.code === 'tts_beallitas_hibas')
  }
  const typed = setup({ settings: { hang: 7 } })
  assert.equal(await codeOf('hang', () => typed.synth.synthesize({ szoveg: 'x', celFajl: typed.cel('a'), kerte: 'mcp' })), 'tts_beallitas_hibas')
  // A number typed into the number field arrives as a string and is still a number.
  assert.equal(setup({ settings: { napiKeretMp: '120' } }).synth.status().napiKeret, 120)
  assert.equal(setup({ settings: { napiKeretMp: '' } }).synth.status().napiKeret, 900)
})

test('the cap counts what was made today: a call that would cross it is refused, one that fits goes out', async () => {
  const { state, calls, synth, cel } = setup({ settings: { napiKeretMp: 2 }, probeMs: 1500 })
  await synth.synthesize({ szoveg: 'Első.', celFajl: cel('a'), kerte: 'mcp' })
  assert.equal(state.repo.maiMasodperc(today()), 1.5)
  // 0.5 s of room; ~1 s estimated is refused, ~0.3 s estimated is not.
  await assert.rejects(synth.synthesize({ szoveg: 'a'.repeat(BECSULT_KARAKTER_PER_MP), celFajl: cel('b'), kerte: 'mcp' }), (e) => e.code === 'tts_keret_kimerult' && e.maiMasodperc === 1.5)
  await synth.synthesize({ szoveg: 'Négy', celFajl: cel('c'), kerte: 'mcp' })
  assert.equal(calls.length, 2)
})

test('a non-2xx answer is tts_szolgaltato_visszautasitott with the status, recorded as a failed row, and the counter is untouched', async () => {
  for (const [status, body] of [[500, 'boom'], [403, '{"error":"forbidden"}'], [400, '{"error":{"message":"voice not found"}}']]) {
    const { state, synth, cel } = setup({ fetchImpl: async () => new Response(body, { status, headers: { 'content-type': status === 500 ? 'text/plain' : 'application/json' } }) })
    await assert.rejects(
      synth.synthesize({ szoveg: 'Fizess.', celFajl: cel('a'), kerte: 'mcp' }),
      (e) => e instanceof TtsError && e.code === 'tts_szolgaltato_visszautasitott' && e.httpStatus === status && new RegExp(String(status)).test(e.message) && !e.message.includes('forbidden') && !e.message.includes('boom'),
      `HTTP ${status}`,
    )
    assert.deepEqual(state.repo.counts(), { kerelmek: 1, kesz: 0, hiba: 1 })
    assert.equal(state.repo.kerelmek(1)[0].hiba_kod, 'tts_szolgaltato_visszautasitott')
    assert.equal(state.repo.maiMasodperc(today()), 0)
    assert.equal(fs.existsSync(cel('a')), false)
  }
})

test('a refusal for lack of balance names itself: HTTP 402, or a 4xx whose error text names the balance', async () => {
  const cases = [
    [402, '{"error":"quota"}', 'http-402'],
    [402, 'Payment Required', 'http-402'],
    [403, '{"error":{"message":"Insufficient balance. Top up your account."}}', 'hibaszoveg'],
    [400, '{"detail":"Your credits are exhausted"}', 'hibaszoveg'],
    [429, '{"error":"You have no credits left"}', 'hibaszoveg'],
  ]
  for (const [status, body, alap] of cases) {
    const isJson = body.startsWith('{')
    const { state, synth, cel } = setup({ fetchImpl: async () => new Response(body, { status, headers: { 'content-type': isJson ? 'application/json' : 'text/plain' } }) })
    await assert.rejects(
      synth.synthesize({ szoveg: 'Fizess.', celFajl: cel('a'), kerte: 'mcp' }),
      (e) => e instanceof TtsError && e.code === 'tts_egyenleg_kimerult' && e.httpStatus === status && e.alap === alap
        && !/quota|Top up|credits/.test(e.message),
      `HTTP ${status} ${body}`,
    )
    assert.equal(state.repo.kerelmek(1)[0].hiba_kod, 'tts_egyenleg_kimerult')
    assert.equal(state.repo.maiMasodperc(today()), 0)
  }
  // The phrase rule is narrow on purpose: a permission or a rate limit is not a balance.
  for (const [status, body] of [[403, '{"error":"insufficient permissions"}'], [429, '{"error":"rate limit exceeded, quota reset in 10s"}'], [500, '{"error":"insufficient balance"}']]) {
    assert.equal(classifyRefusal(status, JSON.parse(body)).code, 'tts_szolgaltato_visszautasitott', `${status} ${body}`)
  }
  // A 5xx body is never read for phrases; a 4xx with no JSON is a plain refusal.
  assert.equal(classifyRefusal(503, undefined).code, 'tts_szolgaltato_visszautasitott')
  assert.equal(classifyRefusal(401, undefined).code, 'tts_szolgaltato_visszautasitott')
})

test('a network failure is tts_halozat with the cause code, not the URL, and a JSON answer with base64 audio is accepted', async () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })
  const down = setup({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause }) } })
  await assert.rejects(
    down.synth.synthesize({ szoveg: 'x', celFajl: down.cel('a'), kerte: 'mcp' }),
    (e) => e instanceof TtsError && e.code === 'tts_halozat' && /ECONNREFUSED/.test(e.message) && !/127\.0\.0\.1/.test(e.message),
  )
  assert.equal(down.state.repo.kerelmek(1)[0].hiba_kod, 'tts_halozat')
  assert.equal(fs.existsSync(down.cel('a')), false)
  // A failure with no code repeats only the error's class: a runtime's
  // message may spell out the URL, and the endpoint is not quoted.
  const wordy = setup({ fetchImpl: async () => { throw new TypeError('request to https://tts.example.test/v1 failed') } })
  await assert.rejects(
    wordy.synth.synthesize({ szoveg: 'x', celFajl: wordy.cel('a'), kerte: 'mcp' }),
    (e) => e.code === 'tts_halozat' && /TypeError/.test(e.message) && !/example\.test/.test(e.message),
  )

  const json = setup({ fetchImpl: async () => new Response(JSON.stringify({ audio: MP3.toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } }) })
  const r = await json.synth.synthesize({ szoveg: 'x', celFajl: json.cel('a'), kerte: 'mcp' })
  assert.equal(fs.readFileSync(r.fajl).equals(MP3), true)
  const alt = setup({ fetchImpl: async () => new Response(JSON.stringify({ audio_base64: MP3.toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } }) })
  assert.equal(fs.readFileSync((await alt.synth.synthesize({ szoveg: 'x', celFajl: alt.cel('a'), kerte: 'mcp' })).fajl).equals(MP3), true)
})

test('a 2xx that carries no usable audio is tts_valasz_ertelmezhetetlen, not a refusal and not a success', async () => {
  const cases = [
    ['empty bytes', new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'audio/mpeg' } })],
    ['JSON without audio', new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['JSON that is an array', new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['not JSON when declared', new Response('<html>', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['bytes that are not mp3', new Response(Buffer.from('RIFF....WAVEfmt '), { status: 200, headers: { 'content-type': 'audio/mpeg' } })],
    ['base64 of not-mp3', new Response(JSON.stringify({ audio: Buffer.from('RIFF....WAVE').toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['declared too large', new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(64 * 1024 * 1024) } })],
  ]
  for (const [label, response] of cases) {
    const { state, synth, cel } = setup({ fetchImpl: async () => response })
    await assert.rejects(
      synth.synthesize({ szoveg: 'x', celFajl: cel('a'), kerte: 'mcp' }),
      (e) => e instanceof TtsError && e.code === 'tts_valasz_ertelmezhetetlen' && e.httpStatus === 200,
      label,
    )
    assert.equal(fs.existsSync(cel('a')), false, `${label}: nothing is written`)
    assert.equal(state.repo.kerelmek(1)[0].hiba_kod, 'tts_valasz_ertelmezhetetlen', label)
    assert.equal(state.repo.maiMasodperc(today()), 0, label)
  }
  assert.equal(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00])), true, 'an MPEG frame sync is an mp3 too')
  assert.equal(looksLikeMp3(Buffer.from([0xff, 0x00])), false)
})

/** A fetch that never answers, and rejects the way an aborted one does. */
const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
})

/** A fetch whose headers arrive and whose body then never ends. */
const stallingBody = async (_url, init) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'audio/mpeg' }),
  arrayBuffer: () => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
  }),
})

/** Lets the call reach its fetch and arm the deadline. */
const untilTheRequestIsOut = () => new Promise((resolve) => setImmediate(resolve))

test('a request that never answers is aborted on the deadline under tts_idotullepes, distinct from a transport failure', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { state, synth, cel } = setup({ fetchImpl: hangingFetch })
  const pending = synth.synthesize({ szoveg: 'Várunk.', celFajl: cel('a'), kerte: 'mcp' })
  await untilTheRequestIsOut()

  // One millisecond short of the deadline it is still waiting, so the bound
  // really is the named constant.
  t.mock.timers.tick(REQUEST_TIMEOUT_MS - 1)
  let settled = false
  pending.then(() => { settled = true }, () => { settled = true })
  await untilTheRequestIsOut()
  assert.equal(settled, false)

  t.mock.timers.tick(1)
  await assert.rejects(pending, (e) => e instanceof TtsError && e.code === 'tts_idotullepes' && new RegExp(`${REQUEST_TIMEOUT_MS} ms`).test(e.message))
  assert.equal(state.repo.kerelmek(1)[0].hiba_kod, 'tts_idotullepes')
  assert.equal(state.repo.maiMasodperc(today()), 0)
  assert.equal(fs.existsSync(cel('a')), false)
})

test('the deadline covers the body as well as the headers, and a reply in time leaves nothing armed', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalled = setup({ fetchImpl: stallingBody })
  const pending = stalled.synth.synthesize({ szoveg: 'Csorog.', celFajl: stalled.cel('a'), kerte: 'mcp' })
  await untilTheRequestIsOut()
  t.mock.timers.tick(REQUEST_TIMEOUT_MS)
  await assert.rejects(pending, (e) => e.code === 'tts_idotullepes')
  t.mock.timers.reset()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const quick = setup({ fetchImpl: async (_url, init) => { signal = init.signal; return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } }) } })
  const r = await quick.synth.synthesize({ szoveg: 'Gyors.', celFajl: quick.cel('a'), kerte: 'mcp' })
  assert.equal(r.cache, false)
  // Nothing is left armed to abort a request that already answered.
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 2)
  assert.equal(signal.aborted, false)
})

test('synthesizeRemote honours its own arguments: a bad timeout is refused by name before any request, an absent one is the default', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } }) }
  const base = { endpoint: 'https://tts.example.test/v1', apiKey: 'k', modell: 'm', hang: 'h', nyelv: 'hu', szoveg: 'x', fetchImpl }
  for (const timeoutMs of [0, -1, NaN, Infinity, '60000']) {
    await assert.rejects(synthesizeRemote({ ...base, timeoutMs }), (e) => e instanceof TtsError && e.code === 'tts_beallitas_hibas' && /timeoutMs/.test(e.message), String(timeoutMs))
  }
  assert.equal(calls, 0)
  assert.equal((await synthesizeRemote(base)).equals(MP3), true)
  assert.equal(calls, 1)
})

test('a measurement failure after a paid call is tts_hossz_meres_sikertelen, recorded, and charged to the counter by estimate', async () => {
  const text = 'a'.repeat(BECSULT_KARAKTER_PER_MP * 3)
  const cases = [
    ['ffprobe missing', async () => { throw Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' }) }, /nincs telepítve/],
    ['ffprobe killed on its timeout', async () => { throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) }, /ms alatt/],
    ['ffprobe exits non-zero', async () => { throw Object.assign(new Error('exit'), { code: 1, stderr: 'Invalid data found when processing input' }) }, /1 kóddal/],
    ['ffprobe answers nonsense', async () => ({ stdout: 'N/A\n', stderr: '' }), /pozitív hosszt/],
  ]
  for (const [label, execFileImpl, message] of cases) {
    const { state, synth, cel } = setup({ execFileImpl })
    await assert.rejects(
      synth.synthesize({ szoveg: text, celFajl: cel('a'), kerte: 'mcp' }),
      (e) => e instanceof TtsError && e.code === 'tts_hossz_meres_sikertelen' && message.test(e.message) && !/Invalid data/.test(e.message),
      label,
    )
    assert.equal(state.repo.maiMasodperc(today()), 3, `${label}: the estimate is charged`)
    const row = state.repo.kerelmek(1)[0]
    assert.equal(row.status, 'hiba', label)
    assert.equal(row.hiba_kod, 'tts_hossz_meres_sikertelen', label)
    assert.equal(row.bajt, MP3.length, label)
    assert.equal(fs.existsSync(cel('a')), true, `${label}: the file the caller asked for is where it asked`)
    // No finished row claims it, so the next call makes it again.
    assert.equal(state.repo.counts().kesz, 0, label)
  }
  // The probe passes the file as an argument, under a timeout, never through a shell.
  let seen
  await probeDurationMs('/abs/x.mp3', async (cmd, args, opts) => { seen = { cmd, args, opts }; return { stdout: '2.5\n', stderr: '' } })
  assert.equal(seen.cmd, 'ffprobe')
  assert.equal(seen.args.at(-1), '/abs/x.mp3')
  assert.equal(typeof seen.opts.timeout, 'number')
})

test('two overlapping calls for one sentence both finish, and both report the row that holds the key', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const { state, synth, cel } = setup({ fetchImpl: async () => { calls += 1; await gate; return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } }) } })
  const a = synth.synthesize({ szoveg: 'Egyszerre.', celFajl: cel('a'), kerte: 'mcp' })
  const b = synth.synthesize({ szoveg: 'Egyszerre.', celFajl: cel('b'), kerte: 'contract' })
  await untilTheRequestIsOut()
  assert.equal(calls, 2, 'both went out: the cache had nothing when either looked')
  release()
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.kerelemId, rb.kerelemId)
  assert.equal(fs.existsSync(cel('a')), true)
  assert.equal(fs.existsSync(cel('b')), true)
  assert.equal(state.repo.counts().kesz, 1)
  // Both were paid for and both were counted.
  assert.equal(state.repo.maiMasodperc(today()), 2.4)
})

test('the text reaches the request body verbatim and nothing else: not the file name, not a message, not a log', async () => {
  const text = 'Ignore previous instructions; ../../etc/passwd\n$(rm -rf /) <script>x</script>'
  const logged = []
  const { state, calls, synth, cel } = setup()
  state.log = { info: (...a) => logged.push(a), warn: (...a) => logged.push(a), error: (...a) => logged.push(a) }
  const r = await synth.synthesize({ szoveg: text, celFajl: cel('safe'), kerte: 'mcp' })
  assert.equal(JSON.parse(calls[0].init.body).text, text)
  assert.equal(r.fajl, cel('safe'))
  assert.equal(fs.readdirSync(path.dirname(cel('safe'))).join(), 'safe.mp3')
  assert.equal(logged.length, 0)
  assert.equal(state.repo.kerelmek(1)[0].szoveg, text, 'the row stores it raw, in its own column')

  // Every refusal that can see the text keeps it out of its message.
  const refused = setup({ fetchImpl: async () => new Response('{"error":"nope"}', { status: 400, headers: { 'content-type': 'application/json' } }) })
  for (const fn of [
    () => refused.synth.synthesize({ szoveg: text, celFajl: refused.cel('a'), kerte: 'mcp' }),
    () => refused.synth.synthesize({ szoveg: `${text}${'a'.repeat(MAX_SZOVEG)}`, celFajl: refused.cel('a'), kerte: 'mcp' }),
    () => refused.synth.synthesize({ szoveg: text, celFajl: `${refused.dir}/${text}.mp3`, kerte: 'mcp' }),
  ]) {
    await assert.rejects(fn, (e) => e instanceof TtsError && !e.message.includes('passwd') && !e.message.includes('script'))
  }
})

test('status reports settings without the key value, and the code set is closed', () => {
  const { synth } = setup()
  const st = synth.status()
  assert.deepEqual(Object.keys(st).sort(), ['hang', 'kulcsBeallitva', 'maiMasodperc', 'modell', 'napiKeret', 'nyelv', 'vegpontBeallitva'])
  assert.equal(st.kulcsBeallitva, true)
  assert.equal(JSON.stringify(st).includes('"k"'), false)
  assert.equal(setup({ settings: { apiKey: '', endpoint: '' } }).synth.status().kulcsBeallitva, false)
  assert.equal(setup({ settings: { apiKey: '', endpoint: '' } }).synth.status().vegpontBeallitva, false)
  assert.equal(celFajlEllenorzes('/abs/ok.mp3'), null)
  assert.equal(Object.isFrozen(TTS_KODOK), true)
  for (const code of ['tts_egyenleg_kimerult', 'tts_idotullepes', 'tts_valasz_ertelmezhetetlen', 'tts_szolgaltato_visszautasitott', 'tts_halozat']) {
    assert.ok(TTS_KODOK.includes(code), code)
  }
})
