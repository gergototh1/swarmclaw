import { newId } from './ids.mjs'

/**
 * A séma. Az 1-es verzió már lefutott éles adaton -- ezért nem írható át,
 * minden újabb tábla és oszlop új verziószámmal kerül a tömb végére.
 *
 * Két unique index hordozza a rendszer idempotenciáját: az `event` és az
 * `inbox_unmatched` `(source_system, source_id)` párja. A söprés emiatt
 * futtatható kétszer -- ami nem elméleti kényelem, hanem követelmény: a
 * setup() minden reloadkor lefut, és a behúzásnak ezt túl kell élnie.
 */
export const MIGRATIONS = Object.freeze([{
  version: 1,
  sql: `
CREATE TABLE IF NOT EXISTS ext_crm_account (
  id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'company', status TEXT NOT NULL DEFAULT 'lead',
  name TEXT NOT NULL, domains TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_crm_account_status ON ext_crm_account (status, name);

CREATE TABLE IF NOT EXISTS ext_crm_contact (
  id TEXT PRIMARY KEY, account_id TEXT, name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_crm_contact_account ON ext_crm_contact (account_id);

CREATE TABLE IF NOT EXISTS ext_crm_contact_email (
  address TEXT PRIMARY KEY, contact_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_crm_contact_email_contact ON ext_crm_contact_email (contact_id);

CREATE TABLE IF NOT EXISTS ext_crm_deal (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'lead',
  title TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new', value_huf INTEGER NOT NULL DEFAULT 0,
  expected_close TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  closed_at TEXT, close_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_crm_deal_account ON ext_crm_deal (account_id, closed_at);

CREATE TABLE IF NOT EXISTS ext_crm_event (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, deal_id TEXT, contact_id TEXT,
  kind TEXT NOT NULL, occurred_at TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',
  source_system TEXT NOT NULL DEFAULT 'manual', source_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_crm_event_source ON ext_crm_event (source_system, source_id);
CREATE INDEX IF NOT EXISTS ext_crm_event_account ON ext_crm_event (account_id, occurred_at);

CREATE TABLE IF NOT EXISTS ext_crm_event_body (
  event_id TEXT PRIMARY KEY, content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ext_crm_commitment (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, deal_id TEXT, event_id TEXT NOT NULL,
  text TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'ours',
  due_hint TEXT NOT NULL DEFAULT '', task_id TEXT, status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_crm_commitment_open ON ext_crm_commitment (status, direction, task_id);

CREATE TABLE IF NOT EXISTS ext_crm_summary (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, deal_id TEXT, text TEXT NOT NULL,
  covers_event_id TEXT NOT NULL DEFAULT '', covers_event_at TEXT NOT NULL DEFAULT '',
  generated_by_agent_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_crm_summary_account ON ext_crm_summary (account_id, created_at);

CREATE TABLE IF NOT EXISTS ext_crm_suggestion (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, deal_id TEXT, text TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '', trigger_kind TEXT NOT NULL DEFAULT '', trigger_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'new', agent_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_crm_suggestion_status ON ext_crm_suggestion (status, created_at);

CREATE TABLE IF NOT EXISTS ext_crm_inbox_unmatched (
  id TEXT PRIMARY KEY, source_system TEXT NOT NULL, source_id TEXT NOT NULL,
  sender_address TEXT NOT NULL DEFAULT '', sender_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL, guess_account_id TEXT,
  state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_crm_inbox_unmatched_source
  ON ext_crm_inbox_unmatched (source_system, source_id);
`,
}, {
  version: 2,
  sql: `
CREATE TABLE IF NOT EXISTS ext_crm_sweep_state (
  key TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
`,
}, {
  // A 2-es verzió a CRM-3-mal együtt már kiment -- lásd a 0407fa1 commitot --,
  // tehát ugyanúgy nem írható át, mint az 1-es: egy már lefutott migráció SQL-jét
  // szerkeszteni azon a telepítésen nem csinál semmit (lásd
  // `applyExtensionMigrations` a hoszt `extension-storage.ts`-ében: egy verzió
  // legfeljebb egyszer fut le, és soha nem fut újra). A `thread_id` ezért új,
  // 3-as verzióban érkezik.
  version: 3,
  sql: `
ALTER TABLE ext_crm_event ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS ext_crm_event_thread ON ext_crm_event (thread_id);
`,
}])

