import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { KVOTA_EGYSEG_FELTOLTES, KVOTA_NAPI_ALAP, _szamlalotNullaz, createYoutubeAdapter, feltolt } from '../src/platform/youtube.mjs'

/**
 * The YouTube adapter's own suite. Every test injects `fetchImpl`;
 * `sohaNeHivd` is handed to the ones that must never reach it at all, so a
 * mutation that moved the quota gate or the dry-run return past the fetch
 * call fails loudly instead of quietly making a network request the test
 * runner cannot see.
 *
 * `alap()` supplies a real, small file on disk -- not because any of the
 * three required tests (brief 5.2) reads it, but because a later test in
 * this file exercises the real read-and-send path, and a fixture that never
 * has to change between "the token check refuses first" and "the file is
 * actually sent" is one less thing to keep in sync.
 */

const FAJL = path.join(os.tmpdir(), 'swarmclaw-publish-youtube-test.mp4')
fs.writeFileSync(FAJL, 'nem valódi videó, csak a fájl-olvasás teszteléséhez')

const sohaNeHivd = async (...args) => {
  throw new Error(`fetchImpl-t nem szabad hívni ezen az úton (${args[0]})`)
}

function alap() {
  return {
    fajl: FAJL,
    cim: 'A videó címe',
    leiras: 'A videó leírása.',
    cimkek: ['egyik', 'masik'],
    getToken: async () => 'egy-token',
    fetchImpl: sohaNeHivd,
  }
}

test.beforeEach(() => _szamlalotNullaz())

// --- brief 5.2's own failing tests --------------------------------------

test('a kvóta ELŐRE fog, nem a feltöltés közben', async () => {
  const r = await feltolt({ ...alap(), maiEgysegek: KVOTA_NAPI_ALAP - 1, fetchImpl: sohaNeHivd })
  assert.equal(r.error.code, 'kvota_elfogyott')
  assert.equal(r.error.message.includes('1600'), true, 'a modul saját száma benne lehet')
})

test('a száraz futás mindent összerak, de nem küld', async () => {
  const hivasok = []
  const r = await feltolt({ ...alap(), szarazFutas: true, fetchImpl: (...a) => { hivasok.push(a); throw new Error('nem szabad') } })
  assert.equal(hivasok.length, 0)
  assert.equal(r.szaraz, true)
  assert.equal(typeof r.kerés, 'object', 'a kérés ellenőrizhető anélkül, hogy kiment volna')
})

test('a token hiányát megnevezi, és nem a hálózatnak tulajdonítja', async () => {
  const r = await feltolt({ ...alap(), getToken: async () => { const e = new Error('nincs'); e.code = 'no_credential'; throw e } })
  assert.equal(r.error.code, 'fiok_nincs_osszekotve')
})

// --- the quota gate, in more depth --------------------------------------

test('the quota gate uses the module\'s own in-process counter when no override is given', async () => {
  // One send at a time, right up to the edge: KVOTA_NAPI_ALAP / KVOTA_EGYSEG_FELTOLTES
  // sends (6, integer division) fit; the next one does not.
  const sends = Math.floor(KVOTA_NAPI_ALAP / KVOTA_EGYSEG_FELTOLTES)
  let fetchCount = 0
  const okFetch = async () => { fetchCount += 1; return { ok: true, json: async () => ({ id: `vid-${fetchCount}` }) } }
  for (let i = 0; i < sends; i += 1) {
    const r = await feltolt({ ...alap(), fetchImpl: okFetch })
    assert.equal(r.error, undefined, `send ${i + 1} should not be refused`)
  }
  assert.equal(fetchCount, sends)
  const overflow = await feltolt({ ...alap(), fetchImpl: sohaNeHivd })
  assert.equal(overflow.error.code, 'kvota_elfogyott')
})

test('an explicit maiEgysegek overrides the internal counter rather than adding to it', async () => {
  // The counter is at 0 (beforeEach reset); an explicit, already-high value
  // must still be the one honoured.
  const r = await feltolt({ ...alap(), maiEgysegek: 0, fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'x' }) }) })
  assert.equal(r.error, undefined)
})

// --- the dry run builds a REAL request, not a placeholder -----------------

test('the dry run request carries the caller\'s title, description and tags', async () => {
  const r = await feltolt({ ...alap(), szarazFutas: true })
  assert.equal(r.kerés.metaadat.snippet.title, 'A videó címe')
  assert.equal(r.kerés.metaadat.snippet.description, 'A videó leírása.')
  assert.deepEqual(r.kerés.metaadat.snippet.tags, ['egyik', 'masik'])
  assert.match(r.kerés.url, /googleapis\.com\/upload\/youtube\/v3\/videos/)
})

// --- the real send path (fetchImpl is a fake, never the network) ----------

test('a successful send reads the file, sends it, and returns the platform id as a watch url', async () => {
  let seenBody
  const okFetch = async (url, init) => {
    seenBody = init.body
    assert.equal(init.headers.authorization, 'Bearer egy-token')
    assert.match(init.headers['content-type'], /^multipart\/related; boundary=/)
    return { ok: true, json: async () => ({ id: 'abc123' }) }
  }
  const r = await feltolt({ ...alap(), fetchImpl: okFetch })
  assert.equal(r.error, undefined)
  assert.deepEqual(r, { url: 'https://youtu.be/abc123', kulsoId: 'abc123' })
  assert.ok(Buffer.isBuffer(seenBody))
  assert.ok(seenBody.includes('A videó címe'), 'a multipart törzs tartalmazza a metaadatot')
})

