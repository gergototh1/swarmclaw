import fs from 'node:fs'

import { createAttention } from './attention-service.mjs'
import { newId } from './ids.mjs'
import { createSweep } from './sweep.mjs'

/**
 * Hívás a host saját API-jára, a port-fájlon át.
 *
 * Ez az egyetlen út: az `ExtensionContext` nem ad task-API-t, és egy extension
 * nem importálhat a host `src/`-jéből. Ugyanaz a minta, amit a gmail MCP-shimje
 * használ -- a port-fájl a futó szerver egyetlen megbízható önleírása.
 *
 * A `fetchImpl` a teszt varrata: a CRM-1 óta a `state`-en ül, és itt kap
 * először használót. Éles kódban `globalThis.fetch`.
 *
 * A port-fájl csak akkor kötelező, ha a hívás ténylegesen a hálózatra megy --
 * `fetchImpl` jelenlétében a hívás magát a fetch-et helyettesíti, tehát nincs
 * mit feloldani, és egy teszt nem kell hogy egy valódi, futó szerverre mutasson
 * ahhoz, hogy a hívás alakját (metódus, fejlécek, törzs) ellenőrizhesse.
 *
 * A `method` alapértelmezetten `POST` -- a feladat-létrehozás ilyen --, de a
 * `/api/projects` GET-et vár, ezért a hívó felülírhatja.
 */
async function hostFetch(state, utvonal, body, method = 'POST') {
  let port = 0
  if (!state.fetchImpl) {
    const file = state.portFile
    if (!file || !fs.existsSync(file)) throw new Error('crm_nincs_port_fajl')
    try {
      port = JSON.parse(fs.readFileSync(file, 'utf8')).port
    } catch {
      throw new Error('crm_olvashatatlan_port_fajl')
    }
    if (!port) throw new Error('crm_nincs_port_fajl')
  }

  const kulcs = process.env.ACCESS_KEY || process.env.SWARMCLAW_ACCESS_KEY || ''
  const fetchFn = state.fetchImpl || globalThis.fetch
  const res = await fetchFn(`http://127.0.0.1:${port}${utvonal}`, {
    method,
    headers: { 'content-type': 'application/json', ...(kulcs ? { 'x-access-key': kulcs } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error('crm_host_hivas_sikertelen')
  return res.json()
}

/**
 * A CRM projekt azonosítója, a host projekt-listájából.
 *
 * Nem számoljuk ki: a host a `managedResourceId`-t egy hash-ből képzi, és egy
 * második, kézzel írt példány abban a pillanatban elcsúszna, amint a host
 * megváltoztatja a képzést. Megkérdezzük, és a `state`-en tartjuk -- a projekt
 * a telepítés élettartama alatt nem változik.
 *
 * Az `acceptSuggestion` szándékosan NEM ezt hívja: az a hívás egyetlen POST-ra
 * (a feladat-létrehozásra) épít a saját tesztjében, és egy itteni GET a
 * `/api/projects`-hez elcsúsztatná a hívás sorrendjét. A `board()` hívja meg
 * -- egyszer, lapmegnyitáskor --, hogy mire az operátor egy javaslatot
 * elfogad, a `state.crmProjectId` már megvan a gyorsítótárban.
 */
async function crmProjektId(state) {
  if (state.crmProjectId) return state.crmProjectId
  const lista = await hostFetch(state, '/api/projects', {}, 'GET').catch(() => null)
  const sorok = Array.isArray(lista) ? lista : Object.values(lista || {})
  const crm = sorok.find((p) => p && p.managedByExtension && p.managedByExtension.resourceKey === 'crm')
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
     * javaslatot elfogadna. A hívás önmagában sosem dob (lásd `crmProjektId`
     * doksiját): egy hiányzó port-fájl vagy egy elhasaló hívás legfeljebb
     * `null`-t hagy a gyorsítótárban, a lap többi része ettől függetlenül betölt.
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
     * ezért nincs `crm_accept_suggestion` eszköz. A `fingerprint` a javaslatra
     * mutat, tehát ugyanabból kétszer nem lesz két feladat.
     */
    async acceptSuggestion({ suggestionId }) {
      const r = repo()
      const sug = r.listSuggestions({}).find((s) => s.id === suggestionId)
      if (!sug) throw new Error('crm_ismeretlen_javaslat')

      const acc = r.getAccount(sug.account_id)
      const body = {
        title: String(sug.text || '').slice(0, 120),
        description: sug.reason ? `${sug.text}\n\nMiért: ${sug.reason}` : String(sug.text || ''),
        projectId: state.crmProjectId || null,
        tags: ['crm'],
        fingerprint: `crm:suggestion:${sug.id}`,
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
      r.setSuggestionStatus(suggestionId, 'accepted')
      // Ha a javaslat egy igeretbol jott, a feladat lezarja azt is. Enelkul a
      // figyelem-lista orokre ujra felhozna ugyanazt az igeretet, mikozben az
      // operator mar intezkedett -- es egy figyelmeztetes, ami nem mulik el,
      // az, amit a hasznalo megtanul atlapozni.
      if (sug.commitment_id) r.linkCommitmentTask(sug.commitment_id, taskId)
      return { suggestion: r.listSuggestions({}).find((s) => s.id === suggestionId), taskId }
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
