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
 * Hívás a host saját API-jára, a port-fájlon át.
 *
 * Ez az egyetlen út: az `ExtensionContext` nem ad task-API-t, és egy extension
 * nem importálhat a host `src/`-jéből. A port-fájl a futó szerver egyetlen
 * megbízható önleírása -- de csak azután, hogy alakra és élő voltra
 * ellenőriztük (`portFajlElo`), mert egy szerver-újraindítás után visszamaradt
 * `run/port.json` egy MÁSIK, mára meghalt (vagy pid-újrahasznosítás esetén
 * egy teljesen idegen) folyamat portjára mutatna -- csendben odaküldött
 * feladat-létrehozó POST-tal.
 *
 * A `fetchImpl` a teszt varrata: a CRM-1 óta a `state`-en ül. Éles kódban
 * `globalThis.fetch`. A port-fájl ellenőrzése `fetchImpl` jelenlététől
 * FÜGGETLENÜL mindig lefut -- korábban ez a szakasz teljesen kimaradt, ha
 * `state.fetchImpl` be volt állítva, ami azt jelentette, hogy az itt élő
 * hibaágak (`crm_nincs_port_fajl`, `crm_olvashatatlan_port_fajl`, egy
 * elavult port-fájl) egyetlen tesztből sem voltak elérhetők, hiszen minden
 * teszt épp a `fetchImpl` varratot használja. Egy teszt, aminek erre a
 * hívásra ténylegesen szüksége van, egy valódi, ideiglenes `port.json`-t ír
 * (lásd `test/rpc.test.mjs` `irPortFajlt`), nem egy külön kódutat kap.
 *
 * A `method` alapértelmezetten `POST` -- a feladat-létrehozás ilyen --, de a
 * `/api/projects` GET-et vár, ezért a hívó felülírhatja.
 */
async function hostFetch(state, utvonal, body, method = 'POST') {
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

  const kulcs = process.env.ACCESS_KEY || process.env.SWARMCLAW_ACCESS_KEY || ''
  const fetchFn = state.fetchImpl || globalThis.fetch
  const timeoutMs = state.hostFetchTimeoutMs || HOST_FETCH_TIMEOUT_MS
  let res
  try {
    res = await fetchFn(`http://127.0.0.1:${info.port}${utvonal}`, {
      method,
      headers: { 'content-type': 'application/json', ...(kulcs ? { 'x-access-key': kulcs } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error('crm_host_hivas_sikertelen')
  }
  if (!res.ok) throw new Error('crm_host_hivas_sikertelen')
  return res.json()
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
 * `extensionId === 'crm'`, `resourceKind === 'project'`, `resourceKey ===
 * 'crm'`. Ugyanezt a hármat követeli meg a host saját `findManagedProject`-je
 * (`src/lib/server/extension-managed-resources.ts`) is -- egy másik
 * extension, ami szintén `projectKey: 'crm'`-et deklarál (a kulcs csak az őt
 * deklaráló extensionön belül egyedi, host-szinten nem), pusztán a
 * `resourceKey`-re illesztve elnyerné a CRM feladatait, ha előbb szerepelne
 * a listában.
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
    && p.managedByExtension.extensionId === 'crm'
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

    /** A söprés az operátor gombjáról. Ugyanaz a törzs, mint az eszközé. */
    async sweepNow({ max } = {}) {
      return createSweep(state).runSweep({ max: Number(max) || 50 })
    },

    /** A figyelem-lista a lapnak. Ugyanaz a törzs, mint a crm_attention eszközé. */
    async attention({ limit } = {}) {
      return createAttention(state).list({ limit: Number(limit) || 50 })
    },

    async setSuggestionStatus({ suggestionId, status }) {
      if (status !== 'accepted' && status !== 'dismissed') throw new Error('crm_ismeretlen_javaslat_allapot')
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
     * előtte), hogy a host oldali cím-mező korlátja alatt maradjunk azzal a
     * névvel együtt is, amit elé fűzünk.
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
      const cim = `${acc ? acc.name : ''} — ${sug.text}`.slice(0, 120)
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
      const res = await hostFetch(state, '/api/tasks', body)
      const taskId = res && res.id ? String(res.id) : ''
      if (!taskId) throw new Error('crm_feladat_nem_jott_letre')
      // Sorrend: ELŐBB az ígéret lezárása, UTÁNA a javaslat elfogadottá
      // jelölése. Ha a kettő közt bármi elhasalna, a javaslat "new" marad --
      // ez az operátornak látható, újra elfogadható állapot --, nem pedig
      // "accepted", de a mögötte álló ígéret örökre nyitva ragadva. A
      // fordított sorrend épp azt az állapotot hozná vissza, amit ez a
      // feladat (7.) meg akart szüntetni: egy elfogadottnak jelölt javaslat,
      // ami mögött nincs valódi lezárás.
      if (sug.commitment_id) r.linkCommitmentTask(sug.commitment_id, taskId)
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
