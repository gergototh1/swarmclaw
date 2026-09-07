#!/usr/bin/env node
/**
 * Futó hoszt ellen mér, nem memóriában: ez a fájl arra kérdez rá, amit egy zöld
 * unit-teszt-futás után is el lehet rontani -- a build kiszolgálására, az rpc
 * bekötésére, a managed-resource reconcile lefutására (projekt, ügynök,
 * ütemezés), a hibák nevesítésére, és a javaslat-elfogadás teljes körére a
 * hoszt valódi feladat-tábláján.
 *
 * AZ UTOLSÓ AZ, AMIÉRT EZ A FÁJL LÉTEZIK. A fázis egyetlen élesben ölő
 * regressziója (a feladat csendben a CRM projekten kívülre filézve) végig
 * látható volt volna egy élő hoszt ellen, és végig zöld volt memóriában.
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

// --- CRM-3 ---------------------------------------------------------------
//
// A 9. ponttol lefele a CRM-3 felulete: az Ugyfelkezelo ugynok, a napi kore,
// es a javaslat-elfogadas kore. Egyik sem latszik a fenti nyolc pontbol --
// mind a harom a hoszt managed-resource reconcile-jan es a hoszt task-
// route-jan all, tehat pontosan az a fajta felulet, amit egy zold unit-teszt-
// futas utan is el lehet rontani, es amirol a fazis egyetlen elesben olo
// regresszioja is szolt.

// 9. Az Ugyfelkezelo ugynok letezik, ES EZ AZ EXTENSION BIRTOKOLJA. A puszta
//    letezes nem eleg: egy azonos nevu, kezzel felvett ugynok ugyanugy nezne
//    ki, de a reconcile nem frissitene, es a prompt-valtozasok sosem ernek el
//    hozza. A `managedByExtension` harmasa az, ami ezt megkulonbozteti.
{
  const { status, body } = await get(`${BASE}/api/agents`)
  const sorok = body && typeof body === 'object' ? Object.values(body) : []
  const ugynok = sorok.find((a) => a?.managedByExtension?.resourceKey === 'crm-ugyfelkezelo')
  ok('az Ugyfelkezelo ugynok letrejott', Boolean(ugynok),
     `${sorok.length} ugynok, egyik sem crm-ugyfelkezelo -- futott mar reconcile?`, status)
  ok('az ugynokot ez az extension birtokolja',
     ugynok?.managedByExtension?.extensionId === EXT && ugynok?.managedByExtension?.resourceKind === 'agent',
     JSON.stringify(ugynok?.managedByExtension), status)
  // A heartbeat KI van kapcsolva, es ezt eles hoszton is meg kell nezni: a
  // deklaracio `false`-t visz, de a mezot a `storage-normalization.ts` is
  // allitja, es egy fordulat barmelyik oldalon egy flottanyi autonom ebredest
  // kapcsolna be melekhatasként -- CLI-provideren elofizetes-egetve.
  ok('az ugynok heartbeatje ki van kapcsolva', ugynok?.heartbeatEnabled === false,
     String(ugynok?.heartbeatEnabled), status)
}

// 10. A napi kor utemezese letezik, a vart cronnal es idozonaval. Egy elcsuszott
//     cron vagy egy hianyzo timezone nem hibazik: az ugynok egyszeruen mas
//     idopontban (vagy UTC szerint) ebred, es ezt csak hetek mulva venne eszre
//     valaki. A `10 8 * * *` es az `Europe/Budapest` ezert ERTEK szerint all itt.
{
  const { status, body } = await get(`${BASE}/api/schedules`)
  const sorok = body && typeof body === 'object' ? Object.values(body) : []
  const rutin = sorok.find((sch) => sch?.managedByExtension?.resourceKey === 'crm-napi-kor')
  ok('a napi kor utemezese letrejott', Boolean(rutin),
     `${sorok.length} utemezes, egyik sem crm-napi-kor`, status)
  ok('az utemezest ez az extension birtokolja',
     rutin?.managedByExtension?.extensionId === EXT && rutin?.managedByExtension?.resourceKind === 'schedule',
     JSON.stringify(rutin?.managedByExtension), status)
  ok('a napi kor cronja es idozonaja a vart',
     rutin?.scheduleType === 'cron' && rutin?.cron === '10 8 * * *' && rutin?.timezone === 'Europe/Budapest',
     `scheduleType=${rutin?.scheduleType} cron=${rutin?.cron} timezone=${rutin?.timezone}`, status)
  ok('a napi kor aktiv, nem archivalt vagy szuneteltetett', rutin?.status === 'active',
     String(rutin?.status), status)
}

// 11. A javaslat-elfogadas TELJES kore, eles hoszton: javaslat -> elfogadas ->
//     valodi BoardTask a CRM projektben.
//
//     EZ AZ A PONT, AMI A FAZIS EGYETLEN ELESBEN OLO REGRESSZIOJAT ELKAPTA
//     VOLNA. A `crmProjektId` egy `board()` altal elomelegitett mezot olvasott,
//     es a nelkul `null` projektId-vel filezte a feladatot -- CSENDBEN, a CRM
//     projekten kivulre, "Feladat letrehozva" mellett. Memoriaban minden zold
//     volt; ez a kor az egyetlen, ami a hoszt valodi task-tablajat is megnezi.
//
//     A javaslat az UGYNOK ajtajan (`mcpCall` -> `crm_suggestion_write`) keletkezik,
//     az elfogadas az OPERATOR ajtajan (`acceptSuggestion`) -- igy a kor mindket
//     feluletet atmeri, nem csak az egyiket.
//
//     FIGYELEM: ez a pont VALODI ADATOT IR az eles adatbazisba (egy ugyfelet, egy
//     javaslatot es egy feladatot), ezert a nev felismerhetoen jelolt. A szkript
//     nem torol: nincs se rpc, se HTTP ut egy ugyfel torlesere, es egy sajat
//     torlo-ut felvetele ennel a szkriptnel dragabb kockazat lenne.
{
  const jeloles = `crm-smoke ${new Date().toISOString()}`
  const acc = await call('createAccount', { name: `[smoke] ${jeloles}` })
  ok('a smoke-ugyfel letrejott', acc.status === 200 && typeof acc.body?.id === 'string',
     JSON.stringify(acc.body), acc.status)

  if (acc.body?.id) {
    const irt = await call('mcpCall', {
      tool: 'crm_suggestion_write',
      args: { accountId: acc.body.id, text: `Smoke-ellenorzes ${jeloles}`, reason: 'telepites-ellenorzes' },
    })
    // A `mcpCall` a tool eredmenyet VALTOZATLANUL adja vissza (nincs burok),
    // es a `crm_suggestion_write` a beirt sort adja -- tehat az id a torzs teteje.
    const sugId = irt.body?.id
    ok('a javaslat az ugynok ajtajan (crm_suggestion_write) letrejott',
       irt.status === 200 && !irt.body?.error && typeof sugId === 'string',
       JSON.stringify(irt.body), irt.status)

    if (sugId) {
      const elfogadva = await call('acceptSuggestion', { suggestionId: sugId })
      ok('az elfogadas feladat-azonositot adott',
         elfogadva.status === 200 && typeof elfogadva.body?.taskId === 'string' && elfogadva.body.taskId !== '',
         JSON.stringify(elfogadva.body), elfogadva.status)
      // A friss javaslat cime egyedi (idobelyeg), tehat itt dedup nem varhato --
      // ha megis jon, az azt jelenti, hogy a hoszt egy MAS feladatot adott
      // vissza, es a kor nem azt merte, amit merni akart.
      ok('az elfogadas UJ feladatot hozott letre, nem egy meglevore mutatott',
         elfogadva.body?.deduplicated !== true, JSON.stringify(elfogadva.body), elfogadva.status)

      if (elfogadva.body?.taskId) {
        const projektek = await get(`${BASE}/api/projects`)
        const projektSorok = Array.isArray(projektek.body)
          ? projektek.body
          : Object.values(projektek.body?.projects || projektek.body || {})
        const crmProjekt = projektSorok.find((p) => p?.managedByExtension?.resourceKey === 'crm'
          && p?.managedByExtension?.extensionId === EXT)

        const feladatok = await get(`${BASE}/api/tasks`)
        const tabla = feladatok.body && typeof feladatok.body === 'object' ? feladatok.body : {}
        const feladat = tabla[elfogadva.body.taskId]
          || Object.values(tabla).find((t) => t?.id === elfogadva.body.taskId)
        ok('az elfogadas VALODI BoardTaskot hozott letre a hoszt tablajaban', Boolean(feladat),
           `taskId=${elfogadva.body.taskId}, ${Object.keys(tabla).length} feladat a tablaban`, feladatok.status)
        // A regresszio pontosan itt latszott volna: a feladat letrejott, de
        // `projectId: null`-lal, a CRM projekten kivul.
        ok('a feladat a CRM projektbe kerult, nem a projekten kivulre',
           Boolean(crmProjekt) && feladat?.projectId === crmProjekt?.id,
           `feladat.projectId=${feladat?.projectId}, crmProjekt.id=${crmProjekt?.id}`, feladatok.status)
        ok('a feladat visszamutat az ugyfelre (customFields.crm_account)',
           feladat?.customFields?.crm_account === acc.body.id,
           JSON.stringify(feladat?.customFields), feladatok.status)
        console.log(`  (a smoke ${feladat?.id || elfogadva.body.taskId} feladatot es a "[smoke] ..." ugyfelet ` +
                    'HAGYTA a hoszton -- ezeket kezzel torold, ha zavarnak)')
      }
    }
  }
}

console.log(bukott === 0 ? 'MIND ZOLD' : `${bukott} pont bukott`)
process.exit(bukott === 0 ? 0 : 1)