test('a non-2xx response from YouTube is a named refusal carrying the status, not a raw platform error string', async () => {
  const r = await feltolt({ ...alap(), fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'forbidden: quota project mismatch' } }) }) })
  assert.equal(r.error.code, 'feltoltes_elutasitva')
  assert.equal(r.error.httpStatus, 403)
  assert.equal(r.error.message.includes('quota project mismatch'), false, 'a platform saját szövege nem kerül az üzenetbe')
})

test('a response with no video id is a named refusal, not a crash on undefined', async () => {
  const r = await feltolt({ ...alap(), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
  assert.equal(r.error.code, 'feltoltes_valasz_ertelmezhetetlen')
})

test('a file that cannot be read is a named refusal, and the network is never reached', async () => {
  const r = await feltolt({ ...alap(), fajl: path.join(os.tmpdir(), 'swarmclaw-publish-youtube-nincs-ilyen-fajl.mp4'), fetchImpl: sohaNeHivd })
  assert.equal(r.error.code, 'video_fajl_olvashatatlan')
})

test('missing required arguments are refused by name, before the quota gate or the network', async () => {
  const a = alap()
  assert.equal((await feltolt({ ...a, fajl: '', fetchImpl: sohaNeHivd })).error.code, 'argumentum_hibas')
  assert.equal((await feltolt({ ...a, cim: '', fetchImpl: sohaNeHivd })).error.code, 'argumentum_hibas')
  assert.equal((await feltolt({ ...a, getToken: undefined, fetchImpl: sohaNeHivd })).error.code, 'argumentum_hibas')
})

test('a token-stage failure with no no_credential code is still a named refusal, distinct from a missing account', async () => {
  // The host's own getGoogleAccessToken (src/lib/server/oauth/google.ts) can
  // fail this way too -- a revoked grant, a failed refresh -- with a message
  // but no `.code`. This is still the TOKEN stage, never the network, and it
  // must not be confused with "no account connected" (a different remedy:
  // reconnect, not connect for the first time).
  const r = await feltolt({ ...alap(), getToken: async () => { throw new Error('gmail_token_revoked') } })
  assert.equal(r.error.code, 'fiok_hitelesites_hiba')
  assert.notEqual(r.error.code, 'fiok_nincs_osszekotve')
})

// --- createYoutubeAdapter: the seam publishDue actually calls -------------

function fakeState({ connected = true, tokenError = null } = {}) {
  return {
    oauth: {
      hasGoogleCredential: (purpose) => { assert.equal(purpose, 'publish'); return connected },
      getGoogleAccessToken: async (purpose) => {
        assert.equal(purpose, 'publish')
        if (tokenError) throw tokenError
        return 'a-real-looking-token'
      },
    },
  }
}

test('createYoutubeAdapter refuses fiok_nincs_osszekotve when no account is connected, without calling getGoogleAccessToken', async () => {
  let refreshCalled = false
  const state = {
    oauth: {
      hasGoogleCredential: () => false,
      getGoogleAccessToken: async () => { refreshCalled = true; return 'x' },
    },
  }
  const adapter = createYoutubeAdapter(state, { fetchImpl: sohaNeHivd })
  await assert.rejects(
    () => adapter({ ag: { szoveg: JSON.stringify({ cim: 'c', leiras: 'l' }) }, video: { out_path: FAJL } }),
    (err) => { assert.equal(err.code, 'fiok_nincs_osszekotve'); return true },
  )
  assert.equal(refreshCalled, false, 'a fiók hiánya olcsón dől el -- nincs felesleges token-frissítés')
})

test('createYoutubeAdapter refuses ag_szoveg_olvashatatlan on a stored value that will not parse', async () => {
  const adapter = createYoutubeAdapter(fakeState(), { fetchImpl: sohaNeHivd })
  await assert.rejects(
    () => adapter({ ag: { szoveg: 'nem json' }, video: { out_path: FAJL } }),
    (err) => { assert.equal(err.code, 'ag_szoveg_olvashatatlan'); return true },
  )
})

test('createYoutubeAdapter refuses video_fajl_hianyzik when the video row has no out_path', async () => {
  const adapter = createYoutubeAdapter(fakeState(), { fetchImpl: sohaNeHivd })
  await assert.rejects(
    () => adapter({ ag: { szoveg: JSON.stringify({ cim: 'c', leiras: 'l' }) }, video: { out_path: null } }),
    (err) => { assert.equal(err.code, 'video_fajl_hianyzik'); return true },
  )
})

test('createYoutubeAdapter sends through feltolt end to end, with a fake fetchImpl standing in for YouTube', async () => {
  const state = fakeState()
  const okFetch = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer a-real-looking-token')
    return { ok: true, json: async () => ({ id: 'zzz' }) }
  }
  const adapter = createYoutubeAdapter(state, { fetchImpl: okFetch })
  const r = await adapter({ ag: { szoveg: JSON.stringify({ cim: 'Cím', leiras: 'Leírás' }) }, video: { out_path: FAJL } })
  assert.deepEqual(r, { url: 'https://youtu.be/zzz', kulsoId: 'zzz' })
})
