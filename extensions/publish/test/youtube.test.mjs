import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ALAP_LATHATOSAG,
  FELTOLTES_IDOTULLEPES_MS,
  KVOTA_EGYSEG_FELTOLTES,
  KVOTA_NAPI_ALAP,
  LATHATOSAGOK,
  SZARAZ_BAJTOK,
  SZARAZ_HOSSZ,
  SZARAZ_MUNKAMENET_URL,
  SZARAZ_TOKEN,
  _szamlalotNullaz,
  createYoutubeAdapter,
  feltolt,
  gyerekeknekOf,
  lathatosagOf,
} from '../src/platform/youtube.mjs'

/**
 * The YouTube adapter's own suite. Every test injects `fetchImpl`;
 * `sohaNeHivd` is handed to the ones that must never reach it at all, so a
 * mutation that moved the quota gate or the dry-run return past the fetch
 * call fails loudly instead of quietly making a network request the test
 * runner cannot see. `sohaNeKerjToken` does the same job one stage earlier:
 * `getToken` is itself a round trip to Google's token endpoint, so "the
 * quota gate refuses before the network" is only true if it also refuses
 * before that.
 *
 * `alap()` supplies a real, small file on disk, and it supplies BOTH operator
 * decisions (`lathatosag`, `gyerekeknekKeszult`) explicitly, because the
 * module has no default for the second one on purpose -- a fixture that
 * silently filled it in would hide the refusal that is the whole point of
 * that field.
 */

const FAJL = path.join(os.tmpdir(), 'swarmclaw-publish-youtube-test.mp4')
const FAJL_TARTALOM = 'nem valódi videó, csak a fájl-olvasás teszteléséhez'
fs.writeFileSync(FAJL, FAJL_TARTALOM)
const FAJL_MERET = fs.statSync(FAJL).size

const MUNKAMENET_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=teszt-session'

const sohaNeHivd = async (...args) => {
  throw new Error(`fetchImpl-t nem szabad hívni ezen az úton (${args[0]})`)
}

const sohaNeKerjToken = async () => {
  throw new Error('getToken-t nem szabad hívni ezen az úton')
}

function alap() {
  return {
    fajl: FAJL,
    cim: 'A videó címe',
    leiras: 'A videó leírása.',
    cimkek: ['egyik', 'masik'],
    getToken: async () => 'egy-token',
    fetchImpl: sohaNeHivd,
    gyerekeknekKeszult: false,
  }
}

/** A response's headers, in the one shape this module reads them through (`headers.get`). */
function fejlecek(obj) {
  return { get: (nev) => obj[String(nev).toLowerCase()] ?? null }
}

function munkamenetValasz({ ok = true, status = 200, location = MUNKAMENET_URL } = {}) {
  return { ok, status, headers: fejlecek(location === null ? {} : { location }), json: async () => ({}) }
}

function bajtValasz({ ok = true, status = 200, id = 'abc123', json } = {}) {
  return { ok, status, headers: fejlecek({}), json: json ?? (async () => (id === null ? {} : { id })) }
}

/**
 * A two-phase YouTube stand-in: the session request first, the bytes second,
 * both recorded. Nothing here reaches the network, and the recorded calls are
 * what every resumable-upload test below asserts against.
 */
function ketFazis({ munkamenet, bajtok } = {}) {
  const hivasok = []
  const fetchImpl = async (url, init) => {
    hivasok.push({ url, init })
    if (hivasok.length === 1) return munkamenet ?? munkamenetValasz()
    return bajtok ?? bajtValasz()
  }
  return { hivasok, fetchImpl }
}