const now = () => new Date().toISOString()
const str = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * A `%` és `_` LIKE-joker escape-elése, hátraper-jellel.
 *
 * A `\` maga is escape-elendő, mert az `ESCAPE '\'` klauzula épp azt a
 * karaktert vezeti be jokerként. Escape nélkül egy `_` keresés minden
 * kapcsolatot visszaadna -- nem SQL-injekció (a lekérdezés paraméteres),
 * csak rossz eredmény.
 */
const escapeLike = (v) => v.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')

/**
 * Egy email-cím kanonikus alakja: levágva és kisbetűsítve.
 *
 * Egy helyen, mert a cím a hozzárendelés kulcsa: ha az írás és az olvasás
 * eltérően normalizálna, a `contact_email` unique indexe két sort engedne
 * ugyanarra a címre, és a lánc első lépése némán elvétené.
 */
export const normalizeAddress = (v) => str(v).toLowerCase()

/** Domain-lista: levágva, kisbetűsen, üresek nélkül, sorrendtartóan. */
const normalizeDomains = (v) =>
  (Array.isArray(v) ? v : []).map((d) => str(d).toLowerCase()).filter(Boolean)

const accountOut = (row) => (row ? { ...row, domains: JSON.parse(row.domains || '[]') } : null)
const contactOut = (row) => (row ? { ...row, accountId: row.account_id ?? null } : null)

