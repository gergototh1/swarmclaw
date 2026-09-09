import fs from 'node:fs'
import os from 'node:os'

import { createAttention } from './attention-service.mjs'
import { newId } from './ids.mjs'
import { createSweep } from './sweep.mjs'

/**
 * Mennyi ideig vár egy hívás a hoszt saját HTTP-jére, mielőtt feladja.
 *
 * A hívás UGYANABBA a folyamatba megy vissza, amiben ez a kód fut (lásd a
 * `hostFetch` doksiját lejjebb) -- egy válasz nélkül ragadt kérés a `board()`-ot
 * (ami ezt bevárja, mielőtt a lap egyáltalán renderelne) végérvényesen
 * felfüggesztené. 10s bőven elég egy `/api/projects` GET-nek vagy egy
 * `/api/tasks` POST-nak, mindkettő helyi SQLite-ot ér el, hálózatot nem.
 *
 * `state.hostFetchTimeoutMs` felülírhatja -- ez a teszt varrata, hogy egy
 * időtúllépést ne kelljen a teszt futásában ténylegesen kivárni.
 */
const HOST_FETCH_TIMEOUT_MS = 10_000

/**
 * Mennyivel eshet a port-fájl `startedAt`-ja a jelen rendszerindítás becsült
 * pillanata elé, és még ugyanennek a boot-nak számítson.
 *
 * Egy az egyben a hoszt saját szabálya (`src/lib/server/runtime/port-file.ts`
 * `BOOT_TOLERANCE_MS`, és a testvér `gmail` extension `src/health.mjs`-e
 * ugyanezzel a névvel) -- egy extension nem importálhatja azt a fájlt, ezért
 * itt is meg kell ismételni.
 */
const BOOT_TOLERANCE_MS = 60_000

const isWholeNumber = (v) => typeof v === 'number' && Number.isSafeInteger(v)
const isPort = (v) => isWholeNumber(v) && v >= 1 && v <= 65535

/**
 * Egy extension-azonosító normalizálása összehasonlításhoz: kisbetűs, levágott
 * záró `.js`/`.mjs`-szel. Lásd a `crmProjektId` doksiját, miért kell ez --
 * a host az extensiont a fájlnevével azonosítja (`crm.mjs`), nem a
 * `projectKey`/`extension` mezőkben írt rövid névvel (`crm`).
 */
const normalizottExtensionId = (id) => String(id || '').trim().toLowerCase().replace(/\.(m?js)$/, '')

/**
 * Igaz, ha a port-fájl tartalma a JELEN rendszerindításból, ÉLŐ folyamatot ír
 * le.
 *
 * A hoszt port-file.ts-e négy ellenőrzést ír elő minden olvasónak: 1. alak,
 * 2. boot-idő + pid, 3. `/api/healthz` szolgáltatás, 4. `/api/healthz`
 * azonosító. Ez a függvény csak az 1-2-t adja vissza -- ELTÉRVE
 * `extensions/crm/mcp/server.mjs` mintájától, ami mind a négyet elvégzi.
 *
 * A különbség oka nem hanyagság: a mcp/server.mjs egy KÜLÖN folyamat (egy
 * ügynök által indított stdio shim), aminek a port-fájl portján valóban a
 * host felel-e, kizárólag egy `/api/healthz` híváson dől el -- nincs más
 * módja megtudni, kié az a port. Ez a hívás viszont MAGÁBAN A HOSZT
 * FOLYAMATÁBAN fut: `src/lib/server/extensions.ts` egy `import()`-tal tölti
 * be az extensiont, nem gyerek-processzben indítja -- tehát ha a port-fájl
 * a jelen boot-ból való és élő pid-et ír le, a kérdés "ez a mi pid-ünk-e"
 * `process.pid === info.pid`-del EGYENESEN eldönthető, healthz-hívás nélkül.
 * Ez szigorúbb ellenőrzés, mint amit egy külső folyamat tehetne (az csak azt
 * kérdezheti, létezik-e ilyen pid, sosem azt, hogy ez ő maga-e), nem gyengébb
 * -- ezért marad el a 3-4. lépés, nem azért, mert kihagyható lenne egy külön
 * folyamat esetén is.
 */
function portFajlElo(info) {
  if (!isWholeNumber(info.pid) || info.pid < 1) return false
  if (!isWholeNumber(info.startedAt)) return false
  if (info.startedAt < Date.now() - os.uptime() * 1000 - BOOT_TOLERANCE_MS) return false
  return info.pid === process.pid
}

/**
 * A hoszt portja, amin a `hostFetch` a saját HTTP-jét hívja.
 *
 * I-NEW-3: ELSŐBBSÉGGEL A `process.env.PORT`-ot HASZNÁLJUK, ha az érvényes
 * portszámra mutat, és a port-fájl csak EKKOR marad fallback. A hívás
 * UGYANABBA a folyamatba megy vissza, amiben ez a kód fut (`src/lib/server/
 * extensions.ts` `import()`-tal tölti be az extensiont, nem gyerek-
 * processzben) -- és a Next.js saját indító szkriptje pontosan EBBŐL a
 * folyamat-env-ből olvassa ki a ténylegesen kötött portot (`listening`
 * callback), MIELŐTT a host ugyanezt az értéket a `run/port.json`-ba írná
 * (`src/instrumentation.ts`, a `PORT` env-ből: "Every launch path here passes
 * the port in (Electron's `PORT`, a Dockerfile ENV PORT-ja, a dev script
 * `-p`-je)"). A `process.env.PORT` tehát ugyanazt az értéket adja, mint a
 * port-fájl, de KÖZVETLENÜL, fájl-olvasás, pid- és boot-idő-ellenőrzés
 * nélkül -- mert ezek az ellenőrzések egy KÜLSŐ folyamat leírásának
 * frissességét mérik, ez az érték viszont a SAJÁT folyamatunk envje, ami
 * definíció szerint nem lehet elavult. Ezzel egy teljes hibaosztály
 * (visszamaradt/olvashatatlan/idegen port-fájl) el sem érheti a hívást, ha a
 * `PORT` be van állítva -- ami minden ma ismert indítási módon így van.
 *
 * A port-fájl csak akkor jön szóba, ha a `PORT` hiányzik vagy nem érvényes
 * portszám -- ez a régi, elsődleges út innentől fallback, nem eltávolítva:
 * `state.portFile` ELÉRÉSE nélkül (pl. régebbi telepítés, vagy egy jövőbeli
 * indítási mód, ami nem állítja a `PORT`-ot) a hívás enélkül teljesen
 * elakadna.
 *
 * ISMERT RÉS, AMIT EZ A VÁLASZTÁS NEM OLD MEG: `bin/worker-cmd.js` egy
 * `SWARMCLAW_WORKER_ONLY=1` szervert indít, ami betölti az extensiont
 * (`src/instrumentation.ts` a `getExtensionManager().ensureLoaded()`-et
 * FÜGGETLENÜL az `isWorkerOnly`-tól hívja), de nem köt HTTP-portot és
 * port-fájlt sem ír (az `initWsServer()`/port-fájl-írás ága kizárólag a
 * NEM worker-only ágon fut). Ha ott a `PORT` env mégis öröklődik egy korábbi
 * indításból (pl. egy sibling web-folyamat portja), ez a függvény azt
 * érvényesnek látná, és `hostFetch` afelé küldene kérést -- ami vagy egy
 * valódi, máshol futó hoszthoz ér el (helyes), vagy elutasításba fut
 * (biztonságosan sikertelen, `crm_host_hivas_sikertelen`), de SOSEM lett
 * volna elérhető a régi, port-fájl-only ágon (ott a hiányzó fájl miatt
 * `crm_nincs_port_fajl` állt volna meg előbb). Ma egyetlen CRM-hívás sem fut
 * a worker-only folyamatban -- ha egy jövőbeli eszköz onnan hívná a
 * `hostFetch`-et, ezt a rést egyetlen teszt sem fedi.
 */
