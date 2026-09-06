#!/usr/bin/env node
/**
 * Futó hoszt ellen mér, nem memóriában: ez a fájl arra a négy dologra kérdez
 * rá, amit egy zöld unit-teszt-futás után is el lehet rontani -- a build
 * kiszolgálására, az rpc bekötésére, a managed-resource reconcile lefutására
 * és a hibák nevesítésére.
 *
 * A hoszt ACCESS_KEY-vel védett telepítésen minden kérés x-access-key
 * fejlécet vár (src/proxy.ts ~270. sor: `process.env.ACCESS_KEY`, a fejléc
 * neve `x-access-key`). Enélkül minden ellenőrzés HTTP 401-gyel bukna, ami
 * pontosan úgy néz ki, mint egy törött extension -- pedig csak hitelesítés
 * hiányzik. Ez a szkript az ACCESS_KEY környezeti változóból olvassa a
 * kulcsot, ha az futtatáskor be van állítva, és ráteszi minden kérésre.
 */
const BASE = process.env.SWARMCLAW_BASE || 'http://127.0.0.1:3456'
const EXT = 'crm.mjs'
const ACCESS_KEY = process.env.ACCESS_KEY || ''
const AUTH_HEADERS = ACCESS_KEY ? { 'x-access-key': ACCESS_KEY } : {}
let bukott = 0

function ok(nev, felteves, reszlet = '', status) {
  if (felteves) { console.log(`  ok   ${nev}`); return }
  bukott += 1
  if (status === 401) {
    console.log(`  HITELESITES-HIBA ${nev} -- HTTP 401: a host ACCESS_KEY-t vár. Állítsd be az ` +
      `ACCESS_KEY környezeti változót ennek a szkriptnek is (ugyanazt az értéket, amit a hoszt kapott).`)
    return
  }
  console.log(`  BUKO ${nev}${reszlet ? ` -- ${reszlet}` : ''}`)
}