export function createRepo(storage) {
  const S = storage

  const getAccount = (id) =>
    accountOut(S.get('SELECT * FROM ext_crm_account WHERE id = ?', [id]))

  const getContact = (id) =>
    contactOut(S.get('SELECT * FROM ext_crm_contact WHERE id = ?', [id]))

  const getEvent = (id) => S.get('SELECT * FROM ext_crm_event WHERE id = ?', [id])

  return {
    // ---- account -------------------------------------------------------
    createAccount({ type = 'company', status = 'lead', name, domains = [], notes = '' }) {
      const id = newId('acc')
      const at = now()
      S.exec(
        `INSERT INTO ext_crm_account (id, type, status, name, domains, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, type, status, str(name), JSON.stringify(normalizeDomains(domains)), str(notes), at, at],
      )
      return getAccount(id)
    },

    updateAccount(id, patch) {
      const existing = getAccount(id)
      if (!existing) return null
      const next = {
        type: patch.type ?? existing.type,
        status: patch.status ?? existing.status,
        name: patch.name === undefined ? existing.name : str(patch.name),
        domains: patch.domains === undefined ? existing.domains : normalizeDomains(patch.domains),
        notes: patch.notes === undefined ? existing.notes : str(patch.notes),
      }
      S.exec(
        `UPDATE ext_crm_account SET type = ?, status = ?, name = ?, domains = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
        [next.type, next.status, next.name, JSON.stringify(next.domains), next.notes, now(), id],
      )
      return getAccount(id)
    },

    getAccount,

    listAccounts({ status } = {}) {
      const rows = status
        ? S.all('SELECT * FROM ext_crm_account WHERE status = ? ORDER BY name', [status])
        : S.all('SELECT * FROM ext_crm_account ORDER BY name')
      return rows.map(accountOut)
    },

    /**
     * Az ügyfelek id-i, akiknek `domains`-je pontosan tartalmazza ezt a
     * domaint -- a `matching.mjs` 3. (tipp) ágának keresője.
     *
     * A `domains` JSON-tömbként van tárolva, tehát a szűrés memóriában
     * történik (`listAccounts({})` + `domains.includes(d)`), nem SQL
     * `LIKE`-kal. Egy szóló CRM ügyfélszámánál ez helyes döntés -- a
     * CRM-1 `mustDeal`-jénél ugyanez a mérlegelés már megtörtént.
     */
    accountsByDomain(domain) {
      const d = str(domain).toLowerCase()
      if (!d) return []
      return S.all('SELECT * FROM ext_crm_account ORDER BY name')
        .map(accountOut)
        .filter((acc) => acc.domains.includes(d))
        .map((acc) => acc.id)
    },

    // ---- contact -------------------------------------------------------
    createContact({ accountId = null, name, phone = '', role = '', notes = '' }) {
      const id = newId('con')
      const at = now()
      S.exec(
        `INSERT INTO ext_crm_contact (id, account_id, name, phone, role, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, accountId, str(name), str(phone), str(role), str(notes), at, at],
      )
      return contactOut(S.get('SELECT * FROM ext_crm_contact WHERE id = ?', [id]))
    },

    /**
     * Egy címet egy kapcsolathoz köt.
     *
     * Az `address` az elsődleges kulcs, tehát a második írás ugyanarra a
     * címre a MEGLÉVŐ sort írja át, nem duplikál. Ez szándékos: a hozzárendelés
     * szabálya, hogy egy cím egy emberhez tartozik, és ha egy címről kiderül,
     * hogy mégis máshoz, akkor az átkötés a helyes válasz, nem két sor.
     */
    attachEmail(contactId, address, source = 'manual') {
      const addr = normalizeAddress(address)
      if (!addr) throw new Error('crm_ures_email_cim')
      S.exec(
        `INSERT INTO ext_crm_contact_email (address, contact_id, source, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET contact_id = excluded.contact_id, source = excluded.source`,
        [addr, contactId, source, now()],
      )
      return { address: addr, contactId, source }
    },

    contactByEmail(address) {
      const row = S.get(
        `SELECT c.* FROM ext_crm_contact_email e
         JOIN ext_crm_contact c ON c.id = e.contact_id
         WHERE e.address = ?`,
        [normalizeAddress(address)],
      )
      return contactOut(row)
    },

    getContact,

    listContacts(accountId) {
      return S.all(
        'SELECT * FROM ext_crm_contact WHERE account_id = ? ORDER BY name',
        [accountId],
      ).map(contactOut)
    },

    /**
     * Kapcsolat keresése névre, az ügyfél-határtól függetlenül.
     *
     * A `listContacts` egy ügyfélhez köt; egy `account_id IS NULL` kapcsolat
     * oda soha nem kerül be. A keresésnek viszont nem szabad ügyfélhez
     * kötnie: az ügynök a nevet ismeri, nem azt, hogy a kapcsolat melyik
     * ügyfélhez van (vagy egyáltalán van-e) rendelve.
     */
    searchContacts(query) {
      const like = `%${escapeLike(str(query).toLowerCase())}%`
      return S.all(
        "SELECT * FROM ext_crm_contact WHERE LOWER(name) LIKE ? ESCAPE '\\' ORDER BY name",
        [like],
      ).map(contactOut)
    },

    // ---- deal ----------------------------------------------------------
    createDeal({ accountId, kind = 'lead', title, stage = 'new', valueHuf = 0, expectedClose = '', source = '' }) {
      const id = newId('deal')
      const at = now()
      S.exec(
        `INSERT INTO ext_crm_deal
           (id, account_id, kind, title, stage, value_huf, expected_close, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, accountId, kind, str(title), stage, Number(valueHuf) || 0, str(expectedClose), str(source), at, at],
      )
      return S.get('SELECT * FROM ext_crm_deal WHERE id = ?', [id])
    },

    updateDeal(id, patch) {
      const existing = S.get('SELECT * FROM ext_crm_deal WHERE id = ?', [id])
      if (!existing) return null
      S.exec(
        `UPDATE ext_crm_deal SET kind = ?, title = ?, stage = ?, value_huf = ?,
           expected_close = ?, source = ?, updated_at = ? WHERE id = ?`,
        [patch.kind ?? existing.kind,
         patch.title === undefined ? existing.title : str(patch.title),
         patch.stage ?? existing.stage,
         patch.valueHuf === undefined ? existing.value_huf : Number(patch.valueHuf) || 0,
         patch.expectedClose === undefined ? existing.expected_close : str(patch.expectedClose),
         patch.source === undefined ? existing.source : str(patch.source),
         now(), id],
      )
      return S.get('SELECT * FROM ext_crm_deal WHERE id = ?', [id])
    },

    /**
     * Lezárás. Külön metódus a frissítéstől, mert ez az a művelet, amit az
     * ügynök nem hívhat (spec 5.4), és egy külön néven ez a diffből látszik.
     */
    closeDeal(id, { stage, reason = '' }) {
      const at = now()
      S.exec(
        'UPDATE ext_crm_deal SET stage = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?',
        [stage, at, str(reason), at, id],
      )
      return S.get('SELECT * FROM ext_crm_deal WHERE id = ?', [id])
    },

    listDeals({ accountId, openOnly } = {}) {
      const where = []
      const params = []
      if (accountId) { where.push('account_id = ?'); params.push(accountId) }
      if (openOnly) where.push('closed_at IS NULL')
      const sql = `SELECT * FROM ext_crm_deal${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY updated_at DESC`
      return S.all(sql, params)
    },

    // ---- event ---------------------------------------------------------
    /**
     * Egy esemény felvétele, idempotensen.
     *
     * A `(source_system, source_id)` unique indexe dönt, nem egy előzetes
     * SELECT: két egyszerre futó söprés között a SELECT és az INSERT közé
     * befér a másik írása. Az `ON CONFLICT DO NOTHING` után visszaolvasunk,
     * és a `created` abból derül ki, hogy a visszakapott sor a mi id-nkat
     * viseli-e.
     */
    recordEvent({ accountId, dealId = null, contactId = null, kind, occurredAt,
                  title = '', excerpt = '', sourceSystem = 'manual', sourceId, body = '',
                  threadId = '' }) {
      const id = newId('evt')
      return S.transaction(() => {
        S.exec(
          `INSERT INTO ext_crm_event
             (id, account_id, deal_id, contact_id, kind, occurred_at, title, excerpt,
              source_system, source_id, thread_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_system, source_id) DO NOTHING`,
          [id, accountId, dealId, contactId, kind, occurredAt, str(title), str(excerpt),
           sourceSystem, sourceId, str(threadId), now()],
        )
        const event = S.get(
          'SELECT * FROM ext_crm_event WHERE source_system = ? AND source_id = ?',
          [sourceSystem, sourceId],
        )
        const created = event.id === id
        if (created && body) {
          S.exec('INSERT INTO ext_crm_event_body (event_id, content) VALUES (?, ?)', [event.id, body])
        }
        return { event, created }
      })
    },

    getEvent,

    getEventBody(eventId) {
      const row = S.get('SELECT content FROM ext_crm_event_body WHERE event_id = ?', [eventId])
      return row ? row.content : ''
    },

    /**
     * Az idővonal egy lapja, a legfrissebbel kezdve.
     *
     * A `content` szándékosan nincs a SELECT-ben. Ha itt lenne, egy húsz
     * levelet és három leiratot tartó ügyfél minden lekérdezésnél
     * kontextus-ablakot töltene (spec 5.2).
     */
    listEvents({ accountId, before, limit = 50 }) {
      const params = [accountId]
      let sql = 'SELECT * FROM ext_crm_event WHERE account_id = ?'
      if (before) { sql += ' AND occurred_at < ?'; params.push(before) }
      sql += ' ORDER BY occurred_at DESC LIMIT ?'
      params.push(limit)
      return S.all(sql, params)
    },

    lastEventAt(accountId) {
      const row = S.get(
        'SELECT MAX(occurred_at) AS at FROM ext_crm_event WHERE account_id = ?',
        [accountId],
      )
      return row && row.at ? row.at : null
    },

    /**
     * Melyik ügyfélhez tartozik ez a levélszál, a szál már besorolt
     * üzeneteiből -- a `matching.mjs` 2. ága ezt hívja.
     */
    accountIdByThread(threadId) {
      const row = S.get(
        'SELECT account_id FROM ext_crm_event WHERE thread_id = ? LIMIT 1',
        [str(threadId)],
      )
      return row ? row.account_id : null
    },

    // ---- commitment ----------------------------------------------------
    writeCommitment({ accountId, dealId = null, eventId, text, direction = 'ours', dueHint = '' }) {
      const id = newId('cmt')
      const at = now()
      S.exec(
        `INSERT INTO ext_crm_commitment
           (id, account_id, deal_id, event_id, text, direction, due_hint, task_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?)`,
        [id, accountId, dealId, eventId, str(text), direction, str(dueHint), at, at],
      )
      return S.get('SELECT * FROM ext_crm_commitment WHERE id = ?', [id])
    },

    linkCommitmentTask(id, taskId) {
      S.exec('UPDATE ext_crm_commitment SET task_id = ?, updated_at = ? WHERE id = ?', [taskId, now(), id])
      return S.get('SELECT * FROM ext_crm_commitment WHERE id = ?', [id]) || null
    },

    /** `openOnly` itt azt jelenti: nyitott ÉS még nincs feladata. Ez a spec 6. trigger-3-a. */
    listCommitments({ accountId, direction, openOnly } = {}) {
      const where = []
      const params = []
      if (accountId) { where.push('account_id = ?'); params.push(accountId) }
      if (direction) { where.push('direction = ?'); params.push(direction) }
      if (openOnly) where.push("status = 'open' AND task_id IS NULL")
      return S.all(
        `SELECT * FROM ext_crm_commitment${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC`,
        params,
      )
    },

    // ---- summary -------------------------------------------------------
    /**
     * Összefoglaló. A `covers_event_id`-t EZ állítja be, nem a hívó.
     *
     * Ez a fejezet egyetlen fontos sora. Ha az ügynök adhatná meg, akkor
     * állíthatná, hogy többet fedett le, mint amennyit elolvasott, és az
     * elavultság-jelzés udvariassági kérdéssé válna a tény helyett.
     */
    writeSummary({ accountId, dealId = null, text, agentId = '' }) {
      const newest = S.get(
        'SELECT id, occurred_at FROM ext_crm_event WHERE account_id = ? ORDER BY occurred_at DESC LIMIT 1',
        [accountId],
      )
      const id = newId('sum')
      S.exec(
        `INSERT INTO ext_crm_summary
           (id, account_id, deal_id, text, covers_event_id, covers_event_at, generated_by_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, accountId, dealId, str(text), newest ? newest.id : '', newest ? newest.occurred_at : '',
         str(agentId), now()],
      )
      return S.get('SELECT * FROM ext_crm_summary WHERE id = ?', [id])
    },

    /**
     * A legfrissebb összefoglaló, és hogy elavult-e.
     *
     * A `newerEvents` egy COUNT, nem modellhívás: az oldal és az ügynök is
     * ebből tudja, érdemes-e újat írni.
     */
    latestSummary(accountId) {
      const summary = S.get(
        'SELECT * FROM ext_crm_summary WHERE account_id = ? ORDER BY created_at DESC LIMIT 1',
        [accountId],
      )
      if (!summary) return null
      const row = S.get(
        'SELECT COUNT(*) AS n FROM ext_crm_event WHERE account_id = ? AND occurred_at > ?',
        [accountId, summary.covers_event_at || ''],
      )
      const newerEvents = row ? row.n : 0
      return { summary, stale: newerEvents > 0, newerEvents }
    },

    // ---- suggestion ----------------------------------------------------
    writeSuggestion({ accountId, dealId = null, text, reason = '', triggerKind = '',
                      triggerEventId = null, agentId = '' }) {
      const id = newId('sug')
      const at = now()
      S.exec(
        `INSERT INTO ext_crm_suggestion
           (id, account_id, deal_id, text, reason, trigger_kind, trigger_event_id,
            status, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
        [id, accountId, dealId, str(text), str(reason), str(triggerKind), triggerEventId,
         str(agentId), at, at],
      )
      return S.get('SELECT * FROM ext_crm_suggestion WHERE id = ?', [id])
    },

    setSuggestionStatus(id, status) {
      S.exec('UPDATE ext_crm_suggestion SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id])
      return S.get('SELECT * FROM ext_crm_suggestion WHERE id = ?', [id]) || null
    },

    listSuggestions({ status } = {}) {
      return status
        ? S.all('SELECT * FROM ext_crm_suggestion WHERE status = ? ORDER BY created_at DESC', [status])
        : S.all('SELECT * FROM ext_crm_suggestion ORDER BY created_at DESC')
    },

    // ---- inbox_unmatched ------------------------------------------------
    recordUnmatched({ sourceSystem, sourceId, senderAddress = '', senderName = '', subject = '',
                      excerpt = '', receivedAt, guessAccountId = null }) {
      const id = newId('unm')
      return S.transaction(() => {
        S.exec(
          `INSERT INTO ext_crm_inbox_unmatched
             (id, source_system, source_id, sender_address, sender_name, subject, excerpt,
              received_at, guess_account_id, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
           ON CONFLICT(source_system, source_id) DO NOTHING`,
          [id, sourceSystem, sourceId, normalizeAddress(senderAddress), str(senderName),
           str(subject), str(excerpt), receivedAt, guessAccountId, now()],
        )
        const row = S.get(
          'SELECT * FROM ext_crm_inbox_unmatched WHERE source_system = ? AND source_id = ?',
          [sourceSystem, sourceId],
        )
        return { row, created: row.id === id }
      })
    },

    listUnmatched() {
      return S.all("SELECT * FROM ext_crm_inbox_unmatched WHERE state = 'open' ORDER BY received_at DESC")
    },

    resolveUnmatched(id) {
      S.exec("UPDATE ext_crm_inbox_unmatched SET state = 'assigned' WHERE id = ?", [id])
      return S.get('SELECT * FROM ext_crm_inbox_unmatched WHERE id = ?', [id]) || null
    },

    // ---- sweep_state ----
    /**
     * Hol tart a söprés. Egy sor forrásonként (`key`), mert a CRM-4 leiratai
     * és a naptár saját kurzort visznek majd.
     */
    getSweepState(key) {
      return S.get('SELECT * FROM ext_crm_sweep_state WHERE key = ?', [key]) || null
    },

    setSweepState(key, { cursor = '', lastSeenAt = '' } = {}) {
      S.exec(
        `INSERT INTO ext_crm_sweep_state (key, cursor, last_seen_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor,
           last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
        [key, str(cursor), str(lastSeenAt), now()],
      )
      return S.get('SELECT * FROM ext_crm_sweep_state WHERE key = ?', [key])
    },
  }
}
