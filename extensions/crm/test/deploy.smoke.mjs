#!/usr/bin/env node
/**
 * Futó hoszt ellen mér, nem memóriában: ez a fájl arra a négy dologra kérdez
 * rá, amit egy zöld unit-teszt-futás után is el lehet rontani -- a build
 * kiszolgálására, az rpc bekötésére, a managed-resource reconcile lefutására
 * és a hibák nevesítésére.
 */
const BASE = process.env.SWARMCLAW_BASE || 'http://127.0.0.1:3456'
const EXT = 'crm.mjs'
let bukott = 0

function ok(nev, felteves, reszlet = '') {
  if (felteves) { console.log(`  ok   ${nev}`); return }
  bukott += 1
  console.log(`  BUKO ${nev}${reszlet ? ` -- ${reszlet}` : ''}`)
}

async function call(method, args = {}) {
  const res = await fetch(`${BASE}/api/extensions/${EXT}/call/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

console.log(`CRM telepítés-ellenőrzés: ${BASE}`)

// 1. A két épített fájl kiszolgálódik. Build nélküli telepítés esetén itt 404
//    jön, és az a hoszt felől megkülönböztethetetlen egy hibás telepítéstől.
for (const [nev, tipus] of [['index.js', 'javascript'], ['style.css', 'css']]) {
  const res = await fetch(`${BASE}/api/extensions/${EXT}/assets/${nev}`)
  ok(`asset ${nev}`, res.ok && (res.headers.get('content-type') || '').includes(tipus),
     `HTTP ${res.status}, ${res.headers.get('content-type')}`)
}

// 2. Az rpc él, és a board üres adatbázison is a négy kulcsot adja.
{
  const { status, body } = await call('board')
  ok('rpc board', status === 200
    && Array.isArray(body?.accounts) && Array.isArray(body?.deals)
    && Array.isArray(body?.unmatched) && Array.isArray(body?.suggestions), `HTTP ${status}`)
}

// 3. A CRM projekt létrejött. EZ MÉRI A HOST-VÁLTOZTATÁST: ha a
//    managed-resource reconcile nem futott le, itt bukik, nem hónapok múlva.
{
  const res = await fetch(`${BASE}/api/projects`)
  const body = await res.json().catch(() => null)
  const sorok = Array.isArray(body) ? body : Object.values(body?.projects || body || {})
  const crm = sorok.find((p) => p?.managedByExtension?.resourceKey === 'crm')
  ok('a CRM projekt létrejött', Boolean(crm), `${sorok.length} projekt, egyik sem crm`)
  ok('a projektet az extension birtokolja', crm?.managedByExtension?.extensionId === EXT,
     String(crm?.managedByExtension?.extensionId))
}

// 4. Az ismeretlen ügyfél nevesített hibát ad. Egy 500-as vagy egy üres válasz
//    ugyanúgy néz ki, mint egy elgépelt URL; egy név megmondja, mi történt.
{
  const { body } = await call('account', { accountId: 'acc_nincs' })
  ok('nevesített hiba ismeretlen ügyfélre', String(body?.error || '').includes('crm_ismeretlen_ugyfel'),
     JSON.stringify(body))
}

console.log(bukott === 0 ? 'MIND ZOLD' : `${bukott} pont bukott`)
process.exit(bukott === 0 ? 0 : 1)