function hostPort(state) {
  const envPort = Number(process.env.PORT)
  if (isPort(envPort)) return envPort

  const file = state.portFile
  if (!file || !fs.existsSync(file)) throw new Error('crm_nincs_port_fajl')
  let info
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('crm_olvashatatlan_port_fajl')
  }
  if (!info || typeof info !== 'object' || !isPort(info.port)) throw new Error('crm_nincs_port_fajl')
  if (!portFajlElo(info)) throw new Error('crm_regi_port_fajl')
  return info.port
}

/**
 * Igaz, ha a hiba ALAKJA hálózati/időtúllépési jellegű, tehát a hívó
 * `crm_host_hivas_sikertelen`-ként fordíthatja le.
 *
 * MINDEN dobott hibát ide terelni (a korábbi puszta `catch {}`) épp azt
 * a fajta hibát rejtette volna el, amit a CLAUDE.md "lint rules exist to
 * protect us" szelleme szerint látni kell: egy programozási hiba (pl. egy
 * `TypeError`, mert a hívó rossz alakú `body`-t adott át, vagy egy
 * `RangeError`, mert `timeoutMs` negatív lett) ugyanazt a hálózat-alakú kódot
 * kapta volna, mint egy valódi, elutasított kapcsolat -- az operátor "a hoszt
 * nem válaszolt"-ot látott volna egy saját kódhibánkra.
 *
 * KÉT ALAKOT ISMERÜNK EL HÁLÓZATINAK: az `AbortSignal.timeout()` és a `fetch`
 * saját megszakítása mindig `DOMException`-t dob (`TimeoutError`/`AbortError`
 * néven -- lásd a teszt `irPortFajlt` melletti `fetchImplNyomkovetve`
 * dublőrjét is, ami pont ezt utánozza), a Node/undici hálózati hiba
 * (kapcsolat elutasítva, DNS nem oldódik fel, stb.) pedig egy `TypeError`-t
 * dob `"fetch failed"` üzenettel és egy `cause`-ban hordozott, kód-mezős
 * (`ECONNREFUSED` stb.) okkal. Minden más hiba -- más üzenetű `TypeError`
 * is -- ÁTENGEDVE surran tovább, a saját nevén.
 */
function halozatiAlakuHiba(err) {
  if (err instanceof DOMException) return true
  if (err instanceof TypeError) {
    if (/fetch failed/i.test(String(err.message || ''))) return true
    const cause = err.cause
    if (cause && typeof cause === 'object' && 'code' in cause) return true
  }
  return false
}

/**
 * Hívás a host saját API-jára.
 *
 * Ez az egyetlen út: az `ExtensionContext` nem ad task-API-t, és egy extension
 * nem importálhat a host `src/`-jéből. A port forrását (`PORT` env vagy a
 * port-fájl) a `hostPort` adja -- lásd ott, miért ez a sorrend, és milyen
 * hibákat nevesít, ha egyik sem áll rendelkezésre.
 *
 * A `fetchImpl` a teszt varrata: a CRM-1 óta a `state`-en ül. Éles kódban
 * `globalThis.fetch`.
 *
 * A `method` alapértelmezetten `POST` -- a feladat-létrehozás ilyen --, de a
 * `/api/projects` GET-et vár, ezért a hívó felülírhatja.
 */