/** The body a request actually carried, as text -- a `ReadableStream` on the real path, so it is read the way `fetch` itself would. */
async function torzsSzoveg(body) {
  if (typeof body === 'string') return body
  return new Response(body).text()
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

// --- D8: the visibility is the operator's choice, private until they make it

test('D8: with no visibility given the request goes out PRIVATE, on both the dry and the real path', async () => {
  // The default is the safe half of the one irreversible step in the chain.
  // Hardcoding `privacyStatus: 'public'` back into the status block fails the
  // dry assertion; hardcoding anything at all fails the `public` test below.
  const szaraz = await feltolt({ ...alap(), szarazFutas: true })
  assert.equal(szaraz.kerés.metaadat.status.privacyStatus, 'private')
  assert.equal(JSON.parse(szaraz.kerés.munkamenet.body).status.privacyStatus, 'private')

  const { hivasok, fetchImpl } = ketFazis()
  const r = await feltolt({ ...alap(), fetchImpl })
  assert.equal(r.error, undefined)
  assert.equal(JSON.parse(hivasok[0].init.body).status.privacyStatus, 'private')
})

test('D8: an operator who chose public gets public -- the module does not clamp it back down', async () => {
  const { hivasok, fetchImpl } = ketFazis()
  const r = await feltolt({ ...alap(), lathatosag: 'public', fetchImpl })
  assert.equal(r.error, undefined)
  assert.equal(JSON.parse(hivasok[0].init.body).status.privacyStatus, 'public')
})

test('D8: unlisted is a real choice too, and all three values are the ones YouTube accepts', async () => {
  const { hivasok, fetchImpl } = ketFazis()
  await feltolt({ ...alap(), lathatosag: 'unlisted', fetchImpl })
  assert.equal(JSON.parse(hivasok[0].init.body).status.privacyStatus, 'unlisted')
  assert.deepEqual([...LATHATOSAGOK], ['private', 'unlisted', 'public'])
  assert.equal(ALAP_LATHATOSAG, 'private')
})

test('D8: a visibility value outside the three is a named refusal, not a quietly corrected one', async () => {
  // Quietly folding an unrecognised setting into `private` would hide a typo
  // the operator believes means `public`; folding it into `public` would be
  // the irreversible step taken by accident.
  const r = await feltolt({ ...alap(), lathatosag: 'nyilvanos', fetchImpl: sohaNeHivd, getToken: sohaNeKerjToken })
  assert.equal(r.error.code, 'lathatosag_ervenytelen')
  assert.equal(r.error.message.includes('nyilvanos'), false, 'a hívó saját értéke nem kerül vissza az üzenetbe')
})

test('D8: lathatosagOf falls back to private for a missing, blank or non-object settings value', () => {
  assert.equal(lathatosagOf(undefined), 'private')
  assert.equal(lathatosagOf(null), 'private')
  assert.equal(lathatosagOf({}), 'private')
  assert.equal(lathatosagOf({ lathatosag: '' }), 'private')
  assert.equal(lathatosagOf({ lathatosag: '   ' }), 'private')
  assert.equal(lathatosagOf({ lathatosag: 'public' }), 'public')
  // Passed through, NOT corrected -- `feltolt` is what refuses it by name.
  assert.equal(lathatosagOf({ lathatosag: 'nyilvanos' }), 'nyilvanos')
})

// --- D9: the COPPA declaration is the operator's, and has no default -------

test('D9: with no declaration the upload refuses BY NAME, and never reaches the token or the network', async () => {
  const a = alap()
  delete a.gyerekeknekKeszult
  const r = await feltolt({ ...a, fetchImpl: sohaNeHivd, getToken: sohaNeKerjToken })
  assert.equal(r.error.code, 'gyerekeknek_nincs_beallitva')
  assert.match(r.error.message, /Gyerekeknek készült tartalom/, 'a mondat arra a mezőre mutat, amit be kell állítani')
})

test('D9: the declaration is missing on the DRY path too -- a request whose status block cannot be built is not inspectable', async () => {
  const a = alap()
  delete a.gyerekeknekKeszult
  const r = await feltolt({ ...a, szarazFutas: true, fetchImpl: sohaNeHivd })
  assert.equal(r.error.code, 'gyerekeknek_nincs_beallitva')
})

test('D9: a non-boolean declaration is refused -- the settings string is not the fact', async () => {
  // `gyerekeknekOf` turns the stored word into a boolean or into null; anything
  // that reaches `feltolt` still as a string is a caller that skipped that
  // step, and "nem" is exactly the value that would look right and mean
  // nothing.
  for (const ertek of ['nem', 'igen', 'false', 0, 1, null]) {
    const r = await feltolt({ ...alap(), gyerekeknekKeszult: ertek, fetchImpl: sohaNeHivd, getToken: sohaNeKerjToken })
    assert.equal(r.error.code, 'gyerekeknek_nincs_beallitva', `${String(ertek)} nem nyilatkozat`)
  }
})

test('D9: a declared false goes out as false, and a declared true goes out as true', async () => {
  // Both directions, because ONE of them is the value a hardcoded literal
  // would happen to match. Inverting the status block to
  // `selfDeclaredMadeForKids: true` fails the first half; leaving it at
  // `false` fails the second.
  const nem = ketFazis()
  await feltolt({ ...alap(), gyerekeknekKeszult: false, fetchImpl: nem.fetchImpl })
  assert.equal(JSON.parse(nem.hivasok[0].init.body).status.selfDeclaredMadeForKids, false)

  const igen = ketFazis()
  await feltolt({ ...alap(), gyerekeknekKeszult: true, fetchImpl: igen.fetchImpl })
  assert.equal(JSON.parse(igen.hivasok[0].init.body).status.selfDeclaredMadeForKids, true)
})

test('D9: gyerekeknekOf answers null for "not said", and never false', () => {
  assert.equal(gyerekeknekOf({ gyerekeknek: 'igen' }), true)
  assert.equal(gyerekeknekOf({ gyerekeknek: 'nem' }), false)
  // Every one of these is "the operator has not declared", which is a
  // different fact from a declaration of "no".
  for (const beallitas of [undefined, null, {}, { gyerekeknek: '' }, { gyerekeknek: 'talan' }, { gyerekeknek: false }, { gyerekeknek: true }]) {
    assert.equal(gyerekeknekOf(beallitas), null, JSON.stringify(beallitas ?? null))
  }
})

// --- the quota gate, in more depth --------------------------------------

test('the published quota numbers are the ones this module refuses from', () => {
  // Documentation, not measurement (the file docblock says so), and unpinned
  // they are two literals nothing would notice changing: raising
  // KVOTA_NAPI_ALAP to 100000 would silently let this module attempt sixty
  // uploads a day against a quota that stops at six.
  assert.equal(KVOTA_EGYSEG_FELTOLTES, 1600)
  assert.equal(KVOTA_NAPI_ALAP, 10000)
})

test('exactly six uploads fit in a day, and the seventh is refused before it is attempted', async () => {
  // The literal six, not `Math.floor(ALAP / EGYSEG)`: a count derived from the
  // constants moves with them and would agree with any pair of numbers at all.
  let fetchCount = 0
  const okFetch = async (url, init) => {
    fetchCount += 1
    return init.method === 'POST' ? munkamenetValasz() : bajtValasz({ id: `vid-${fetchCount}` })
  }
  for (let i = 0; i < 6; i += 1) {
    const r = await feltolt({ ...alap(), fetchImpl: okFetch })
    assert.equal(r.error, undefined, `a(z) ${i + 1}. feltöltés még belefér`)
  }
  const overflow = await feltolt({ ...alap(), fetchImpl: sohaNeHivd, getToken: sohaNeKerjToken })
  assert.equal(overflow.error.code, 'kvota_elfogyott')
})

test('the quota gate fires BEFORE getToken, which is itself a round trip to Google', async () => {
  let tokenKert = false
  const r = await feltolt({
    ...alap(),
    maiEgysegek: KVOTA_NAPI_ALAP,
    getToken: async () => { tokenKert = true; return 'x' },
    fetchImpl: sohaNeHivd,
  })
  assert.equal(r.error.code, 'kvota_elfogyott')
  assert.equal(tokenKert, false, 'egy modul, ami már eldöntötte hogy nem küld, ne költsön token-kört sem')
})

test('an explicit maiEgysegek REPLACES the internal counter -- the restrictive direction', async () => {
  // Counter is at 0 (beforeEach). An override that says the day is spent must
  // win: ignoring it and reading the counter instead would let this through.
  const r = await feltolt({ ...alap(), maiEgysegek: KVOTA_NAPI_ALAP, fetchImpl: sohaNeHivd, getToken: sohaNeKerjToken })
  assert.equal(r.error.code, 'kvota_elfogyott')
})

test('an explicit maiEgysegek REPLACES the internal counter -- the permissive direction', async () => {
  // Spend the whole in-process day first, then override it back to zero. If
  // the override were ignored (or added to the counter), this send is refused.
  const okFetch = async (url, init) => (init.method === 'POST' ? munkamenetValasz() : bajtValasz())
  for (let i = 0; i < 6; i += 1) await feltolt({ ...alap(), fetchImpl: okFetch })
  assert.equal((await feltolt({ ...alap(), fetchImpl: sohaNeHivd, getToken: sohaNeKerjToken })).error.code, 'kvota_elfogyott')

  const r = await feltolt({ ...alap(), maiEgysegek: 0, fetchImpl: okFetch })
  assert.equal(r.error, undefined, 'a felülírás a belső számláló HELYETT szól, nem mellette')
})

test('a rejected upload still costs quota -- YouTube charges the insert call it turned down', async () => {
  // Booking only on success lets a run of 4xx answers hammer past the real
  // daily limit while this module's own gate still thinks there is room.
  const elutasit = async () => munkamenetValasz({ ok: false, status: 403 })
  for (let i = 0; i < 6; i += 1) {
    const r = await feltolt({ ...alap(), fetchImpl: elutasit })
    assert.equal(r.error.code, 'feltoltes_elutasitva')
  }
  const r = await feltolt({ ...alap(), fetchImpl: sohaNeHivd, getToken: sohaNeKerjToken })
  assert.equal(r.error.code, 'kvota_elfogyott', 'hat elutasított hívás is elköltötte a napi keretet')
})

// --- D10: the resumable upload ------------------------------------------

test('D10: the upload is TWO requests -- a JSON session request, then the bytes to the session URL', async () => {
  const { hivasok, fetchImpl } = ketFazis()
  const r = await feltolt({ ...alap(), fetchImpl })
  assert.deepEqual(r, { url: 'https://youtu.be/abc123', kulsoId: 'abc123' })
  assert.equal(hivasok.length, 2)

  const [munkamenet, bajtok] = hivasok
  assert.match(munkamenet.url, /uploadType=resumable/)
  assert.equal(munkamenet.init.method, 'POST')
  assert.equal(munkamenet.init.headers.authorization, 'Bearer egy-token')
  assert.equal(munkamenet.init.headers['content-type'], 'application/json; charset=UTF-8')
  assert.equal(munkamenet.init.headers['x-upload-content-type'], 'video/*')
  assert.equal(munkamenet.init.headers['x-upload-content-length'], String(FAJL_MERET))
  assert.equal(JSON.parse(munkamenet.init.body).snippet.title, 'A videó címe')

  assert.equal(bajtok.url, MUNKAMENET_URL, 'a bájtok arra az URL-re mennek, amit a YouTube adott vissza')
  assert.equal(bajtok.init.method, 'PUT')
  assert.equal(bajtok.init.headers['content-type'], 'video/*')
  assert.equal(bajtok.init.headers['content-length'], String(FAJL_MERET))
})

test('D10: the bytes are STREAMED -- the file is never read into a buffer, and multipart is gone', async () => {
  // The old shape was `fs.readFileSync` + `Buffer.concat`: a synchronous read
  // that stops the host's whole event loop for the length of a real render and
  // then holds roughly twice the file in memory. A body that is a Buffer here
  // means that came back.
  const { hivasok, fetchImpl } = ketFazis()
  await feltolt({ ...alap(), fetchImpl })
  const body = hivasok[1].init.body
  assert.equal(Buffer.isBuffer(body), false, 'a bájtok nem pufferként mennek ki')
  assert.equal(typeof body.getReader, 'function', 'a törzs egy olvasható folyam')
  assert.equal(await torzsSzoveg(body), FAJL_TARTALOM, 'és a folyamon a fájl valódi bájtjai jönnek')
  // Nothing multipart survives: no boundary, no glued-together metadata.
  assert.equal(String(hivasok[0].init.headers['content-type']).includes('multipart'), false)
})

test('D10: a session request the platform turns down never sends the bytes', async () => {
  const { hivasok, fetchImpl } = ketFazis({ munkamenet: munkamenetValasz({ ok: false, status: 403 }) })
  const r = await feltolt({ ...alap(), fetchImpl })
  assert.equal(r.error.code, 'feltoltes_elutasitva')
  assert.equal(r.error.httpStatus, 403)
  assert.equal(hivasok.length, 1, 'a videó bájtjai nem indulnak el egy elutasított munkamenetbe')
})

test('D10: a session response with no Location header is a named refusal, not a PUT to undefined', async () => {
  const { hivasok, fetchImpl } = ketFazis({ munkamenet: munkamenetValasz({ location: null }) })
  const r = await feltolt({ ...alap(), fetchImpl })
  assert.equal(r.error.code, 'feltoltes_valasz_ertelmezhetetlen')
  assert.equal(hivasok.length, 1)
})

test('D10: a rejected BYTE request is named with its own status, not folded into the session one', async () => {
  const { hivasok, fetchImpl } = ketFazis({ bajtok: bajtValasz({ ok: false, status: 500 }) })
  const r = await feltolt({ ...alap(), fetchImpl })
  assert.equal(r.error.code, 'feltoltes_elutasitva')
  assert.equal(r.error.httpStatus, 500)
  assert.equal(hivasok.length, 2)
})

test('D10: the file size comes from stat, and a file that is not there refuses before either request', async () => {
  const { hivasok, fetchImpl } = ketFazis()
  const r = await feltolt({ ...alap(), fajl: path.join(os.tmpdir(), 'swarmclaw-publish-youtube-nincs-ilyen-fajl.mp4'), fetchImpl })
  assert.equal(r.error.code, 'video_fajl_olvashatatlan')
  assert.equal(hivasok.length, 0)
})

// --- D11: the dry run builds the headers and the framing too ---------------

test('D11: the dry run returns BOTH requests, with the same headers the real send builds', async () => {
  // The dry run is the only way Facebook, Instagram and TikTok will be looked
  // at for weeks, and they will copy this shape. Building the headers and the
  // body framing AFTER the dry return -- where they used to be -- means the
  // two parts most likely to be wrong are the two parts never inspected.
  const szaraz = await feltolt({ ...alap(), szarazFutas: true })
  const { hivasok, fetchImpl } = ketFazis()
  await feltolt({ ...alap(), fetchImpl })

  assert.deepEqual(
    Object.keys(szaraz.kerés.munkamenet.headers).sort(),
    Object.keys(hivasok[0].init.headers).sort(),
    'a száraz munkamenet-kérés ugyanazokat a fejléceket építi, mint az éles',
  )
  assert.deepEqual(
    Object.keys(szaraz.kerés.bajtok.headers).sort(),
    Object.keys(hivasok[1].init.headers).sort(),
    'és ugyanazokat a bájt-kérésen is',
  )
  assert.equal(szaraz.kerés.munkamenet.method, hivasok[0].init.method)
  assert.equal(szaraz.kerés.bajtok.method, hivasok[1].init.method)
  assert.equal(szaraz.kerés.munkamenet.headers['content-type'], hivasok[0].init.headers['content-type'])
  assert.equal(szaraz.kerés.munkamenet.headers['x-upload-content-type'], hivasok[1].init.headers['content-type'])
  assert.equal(szaraz.kerés.bajtok.headers['content-type'], hivasok[1].init.headers['content-type'])
  // The framing itself, not just the metadata object: the JSON body is what
  // actually goes on the wire.
  assert.equal(szaraz.kerés.munkamenet.body, hivasok[0].init.body)
})

test('D11: the four values a dry run cannot know are named placeholders, not empty strings or zeroes', async () => {
  const szaraz = await feltolt({ ...alap(), szarazFutas: true })
  assert.equal(szaraz.kerés.munkamenet.headers.authorization, `Bearer ${SZARAZ_TOKEN}`)
  assert.equal(szaraz.kerés.munkamenet.headers['x-upload-content-length'], SZARAZ_HOSSZ)
  assert.equal(szaraz.kerés.bajtok.url, SZARAZ_MUNKAMENET_URL)
  assert.equal(szaraz.kerés.bajtok.headers['content-length'], SZARAZ_HOSSZ)
  assert.equal(szaraz.kerés.bajtok.body, SZARAZ_BAJTOK)
  // An operator has to be able to tell "the header is built wrong" from "this
  // value only exists once there is an account and a file".
  for (const helyorzo of [SZARAZ_TOKEN, SZARAZ_HOSSZ, SZARAZ_MUNKAMENET_URL, SZARAZ_BAJTOK]) {
    assert.match(helyorzo, /^<.+>$/)
  }
})

test('the dry run request carries the caller\'s title, description and tags', async () => {
  const r = await feltolt({ ...alap(), szarazFutas: true })
  assert.equal(r.kerés.metaadat.snippet.title, 'A videó címe')
  assert.equal(r.kerés.metaadat.snippet.description, 'A videó leírása.')
  assert.deepEqual(r.kerés.metaadat.snippet.tags, ['egyik', 'masik'])
  assert.match(r.kerés.url, /googleapis\.com\/upload\/youtube\/v3\/videos/)
  assert.equal(r.kerés.fajl, FAJL)
})

// --- the timeout, and the two transport facts it is one half of ------------

test('the attempt bound is minutes, not milliseconds: a slow but working upload is not aborted', async () => {
  // A real render over a slow connection takes a while; the bound exists for a
  // WEDGED connection. Shrinking FELTOLTES_IDOTULLEPES_MS to 10 ms aborts this
  // perfectly healthy send.
  // The fake HONOURS the abort signal, the way a real `fetch` does -- one
  // that ignored it would sail through any timeout at all and this test would
  // prove nothing.
  const lassu = (url, init) => new Promise((resolve, reject) => {
    const ora = setTimeout(() => resolve(init.method === 'POST' ? munkamenetValasz() : bajtValasz()), 40)
    init.signal.addEventListener('abort', () => {
      clearTimeout(ora)
      const e = new Error('aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })
  const r = await feltolt({ ...alap(), fetchImpl: lassu })
  assert.equal(r.error, undefined)
})

test('the attempt bound sits between "a real file has time" and "the next dispatch tick is not held open"', () => {
  // The two facts the docblock states, as two inequalities: below a minute is
  // not enough for a video file, and at or above the 15-minute dispatch
  // cadence (index.mjs's SCHEDULES) a wedged upload holds the tick open past
  // its own next run.
  assert.ok(FELTOLTES_IDOTULLEPES_MS >= 60 * 1000, 'egy valódi videófájlnak legyen ideje')
  assert.ok(FELTOLTES_IDOTULLEPES_MS < 15 * 60 * 1000, 'egy beragadt feltöltés ne tartsa nyitva a következő tickig')
})

test('a timeout and a broken connection are two different facts with two different codes', async () => {
  // Deleting the distinction so both report one code passes every other test
  // in this file: the remedy differs (wait for the next tick versus look at
  // the network), so the code has to.
  const beragad = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })
  const ido = await feltolt({ ...alap(), fetchImpl: beragad, idotullepesMs: 5 })
  assert.equal(ido.error.code, 'feltoltes_idotullepes')

  const szakad = async () => { throw new Error('ECONNRESET') }
  const atvitel = await feltolt({ ...alap(), fetchImpl: szakad })
  assert.equal(atvitel.error.code, 'feltoltes_atviteli_hiba')
})

test('a timeout during the BYTE phase is still a timeout, not a transfer error', async () => {
  const felutonBeragad = (url, init) => {
    if (init.method === 'POST') return Promise.resolve(munkamenetValasz())
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })
  }
  const r = await feltolt({ ...alap(), fetchImpl: felutonBeragad, idotullepesMs: 20 })
  assert.equal(r.error.code, 'feltoltes_idotullepes')
})

// --- the rest of the named refusals ---------------------------------------

test('a response with no video id is a named refusal, not a crash on undefined', async () => {
  const { fetchImpl } = ketFazis({ bajtok: bajtValasz({ id: null }) })
  const r = await feltolt({ ...alap(), fetchImpl })
  assert.equal(r.error.code, 'feltoltes_valasz_ertelmezhetetlen')
})

test('a response body that is not JSON is a named refusal', async () => {
  const { fetchImpl } = ketFazis({ bajtok: bajtValasz({ json: async () => { throw new SyntaxError('nem json') } }) })
  const r = await feltolt({ ...alap(), fetchImpl })
  assert.equal(r.error.code, 'feltoltes_valasz_ertelmezhetetlen')
})

test('the platform\'s own error text never reaches the refusal message', async () => {
  const { fetchImpl } = ketFazis({ munkamenet: { ok: false, status: 403, headers: fejlecek({}), json: async () => ({ error: { message: 'forbidden: quota project mismatch' } }) } })
  const r = await feltolt({ ...alap(), fetchImpl })
  assert.equal(r.error.code, 'feltoltes_elutasitva')
  assert.equal(r.error.httpStatus, 403)
  assert.equal(r.error.message.includes('quota project mismatch'), false, 'a platform saját szövege nem kerül az üzenetbe')
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

function fakeState({ connected = true, tokenError = null, beallitasok = { gyerekeknek: 'nem' } } = {}) {
  return {
    settings: () => beallitasok,
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

const AG = { szoveg: JSON.stringify({ cim: 'Cím', leiras: 'Leírás' }) }

test('createYoutubeAdapter refuses fiok_nincs_osszekotve when no account is connected, without calling getGoogleAccessToken', async () => {
  let refreshCalled = false
  const state = {
    settings: () => ({ gyerekeknek: 'nem' }),
    oauth: {
      hasGoogleCredential: () => false,
      getGoogleAccessToken: async () => { refreshCalled = true; return 'x' },
    },
  }
  const adapter = createYoutubeAdapter(state, { fetchImpl: sohaNeHivd })
  await assert.rejects(
    () => adapter({ ag: AG, video: { out_path: FAJL } }),
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

test('createYoutubeAdapter refuses ag_szoveg_olvashatatlan on a value that PARSES but is not the stored object', async () => {
  // JSON.parse only throws on syntactic rubbish. The szoveg column is
  // nullable and publishOpen already models a branch with no text
  // (`vanSzoveg: false`), so `null` -- the JSON null, and the SQL one -- and
  // every other non-object parse straight through and then throw a bare
  // TypeError on `.cim`: no `.code`, which publishDue reports as the unnamed
  // `kikuldes_hiba` fallback this guard exists to prevent.
  const adapter = createYoutubeAdapter(fakeState(), { fetchImpl: sohaNeHivd })
  for (const szoveg of ['null', null, '123', '"x"', '[]', '[{"cim":"c"}]', 'true']) {
    await assert.rejects(
      () => adapter({ ag: { szoveg }, video: { out_path: FAJL } }),
      (err) => { assert.equal(err.code, 'ag_szoveg_olvashatatlan', `szoveg=${String(szoveg)}`); return true },
      `szoveg=${String(szoveg)}`,
    )
  }
})

test('createYoutubeAdapter refuses video_fajl_hianyzik when the video row has no out_path', async () => {
  const adapter = createYoutubeAdapter(fakeState(), { fetchImpl: sohaNeHivd })
  await assert.rejects(
    () => adapter({ ag: AG, video: { out_path: null } }),
    (err) => { assert.equal(err.code, 'video_fajl_hianyzik'); return true },
  )
})

test('createYoutubeAdapter sends through feltolt end to end, with a fake fetchImpl standing in for YouTube', async () => {
  const { hivasok, fetchImpl } = ketFazis()
  const adapter = createYoutubeAdapter(fakeState(), { fetchImpl })
  const r = await adapter({ ag: AG, video: { out_path: FAJL } })
  assert.deepEqual(r, { url: 'https://youtu.be/abc123', kulsoId: 'abc123' })
  assert.equal(hivasok[0].init.headers.authorization, 'Bearer a-real-looking-token')
})

test('createYoutubeAdapter carries the operator\'s two settings onto the request, read at CALL time', async () => {
  // Read from `state.settings()` when the adapter runs, not when it is built:
  // an operator who sets the COPPA field between two dispatch ticks must not
  // have to reload the extension.
  const beallitasok = { gyerekeknek: 'nem', lathatosag: 'private' }
  const state = fakeState({ beallitasok })
  const { hivasok, fetchImpl } = ketFazis()
  const adapter = createYoutubeAdapter(state, { fetchImpl })

  await adapter({ ag: AG, video: { out_path: FAJL } })
  let status = JSON.parse(hivasok[0].init.body).status
  assert.deepEqual(status, { privacyStatus: 'private', selfDeclaredMadeForKids: false })

  beallitasok.lathatosag = 'public'
  beallitasok.gyerekeknek = 'igen'
  const masodik = ketFazis()
  const adapter2 = createYoutubeAdapter(state, { fetchImpl: masodik.fetchImpl })
  await adapter2({ ag: AG, video: { out_path: FAJL } })
  status = JSON.parse(masodik.hivasok[0].init.body).status
  assert.deepEqual(status, { privacyStatus: 'public', selfDeclaredMadeForKids: true })
})

test('createYoutubeAdapter refuses gyerekeknek_nincs_beallitva until the operator has declared, and publishDue sees that name', async () => {
  const adapter = createYoutubeAdapter(fakeState({ beallitasok: {} }), { fetchImpl: sohaNeHivd })
  await assert.rejects(
    () => adapter({ ag: AG, video: { out_path: FAJL } }),
    (err) => {
      // publishDue reads `err.code`; a refusal without one lands as the
      // unnamed `kikuldes_hiba`.
      assert.equal(err.code, 'gyerekeknek_nincs_beallitva')
      return true
    },
  )
})

test('createYoutubeAdapter survives a state with no settings function at all', async () => {
  // `state.settings` is a function from index.mjs's own default onward, but an
  // adapter built before setup() ran must refuse by name rather than crash on
  // `state.settings()`.
  const adapter = createYoutubeAdapter({ settings: null, oauth: fakeState().oauth }, { fetchImpl: sohaNeHivd })
  await assert.rejects(
    () => adapter({ ag: AG, video: { out_path: FAJL } }),
    (err) => { assert.equal(err.code, 'gyerekeknek_nincs_beallitva'); return true },
  )
})