async function call(method, args = {}) {
  const res = await fetch(`${BASE}/api/extensions/${EXT}/call/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function get(url) {
  const res = await fetch(url, { headers: AUTH_HEADERS })
  return { status: res.status, res, body: await res.json().catch(() => null) }
}

console.log(`CRM telepítés-ellenőrzés: ${BASE}${ACCESS_KEY ? ' (ACCESS_KEY beállítva)' : ''}`)

// 1. A két épített fájl kiszolgálódik. Build nélküli telepítés esetén itt 404
//    jön, és az a hoszt felől megkülönböztethetetlen egy hibás telepítéstől.
for (const [nev, tipus] of [['index.js', 'javascript'], ['style.css', 'css']]) {
  const res = await fetch(`${BASE}/api/extensions/${EXT}/assets/${nev}`, { headers: AUTH_HEADERS })
  ok(`asset ${nev}`, res.ok && (res.headers.get('content-type') || '').includes(tipus),
     `HTTP ${res.status}, ${res.headers.get('content-type')}`, res.status)
}

// 2. Az rpc él, és a board üres adatbázison is a négy kulcsot adja.
{
  const { status, body } = await call('board')
  ok('rpc board', status === 200
    && Array.isArray(body?.accounts) && Array.isArray(body?.deals)
    && Array.isArray(body?.unmatched) && Array.isArray(body?.suggestions), `HTTP ${status}`, status)
}

// 3. A CRM projekt létrejött. EZ MÉRI A HOST-VÁLTOZTATÁST: ha a
//    managed-resource reconcile nem futott le, itt bukik, nem hónapok múlva.
{
  const { status, body } = await get(`${BASE}/api/projects`)
  const sorok = Array.isArray(body) ? body : Object.values(body?.projects || body || {})
  const crm = sorok.find((p) => p?.managedByExtension?.resourceKey === 'crm')
  ok('a CRM projekt létrejött', Boolean(crm), `${sorok.length} projekt, egyik sem crm`, status)
  ok('a projektet az extension birtokolja', crm?.managedByExtension?.extensionId === EXT,
     String(crm?.managedByExtension?.extensionId), status)
}

// 4. Az ismeretlen ügyfél nevesített hibát ad. Egy 500-as vagy egy üres válasz
//    ugyanúgy néz ki, mint egy elgépelt URL; egy név megmondja, mi történt.
{
  const { status, body } = await call('account', { accountId: 'acc_nincs' })
  ok('nevesített hiba ismeretlen ügyfélre', String(body?.error?.message || '').includes('crm_ismeretlen_ugyfel'),
     JSON.stringify(body), status)
}

// 5. mailboxHealth. EZ AZ EGYETLEN PONT, AMI A PINGELT SZERZŐDÉS-VERZIÓT, A
//    `consumes` deklarációt és az operátor tényleges engedélyét együtt méri:
//    egy verzió-eltérés vagy egy elfelejtett deklaráció itt csendben halott
//    modulként válaszolna, egyébként semmilyen más hívás nem venné észre. A
//    válasz alakja `{ available: true, address }` VAGY `{ available: false,
//    reason }` -- élő Gmail-hitelesítő nélkül a második ág a várt, ezért ez a
//    pont csak az alakot és a 200-as státuszt kéri számon, a `available`
//    tényleges értékét nem.
{
  const { status, body } = await call('mailboxHealth')
  const alakHelyes = typeof body?.available === 'boolean'
    && (body.available ? typeof body.address === 'string' : typeof body.reason === 'string')
  ok('mailboxHealth 200-at es ismert alakot ad', status === 200 && alakHelyes, JSON.stringify(body), status)
}

// 6. Az extension ténylegesen betöltve fut -- nem csak a fájlrendszeren van,
//    hanem a hoszt is engedélyezettként és hiba nélkül tartja számon. Egy
//    olyan migráció, ami az operátor feltöltött adatbázisán elhasal, itt
//    látszik, nem egy üres lapon.
{
  const { status, body } = await get(`${BASE}/api/extensions`)
  const lista = Array.isArray(body) ? body : []
  const crmBejegyzes = lista.find((e) => e?.filename === EXT)
  ok('a CRM extension szerepel a listaban', Boolean(crmBejegyzes), `${lista.length} extension, egyik sem ${EXT}`, status)
  ok('a CRM extension engedelyezett', crmBejegyzes?.enabled === true, JSON.stringify(crmBejegyzes), status)
  ok('a CRM extensionnek nincs betoltesi hibaja', !crmBejegyzes?.lastFailureError, String(crmBejegyzes?.lastFailureError), status)
}

// 7. contactsForPicker -- a hozzárendelő választója tömböt ad, éles
//    adatbázison is (üresen vagy sorokkal, de sosem hibával vagy objektummal).
{
  const { status, body } = await call('contactsForPicker')
  ok('contactsForPicker tombot ad', status === 200 && Array.isArray(body), JSON.stringify(body), status)
}

// 8. Az MCP-híd HTTP fölött. A `mcpTools` a `crm_*` eszközöket adja vissza,
//    a `mcpCall` egy ismeretlen tool-névre NEVESÍTETT HIBÁT ad ÉRTÉKKÉNT --
//    nem 500-at --, mert egy 500 az ügynöknek úgy néz ki, mintha az extension
//    törött lenne, egy elgépelt eszköznév helyett.
{
  const { status, body } = await call('mcpTools')
  const nevek = Array.isArray(body?.tools) ? body.tools.map((t) => t?.name) : []
  ok('mcpTools crm_ eszkozoket ad', status === 200 && nevek.some((n) => String(n || '').startsWith('crm_')),
     JSON.stringify(nevek), status)
}
{
  const { status, body } = await call('mcpCall', { tool: 'crm_nincs_ilyen_eszkoz' })
  ok('mcpCall ismeretlen tool-ra nevesitett hibat ad ertekkent, nem 500-at',
     status === 200 && body?.error?.code === 'mcp_ismeretlen_tool', JSON.stringify(body), status)
}

console.log(bukott === 0 ? 'MIND ZOLD' : `${bukott} pont bukott`)
process.exit(bukott === 0 ? 0 : 1)