async function hostFetch(state, utvonal, body, method = 'POST') {
  const port = hostPort(state)

  // M7 (a review 7. apró pontja): a hoszt `src/proxy.ts` (~270. sor) KIZÁRÓLAG
  // az `ACCESS_KEY` env-et olvassa a `x-access-key` fejléchez -- a korábbi
  // `SWARMCLAW_ACCESS_KEY` fallback élesben soha nem érhetett célba, holt kód
  // volt.
  const kulcs = process.env.ACCESS_KEY || ''
  const fetchFn = state.fetchImpl || globalThis.fetch
  // M3: `state.hostFetchTimeoutMs || HOST_FETCH_TIMEOUT_MS` egy explicit `0`-t
  // (egy teszt, ami azonnali időtúllépést akar szimulálni) csendben az
  // alapértelmezett 10s-re cserélne, mert `0` hamis értékű. Az explicit,
  // véges-szám ellenőrzés ezt nem teszi.
  const timeoutMs = typeof state.hostFetchTimeoutMs === 'number' && Number.isFinite(state.hostFetchTimeoutMs)
    && state.hostFetchTimeoutMs >= 0
    ? state.hostFetchTimeoutMs
    : HOST_FETCH_TIMEOUT_MS
  let res
  try {
    res = await fetchFn(`http://127.0.0.1:${port}${utvonal}`, {
      method,
      headers: { 'content-type': 'application/json', ...(kulcs ? { 'x-access-key': kulcs } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (!halozatiAlakuHiba(err)) throw err
    throw new Error('crm_host_hivas_sikertelen')
  }
  if (!res.ok) throw new Error('crm_host_hivas_sikertelen')
  // M1: a `res.json()` korábban a try-n KÍVÜL állt -- egy 200-as válasz nem
  // JSON törzzsel (pl. egy proxy vagy middleware hibaoldala) egy nyers
  // `SyntaxError`-t dobott volna, amit a magyar hibatábla (`ui/ma.tsx`
  // `ELFOGADAS_HIBA_HU`) nem tud lefordítani -- az operátor "Unexpected
  // token..."-t látott volna.
  try {
    return await res.json()
  } catch {
    throw new Error('crm_ervenytelen_host_valasz')
  }
}

/**
 * A CRM projekt azonosítója, a host projekt-listájából.
 *
 * Nem számoljuk ki: a host a `managedResourceId`-t egy hash-ből képzi, és egy
 * második, kézzel írt példány abban a pillanatban elcsúszna, amint a host
 * megváltoztatja a képzést. Megkérdezzük, és SIKERES találat esetén a
 * `state`-en tartjuk -- a projekt a telepítés élettartama alatt nem változik,
 * tehát egy már megtalált azonosítóra a második és minden további hívás a
 * gyorsítótárból felel, GET nélkül. Egy SIKERTELEN keresés (a hívás elhasal,
 * vagy a projekt még nincs a listában) NEM kerül gyorsítótárba -- a guard
 * `if (state.crmProjectId)`, és a `null` ezen a feltételen elesik --, tehát
 * minden további hívás újra megpróbálja. Ez szándékos, nem hiányzó
 * optimalizáció: egy induláskor még nem rekonciliált projekt vagy egy
 * pillanatnyi hálózati hiba idővel magától gyógyul, egy örökre `null`-ra
 * fagyott gyorsítótár viszont nem.
 *
 * A talált projektet HÁROM mezőre illesztjük, nem csak a `resourceKey`-re:
 * `extensionId`, `resourceKind === 'project'`, `resourceKey === 'crm'`.
 * Ugyanezt a hármat követeli meg a host saját `findManagedProject`-je
 * (`src/lib/server/extension-managed-resources.ts`) is -- egy másik
 * extension, ami szintén `projectKey: 'crm'`-et deklarál (a kulcs csak az őt
 * deklaráló extensionön belül egyedi, host-szinten nem), pusztán a
 * `resourceKey`-re illesztve elnyerné a CRM feladatait, ha előbb szerepelne
 * a listában.
 *
 * AZ `extensionId` MEZŐT NORMALIZÁLVA HASONLÍTJUK `'crm'`-hez, nem nyersen.
 * A host az extensiont a FÁJLNEVÉVEL azonosítja
 * (`src/lib/server/extensions.ts` `listExtensionFilenames`/`this.extensions.set`),
 * és `extension-managed-resources.ts` ezt a nyers fájlnevet írja a
 * `managedByExtension.extensionId` mezőbe -- ez ennek a telepítésnek
 * (`extensions/crm/scripts/install.mjs`) `'crm.mjs'`, nem `'crm'`. Egy
 * nyers `=== 'crm'` összevetés emiatt SOHA nem talál, és minden elfogadás
 * `crm_projekt_nem_talalhato`-val hasal el -- ez volt a 3. javítási kör
 * regressziója. A `normalizottExtensionId` egy záró `.js`/`.mjs`-t vág le,
 * ugyanúgy, ahogy a host saját `extensionTablePrefix()`-e
 * (`src/lib/server/extensions/extension-storage.ts`) és
 * `normalizeContractExtensionId()`-je (`src/lib/server/extensions/extension-contracts.ts`)
 * teszi -- így mindkét spelling ('crm' és 'crm.mjs') illeszkedik, ha valaha
 * mindkettővel találkoznánk.
 *
 * MINDKÉT SIKERTELEN ÁG NEVESÍTVE KERÜL A LOGBA (`state.log.warn`), nem
 * hallgat el. Feladat-filézés szempontjából ez a hely a tét: ha itt csendben
 * `null`-t adnánk, az `acceptSuggestion` (ami ide fordul, lásd ott) egy
 * feladatot a CRM projekten KÍVÜLRE filézne, névtelenül -- épp az, amit ez a
 * feladat (7.) meg akart szüntetni.
 *
 * Az `acceptSuggestion` EZT hívja, közvetlenül, mielőtt a feladat törzsét
 * összeállítja -- nem a `state.crmProjectId`-t olvassa ki nyersen. A mező
 * korábban csak a `board()` oldalhatásaként töltődött fel, ami azt
 * jelentette, hogy bármelyik út, ami `board()` nélkül ér el ide (másik lap,
 * szerver-újraindítás a lapmegnyitás és az elfogadás kattintás között,
 * közvetlen rpc-hívás), `null` projekttel filézte a feladatot -- csendben,
 * a CRM projekten kívülre. A memoizálás ide, ebbe a függvénybe került, nem
 * a hívó felelőssége: `acceptSuggestion` így minden hívási úton a valódi
 * azonosítót kapja, `board()` warm-up hívása pedig legfeljebb egy hálózati
 * kört spórol meg, semmi nem függ attól, hogy lefutott-e előbb.
 */
async function crmProjektId(state) {
  if (state.crmProjectId) return state.crmProjectId
  let lista
  try {
    lista = await hostFetch(state, '/api/projects', {}, 'GET')
  } catch (err) {
    state.log?.warn?.(
      'crm crmProjektId: nem sikerult lekerdezni a projekt-listat a hoszttol -- a feladat a CRM projekten kivul kerulhet',
      { reason: err instanceof Error ? err.message : String(err) },
    )
    return null
  }
  const sorok = Array.isArray(lista) ? lista : Object.values(lista || {})
  const crm = sorok.find((p) => p && p.managedByExtension
    && normalizottExtensionId(p.managedByExtension.extensionId) === 'crm'
    && p.managedByExtension.resourceKind === 'project'
    && p.managedByExtension.resourceKey === 'crm')
  if (!crm) {
    state.log?.warn?.(
      'crm crmProjektId: a CRM projekt meg nincs a hoszt projekt-listajaban (nincs rekonciliálva?) -- a feladat a CRM projekten kivul kerulhet',
    )
  }
  state.crmProjectId = crm ? crm.id : null
  return state.crmProjectId
}

/**
 * Amit a lap hívhat, `POST /api/extensions/crm.mjs/call/<method>` alatt.
 *
 * A hosztnak ez a szélesebb ajtó: itt van minden művelet, amit a spec 5.4
 * az operátornak tart fenn -- ügyfél és ügy létrehozása, szakaszváltás, a
 * besorolatlan hozzárendelése, a javaslat elfogadása. Az ügynök felülete
 * (src/tools.mjs) ezekből egyet sem visz, és külön fájlban van, hogy egy
 * átvitel a diffből látsszon, ne egy megosztott listából.
 */
/**
 * Az operátor (vagy egy HTTP-hívó) által megadott címke-lista tömbbé, vagy
 * `undefined`-dá, ha nem adott meg használhatót.
 *
 * Tömböt és vesszős szöveget is elfogad -- az rpc JSON-teste az egyiket, a
 * kézzel összerakott curl a másikat adja --, és a nem szöveges elemeket
 * eldobja. Az `undefined` szándékos: a hívó „nem mondtam semmit"-je így
 * egyértelműen elkülönül a „ne szűkíts semmire"-től, amit a `runSweep` nem is
 * fogadna el (üres címkelista a teljes postafiókot söpörné).
 */
function normalizeLabelIds(raw) {
  const lista = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  const tiszta = lista.map((l) => String(l ?? '').trim()).filter(Boolean)
  return tiszta.length ? tiszta : undefined
}

export function createRpc(state) {
  const repo = () => {
    if (!state.repo) throw new Error('crm_nincs_tar')
    return state.repo
  }

  const mustAccount = (accountId) => {
    const acc = repo().getAccount(accountId)
    if (!acc) throw new Error('crm_ismeretlen_ugyfel')
    return acc
  }

  const mustDeal = (dealId) => {
    const deal = repo().listDeals({}).find((d) => d.id === dealId)
    if (!deal) throw new Error('crm_ismeretlen_ugy')
    return deal
  }

  const mustContact = (contactId) => {
    const con = repo().getContact(contactId)
    if (!con) throw new Error('crm_ismeretlen_kapcsolat')
    return con
  }

  return {
    /**
     * A lap alapállapota egy hívásból: ügyfelek, nyitott ügyek, besorolatlan, javaslatok.
     *
     * Itt kérjük le (és gyorsítótárazzuk a `state.crmProjectId`-n) a CRM projekt
     * azonosítóját is -- lapmegnyitáskor, jóval azelőtt, hogy az operátor egy
     * javaslatot elfogadna. Ez KIZÁRÓLAG egy latencia-előmelegítés: mire az
     * operátor elfogad egy javaslatot, `acceptSuggestion` a gyorsítótárból
     * felel, GET nélkül. Semmi nem függ attól, hogy ez a hívás lefutott-e --
     * `acceptSuggestion` a saját `crmProjektId(state)` hívásával mindig a
     * valódi azonosítót kapja, akkor is, ha ez a `board()` sosem futott le. A
     * hívás önmagában sosem dob (lásd `crmProjektId` doksiját): egy hiányzó
     * port-fájl vagy egy elhasaló hívás legfeljebb `null`-t hagy a
     * gyorsítótárban, a lap többi része ettől függetlenül betölt.
     */
    async board() {
      const r = repo()
      await crmProjektId(state)
      return {
        accounts: r.listAccounts({}),
        deals: r.listDeals({ openOnly: true }),
        unmatched: r.listUnmatched(),
        suggestions: r.listSuggestions({ status: 'new' }),
      }
    },

    async account({ accountId }) {
      const r = repo()
      const account = mustAccount(accountId)
      return {
        account,
        contacts: r.listContacts(accountId),
        deals: r.listDeals({ accountId }),
        events: r.listEvents({ accountId, limit: 50 }),
        summary: r.latestSummary(accountId),
        commitments: r.listCommitments({ accountId }),
        lastEventAt: r.lastEventAt(accountId),
      }
    },

    async timeline({ accountId, before, beforeId, limit }) {
      mustAccount(accountId)
      return { events: repo().listEvents({ accountId, before, beforeId, limit: limit || 50 }) }
    },

    async eventBody({ eventId }) {
      const r = repo()
      if (!r.getEvent(eventId)) throw new Error('crm_ismeretlen_esemeny')
      return { content: r.getEventBody(eventId) }
    },

    async createAccount(args) { return repo().createAccount(args) },
    async updateAccount({ accountId, ...patch }) {
      mustAccount(accountId)
      return repo().updateAccount(accountId, patch)
    },
    async createContact(args) { return repo().createContact(args) },
    async attachEmail({ contactId, address }) {
      mustContact(contactId)
      return repo().attachEmail(contactId, address, 'manual')
    },

    async createDeal(args) { mustAccount(args.accountId); return repo().createDeal(args) },
    async updateDeal({ dealId, ...patch }) { mustDeal(dealId); return repo().updateDeal(dealId, patch) },
    async closeDeal({ dealId, stage, reason }) {
      mustDeal(dealId)
      if (stage !== 'won' && stage !== 'lost') throw new Error('crm_ismeretlen_ugy_szakasz')
      return repo().closeDeal(dealId, { stage, reason })
    },

    /** Kézi jegyzet. A forrás `manual`, az azonosító az eseményé, tehát mindig új sor. */
    async addNote({ accountId, dealId = null, text, occurredAt }) {
      mustAccount(accountId)
      const at = occurredAt || new Date().toISOString()
      return repo().recordEvent({
        accountId, dealId, kind: 'note', occurredAt: at,
        excerpt: String(text || '').slice(0, 200),
        sourceSystem: 'manual', sourceId: `note:${at}:${newId('n')}`,
        body: text,
      })
    },

    /**
     * A hozzárendelő választója: minden kapcsolat, az ügyfele nevével.
     *
     * Az ügyfél nélküli kapcsolatokat is viszi. Egy levél épp attól kerülhet
     * besorolatlanba, hogy az embert ismerjük, de még nincs ügyfélhez kötve --
     * kihagyni őket pont a leggyakoribb esetet nehezítené meg.
     *
     * A `searchContacts('')` üres mintára minden kapcsolatot ad -- az üres
     * minta escape-elve is üres marad, tehát a `LIKE '%%'` mindenre illeszkedik.
     */
    async contactsForPicker() {
      const r = repo()
      const nevek = Object.fromEntries(r.listAccounts({}).map((a) => [a.id, a.name]))
      return r.searchContacts('').map((c) => ({
        id: c.id, name: c.name, accountId: c.accountId,
        accountName: c.accountId ? (nevek[c.accountId] || '') : '',
      }))
    },

    /**
     * A besorolatlan levél hozzárendelése -- és ugyanez a hívás tanítja meg a
     * címet ÉS viszi fel a levelet magát az idővonalra.
     *
     * A tanulás nem külön gomb: ha az lenne, az operátor a felét nem nyomná
     * meg, a besorolatlan sor nem apadna, és néhány hét után abbahagyná az
     * egészet. A megerősítés és a tanulás egy művelet.
     *
     * AZ ESEMÉNY FELVÉTELE UGYANEBBEN A HÍVÁSBAN TÖRTÉNIK, NEM KÜLÖN
     * LÉPÉSBEN. A megerősített levél a sor `source_system`/`source_id`,
     * `subject`, `excerpt`, `received_at` és `thread_id` mezőiből épül fel --
     * pontosan azok az adatok, amiket az operátor épp most nézett át --, és a
     * `recordEvent` a `(source_system, source_id)` unique indexén idempotens:
     * ha egy későbbi söprés ugyanezt a levelet a tanult cím miatt már
     * pontosan besorolná, az újraírás nem duplikál.
     *
     * HA A KIVÁLASZTOTT KAPCSOLATNAK NINCS ÜGYFELE, ESEMÉNY NEM KÉSZÜL. Az
     * `ext_crm_event.account_id` NOT NULL, tehát ügyfél nélkül nincs hova
     * írni -- ugyanez a szabály, amit a `matching.mjs` is követ (`exact` csak
     * `contact.accountId`-val jár). A cím ekkor is megtanulódik és a sor
     * ekkor is kiürül, mert ezek önmagukban is hasznosak, de ez a döntés
     * nem hallgat el: a válasz `eventFiled: false`-t ad, és a szerver-logba
     * is kerül egy sor, hogy az operátor a felületen (vagy a logban) lássa,
     * miért nincs új idővonal-bejegyzés.
     */
    async assignUnmatched({ unmatchedId, contactId }) {
      const r = repo()
      const rows = r.listUnmatched().filter((x) => x.id === unmatchedId)
      if (rows.length === 0) throw new Error('crm_ismeretlen_besorolatlan')
      const row = rows[0]
      const contact = mustContact(contactId)
      if (row.sender_address) r.attachEmail(contactId, row.sender_address, 'learned')

      let event = null
      if (contact.accountId) {
        const filed = r.recordEvent({
          accountId: contact.accountId,
          contactId: contact.id,
          kind: 'email_in',
          occurredAt: row.received_at,
          title: row.subject || '',
          excerpt: row.excerpt || '',
          sourceSystem: row.source_system,
          sourceId: row.source_id,
          threadId: row.thread_id || '',
        })
        event = filed.event
      } else {
        state.log?.warn?.(
          'crm assignUnmatched: a kivalasztott kapcsolatnak nincs ugyfele, esemeny nem keszult',
          { unmatchedId, contactId },
        )
      }

      const resolved = r.resolveUnmatched(unmatchedId)
      return { ...resolved, event, eventFiled: Boolean(event) }
    },

    /**
     * A söprés az operátor gombjáról. Ugyanaz a törzs, mint az eszközé.
     *
     * A `labelIds` ÉS A `q` IS ÁTMEGY, ÉS EZ NEM KÉNYELMI MEZŐ. A `runSweep`
     * mindkettőt fogadja, de amíg ez az ajtó csak a `max`-ot adta tovább,
     * addig egy üres söprés okát nem lehetett innen szűkíteni: nem lehetett
     * megkérdezni, hoz-e a puszta INBOX levelet. Pontosan ez tette hosszúvá a
     * Gmail ÉS-szemantikájából eredő üres söprés diagnózisát.
     *
     * Az üres vagy értelmezhetetlen érték `undefined`-ra esik, NEM üres
     * tömbre -- de ez ma már csak takarékosság: a `runSweep` üres listára és
     * `undefined`-ra egyaránt a teljes postafiókot söpri, mert az archivált
     * levél (amiből az idővonal áll) egyik alapértelmezett címkét sem viseli.
     * A címkelista innen SZŰKÍTÉS, és több címke a Gmailnél ÉS-kapcsolat.
     */
    async sweepNow({ max, labelIds, q } = {}) {
      const cimkek = normalizeLabelIds(labelIds)
      const kereses = typeof q === 'string' && q.trim() ? q.trim() : undefined
      return createSweep(state).runSweep({ max: Number(max) || 50, labelIds: cimkek, q: kereses })
    },

    /**
     * A figyelem-lista a lapnak. Ugyanaz a törzs, mint a `crm_attention`
     * eszközé (`src/tools.mjs`) -- mindkettő a `createAttention(state).list`-et
     * hívja, ugyanazokkal a küszöbökkel és ugyanazzal a rangsorral.
     *
     * KÉT AJTÓ, EGY TÖRZS, ÉS EZ SZÁNDÉKOS. A napi kör üzenete arról szól,
     * amit ez a lista mond; ha az operátor a lapon egy MÁSIK sorrendet vagy
     * egy másik halmazt látna, a 08:10-es üzenet nem lenne ellenőrizhető,
     * és néhány hét alatt elveszítené a hitelét. A lap (`ui/ma.tsx` „Figyelmet
     * igényel" szakasza) ezért nem szűr és nem rangsorol újra: azt jeleníti
     * meg, amit itt kap, `osszes`-sel együtt, hogy a limit ne látszódjon a
     * teljes listának.
     */
    async attention({ limit } = {}) {
      return createAttention(state).list({ limit: Number(limit) || 50 })
    },

    /**
     * A javaslat elvetese -- es CSAK az elvetes.
     *
     * `'accepted'`-et ez a metodus NEM vesz fel, pedig a tarolt allapot
     * ismeri. Az `acceptSuggestion` kimondott invariansa (lasd ott), hogy
     * elfogadott javaslat MOGOTT ALL EGY FELADAT: a cim, a projekt, a
     * `crm_account` custom field es -- ha igeretbol szuletett -- az igeret
     * lezarasa mind ott keletkezik. Ez a metodus egyiket sem csinalja, csak
     * egy oszlopot ir at. Ha atengedne az `'accepted'`-et, egy hivas
     * "elfogadott" javaslatot hagyna feladat nelkul: eltunne a lap
     * javaslat-listajarol (az csak a `status = 'new'` sorokat mutatja), az
     * igeret nyitva maradna, es semmi nem mondana meg, hogy a munka
     * elveszett. Az elfogadasnak EGY ajtaja van, es az az `acceptSuggestion`.
     *
     * Ma a felulet ezt a metodust csak `'dismissed'`-del hivja (`ui/ma.tsx`
     * `elvet`), tehat a tiltas ma nem er el senkit -- de az rpc a hoszt HTTP
     * felulete, nem a lap privat fuggvenye, es egy nevesitett elutasitas
     * olcsobb, mint egy nema, feladat nelkuli "elfogadott" sor.
     */
    async setSuggestionStatus({ suggestionId, status }) {
      if (status === 'accepted') throw new Error('crm_elfogadas_csak_acceptSuggestion')
      if (status !== 'dismissed') throw new Error('crm_ismeretlen_javaslat_allapot')
      return repo().setSuggestionStatus(suggestionId, status)
    },

    /**
     * A javaslat elfogadása — és EZ az, ami feladatot csinál belőle.
     *
     * Az ügynök javasol, az operátor dönt; a döntés helye ez a metódus, és
     * ezért nincs `crm_accept_suggestion` eszköz.
     *
     * NEM küldünk `fingerprint` mezőt a törzsben: a host `task-service.ts`
     * `createTaskFromRoute`-ja a `task.fingerprint`-et minden hívásra
     * feltétel nélkül felülírja a saját, cím + agentId alapú
     * `computeTaskFingerprint`-jével (`task.fingerprint =
     * computeTaskFingerprint(...)`, közvetlenül a `buildBoardTask` után,
     * mielőtt a dedup-keresés lefutna) -- egy itt küldött érték se nem
     * tárolódik, se a dedupra nem hat, tehát nincs mit vele küldeni. A dedup
     * ezért a hoszt saját, újraszámolt fingerprintjén dől el: két azonos című,
     * azonos agentId-jú, még nem lezárt feladat ütközik, függetlenül attól,
     * hogy melyik javaslatból születtek.
     *
     * A CÍM AZ ÜGYFÉL NEVÉVEL KEZDŐDIK (`${acc.name} — ${sug.text}`), nem
     * pusztán a javaslat szövege. A `findDuplicateTask` (`src/lib/task-
     * dedupe.ts`) a hoszt TELJES tábláján keres egyezést, nem csak ezen
     * ügyfél feladatai közt, és sosem küldünk `agentId`-t (lásd fent) --
     * tehát a fingerprint csak a címen áll. Két ügyfél rövid, egyforma
     * felszólító javaslata ("Küldj ajánlatot", "Hívd fel") a saját nevük
     * nélkül ütközne: az egyik ügyfél elfogadása a MÁSIK ügyfél nyitott
     * javaslatát/ígéretét zárná le csendben, a másik ügyfél oldala pedig
     * "nincs feladat"-ot mutatna. Az ügyfél neve a címben ezt zárja ki: két
     * különböző ügyfél cím-fingerprintje emiatt nem eshet egybe pusztán a
     * javaslat szövege miatt.
     *
     * A TELJES cím van 120 karakterre vágva (nem csak a javaslat szövege
     * előtte), és NEM egy host-korlát miatt: a hoszton nincs ilyen korlát.
     * `TaskCreateSchema.title` (`src/lib/validation/schemas.ts`)
     * `z.string().min(1)`, felső határ nélkül, és `buildBoardTask`
     * (`src/lib/server/tasks/task-lifecycle.ts`) a kapott címet érintetlenül
     * teszi a `task.title`-be. A 120 a MI döntésünk, és egyetlen indoka van:
     * a feladat egy kanban-kártyán jelenik meg, és egy bekezdésnyi cím ott
     * olvashatatlan -- a javaslat szövege amúgy is egy mondat, a leírás
     * (`description`) pedig a teljes szöveget viszi, tehát a vágás nem
     * veszít adatot, csak a kártyát tartja olvashatóan. Azért a TELJES cím
     * van vágva és nem csak a javaslat szövege, mert az ügyfél neve is a
     * kártyán van, és az is tetszőlegesen hosszú lehet.
     *
     * A VÁGÁS UTÁN EGY RÖGZÍTETT HOSSZÚ JAVASLAT-ID-SZUFFIX ZÁRJA A CÍMET
     * (` #<sug.id utolsó 8 karaktere>`), NEM a puszta 120-ra vágott
     * `${acc.name} — ${sug.text}`. Enélkül két KÜLÖNBÖZŐ javaslat UGYANAHHOZ
     * az ügyfélhez -- vagy egy elég hosszú ügyfélnév, ami a javaslat szövegét
     * teljesen kiszorítja a 120 karakterből -- azonos címre vágódna, és a
     * hoszt cím+agentId fingerprintje (az `agentId`-ról lásd az alábbi
     * bekezdést) a MÁSODIK javaslat elfogadását a hoszt szemében az ELSŐ
     * elfogadás ismétlésének látná: `deduplicated: true` jönne vissza, a második
     * javaslat mögötti munkának soha nem lenne saját feladata, az ígérete
     * (ha volt) mégis lezárva jelenne meg egy IDEGEN feladathoz kötve. A
     * szuffix helyét ELŐSZÖR foglaljuk le (`120 - szuffix.length`), a
     * `${acc.name} — ${sug.text}` részt csak UTÁNA vágjuk erre a maradék
     * hosszra -- fordítva (előbb 120-ra vágni, aztán a szuffixot hozzáfűzni)
     * a cím megint 120 fölé nőne, vagy a szuffix vágódna le, ami épp azt a
     * garanciát venné el, amiért itt van.
     *
     * AZ `agentId` ITT NEM GARANTÁLTAN `''`, ÉS EZ A DEDUP-ÉRVELÉST SZŰKÍTI.
     * A törzs nem küld `agentId`-t, de a hoszt nem a küldött értéket veszi:
     * `createTaskFromRoute` (`src/lib/server/tasks/task-route-service.ts`)
     * minden nem üres `description`-re lefuttatja a
     * `resolveTaskAgentFromDescription`-t
     * (`src/lib/server/tasks/task-mention.ts`), ami a leírásban `@név`
     * említést, majd angol hozzárendelő fordulatokat (`assign … to X`,
     * `assignee: X`, `for agent X`) keres, és találat esetén EGY LÉTEZŐ
     * ügynök azonosítóját adja vissza. A leírás nálunk az ügynök által írt
     * javaslat-szöveg és indoklás, tehát ez a bemenet nem a mi kezünkben van.
     * Magyar prózában és a telepítés ügynök-nevei mellett ez nagyon
     * valószínűtlen, de nem lehetetlen -- és ha megtörténik, KÉT dolog
     * változik: a feladat egy ügynökhöz kerül hozzárendelve (nem az operátor
     * teendői közé), és a fingerprint már nem a puszta címen áll.
     *
     * Amit ez a dedup-érveléssel tesz: a fenti bekezdések „a fingerprint
     * csak a címen áll" állítása a TIPIKUS eset, nem tétel. Az érvelés iránya
     * viszont áll: az ügyfélnév és a javaslat-id-szuffix a címet teszi
     * egyedivé, és egy nem üres `agentId` a fingerprintet CSAK TOVÁBB
     * osztja -- két különböző javaslat így sem eshet egybe. A ténylegesen
     * gyengülő garancia a másik irány: ugyanannak a javaslatnak a kétszeri
     * elfogadása (dupla kattintás) csak akkor ütközik, ha mindkét hívás
     * ugyanazt az `agentId`-t oldja fel -- és mivel a leírás mindkétszer
     * bájtra azonos, és a feloldás determinisztikus, ez a gyakorlatban
     * teljesül; csak akkor nem, ha a két kattintás KÖZÖTT nevezik át vagy
     * törlik a leírásban említett ügynököt.
     *
     * A szuffix `sug.id`-ból jön, NEM valamiféle véletlenből: `acceptSuggestion`
     * ugyanazt a javaslatot kétszer elfogadva (dupla kattintás, két nyitott
     * lap) ugyanazt a `sug.id`-t, tehát ugyanazt a szuffixot, tehát ugyanazt
     * a teljes címet adja -- a hoszt saját dedupja erre a MÁSODIK hívásra
     * még mindig `deduplicated: true`-val felel, ahogy a fenti doksi-rész
     * ígéri. Csak a KÜLÖNBÖZŐ javaslatok címe válik szét ettől.
     *

     * HA A HOSZT `deduplicated: true`-t ad vissza, ez NEM hiba: ugyanaz a
     * javaslat kétszeri elfogadása (dupla kattintás, két lap) a hoszt saját
     * fingerprintjén ütközik, és a válasz a MÁR LÉTEZŐ feladatot adja vissza,
     * nem egy újat. Ezt továbbadjuk a hívónak (`deduplicated`), hogy a
     * felület ne mondja "Feladat létrehozva"-t egy olyan hívásra, ami
     * valójában semmit nem hozott létre -- lásd `ui/ma.tsx`.
     */
    async acceptSuggestion({ suggestionId }) {
      const r = repo()
      const sug = r.listSuggestions({}).find((s) => s.id === suggestionId)
      if (!sug) throw new Error('crm_ismeretlen_javaslat')

      const projectId = await crmProjektId(state)
      // A CRM projekt megléte ennek a feladatnak a teljes indoka -- egy
      // `null` itt azt jelentené, hogy a feladat a CRM projekten kívülre
      // kerülne, néma "Feladat létrehozva" mellett. A `crmProjektId` már
      // naplózta a konkrét okot (hiányzó/olvashatatlan/elavult port-fájl,
      // vagy a projekt még nincs rekonciliálva), ezért itt egy stabil,
      // névvel ellátott hibával állunk meg, nem folytatjuk `projectId: null`-lal.
      if (!projectId) throw new Error('crm_projekt_nem_talalhato')
      const acc = r.getAccount(sug.account_id)
      // Lásd a doksit fent: a szuffix helye ELŐBB dől el, a leíró rész csak
      // a maradék helyre vágódik -- soha nem fordítva.
      const cimSzuffix = ` #${sug.id.slice(-8)}`
      const cimEleje = `${acc ? acc.name : ''} — ${sug.text}`.slice(0, 120 - cimSzuffix.length)
      const cim = `${cimEleje}${cimSzuffix}`
      const body = {
        title: cim,
        description: sug.reason ? `${sug.text}\n\nMiért: ${sug.reason}` : String(sug.text || ''),
        projectId,
        tags: ['crm'],
        customFields: {
          crm_account: sug.account_id,
          ...(sug.deal_id ? { crm_deal: sug.deal_id } : {}),
          ...(sug.trigger_event_id ? { crm_event: sug.trigger_event_id } : {}),
          crm_account_name: acc ? acc.name : '',
        },
      }
      // M4: a `crmProjektId` sikeres találata a folyamat élettartamára
      // gyorsítótárazva marad (lásd a doksiját) -- de ha KÖZBEN a projektet
      // törölték és egy MÁSIK azonosítóval rekonciliálták újra, ez a
      // gyorsítótárazott `projectId` egy halott projektre mutat, és a
      // `/api/tasks` POST erre a legvalószínűbb módon hibával fog elhasalni.
      // Egy sikertelen POST-on ezért ELDOBJUK a gyorsítótárat: a hívó
      // hibaüzenete változatlan marad, de a KÖVETKEZŐ elfogadás már újra
      // lekérdezi a projekt-listát, nem egy tudottan-halott id-vel próbálkozik
      // örökre.
      let res
      try {
        res = await hostFetch(state, '/api/tasks', body)
      } catch (err) {
        state.crmProjectId = null
        throw err
      }
      const taskId = res && res.id ? String(res.id) : ''
      if (!taskId) throw new Error('crm_feladat_nem_jott_letre')
      // I5: a `commitmentId`-t az ÜGYNÖK adta meg a javaslat írásakor
      // (`tools.mjs` `crm_suggestion_write`), és ott már ellenőriztük, hogy
      // az akkor a javaslat ügyfeléhez tartozott. Az elfogadás azonban egy
      // KÉSŐBBI időpontban történik -- semmi nem zárja ki, hogy időközben
      // (kézi adatjavítással, egy másik folyamattal) az ígéret átkerült egy
      // MÁSIK ügyfélhez. Enélkül az újraellenőrzés nélkül az elfogadás egy
      // idegen ügyfél ígéretét zárná le csendben, ugyanaz a hiba, amit I4 a
      // ÍRÁS oldalán már kizárt -- ez itt az ELFOGADÁS oldalának ugyanaz a
      // kapuja.
      if (sug.commitment_id) {
        const igeret = r.getCommitment(sug.commitment_id)
        if (igeret && igeret.account_id === sug.account_id) {
          // Sorrend: ELŐBB az ígéret lezárása, UTÁNA a javaslat elfogadottá
          // jelölése. Ha a kettő közt bármi elhasalna, a javaslat "new" marad --
          // ez az operátornak látható, újra elfogadható állapot --, nem pedig
          // "accepted", de a mögötte álló ígéret örökre nyitva ragadva. A
          // fordított sorrend épp azt az állapotot hozná vissza, amit ez a
          // feladat (7.) meg akart szüntetni: egy elfogadottnak jelölt javaslat,
          // ami mögött nincs valódi lezárás.
          r.linkCommitmentTask(sug.commitment_id, taskId)
        } else {
          state.log?.warn?.(
            'crm acceptSuggestion: a javaslathoz tartozo igeret idokozben mas ugyfelhez kerult vagy eltunt -- nem zarjuk le',
            { suggestionId, commitmentId: sug.commitment_id },
          )
        }
      }
      r.setSuggestionStatus(suggestionId, 'accepted')
      return {
        suggestion: r.listSuggestions({}).find((s) => s.id === suggestionId),
        taskId,
        deduplicated: Boolean(res && res.deduplicated),
      }
    },

    /**
     * Feloldódik-e a postafiók-szerződés, és ha nem, miért.
     *
     * A lap ezt írja ki, nem hallgat: az operátort jobban szolgálja egy
     * megnevezett korlát, mint egy modul, ami csendben nem csinál semmit --
     * és a négy ok, amit a hoszt megkülönböztet (`not_declared`,
     * `provider_missing`, `provider_disabled`, `version_mismatch`), négy
     * különböző teendőt jelent. „A Gmail extension ki van kapcsolva" és „a CRM
     * soha nem is kérte ezt a szerződést" nem ugyanaz a hiba, ezért a hoszt
     * saját okkódját adjuk tovább, nem egy összemosott általános szöveget.
     * `state.contracts.get` két argumentumot vár (extensionId, contract) --
     * a verziót a `consumes` deklaráció köti, `get`-nek nincs harmadik
     * paramétere. Amikor `get` null-t ad, `why` mondja meg, melyik a négy ok
     * közül; ha `state.contracts` maga sincs (a hoszt nem is ad contracts-ot),
     * az egy ötödik, ettől független állapot, saját névvel.
     *
     * A `handle.mailbox()` ÉLŐ GMAIL API-HÍVÁS -- ez a testvér `aisignal`
     * extension `mailboxHealth`-jétől eltér, ami csak `contracts.why(...)`-t
     * kérdez és sosem megy ki a hálózatra. A döntés itt szándékosan más: a
     * négy szerződés-szintű ok (`not_declared`, `provider_missing`,
     * `provider_disabled`, `version_mismatch`) mind arról szól, hogy a
     * SZERZŐDÉS feloldódik-e, de egy feloldódott szerződés mögött állhat
     * lejárt vagy hiányzó Google-hitelesítő is -- ezt kizárólag egy tényleges
     * hívás látja. Az `aisignal`-nak ez a különbség nem éri meg (ő csak
     * jelez, ha a sweep elakad), a CRM lapja viszont a postafiók CÍMÉT is
     * kiírja, amit csak a hívás ad -- tehát itt a hívásnak amúgy is meg
     * kellene történnie ahhoz, hogy a lap egyáltalán mondhasson valamit.
     *
     * ÉPPEN EZÉRT try/catch-BEN: hiányzó vagy lejárt hitelesítőn a hívás
     * elutasít, és enélkül a catch nélkül ez a lap betöltésekor 500-as hibává
     * válna -- pont az a csapda, amit ez a metódus a saját dokumentációja
     * szerint el akar kerülni. A hiba ekkor is nevesített marad, csak nem a
     * hoszt szerződés-szintű okai közül, mert nem is az a hiba: a szerződés
     * feloldódott, a hívás maga hasalt el.
     *
     * A `reason: 'crm_postafiok_hiba'` ekkor is stabil marad -- a hívó erre
     * ágazhat --, de a `message` mezőben mellette megy a `gmail` extension
     * saját dobott hibájának üzenete is (pl. `google_oauth_client_missing`).
     * Enélkül az operátor csak annyit tudna, hogy "valami baj van a
     * postafiókkal", és nem tudná megkülönböztetni a hiányzó Google OAuth
     * klienst a lejárt hitelesítőtől -- két teljesen más teendő. A `message`
     * ugyanaz a kulcs, amit ez a metódus a `state.log?.warn?.` hívásban is
     * használ ugyanerre az értékre, tehát a hívó és a szerver-log ugyanazt a
     * nevet látja ugyanarra a dologra.
     *
     * A `message` IDEGEN SZÖVEG: a `gmail` extension dobja, nem a CRM
     * ellenőrzi a tartalmát. A lap ezt adatként jeleníti meg, sosem
     * markupként (lásd `ui/ma.tsx`).
     */
    async mailboxHealth() {
      if (!state.contracts) return { available: false, reason: 'crm_nincs_contracts' }
      const handle = state.contracts.get('gmail', 'mailbox')
      if (!handle) {
        return { available: false, reason: state.contracts.why('gmail', 'mailbox') }
      }
      try {
        const box = await handle.mailbox()
        return { available: true, address: box.address }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        state.log?.warn?.(
          'crm mailboxHealth: a postafiók-szerződés feloldódott, de a hívás elhasalt',
          { message },
        )
        return { available: false, reason: 'crm_postafiok_hiba', message }
      }
    },
  }
}
