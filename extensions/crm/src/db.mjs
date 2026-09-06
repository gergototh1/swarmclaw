import { newId } from './ids.mjs'

/**
 * A séma. Egy verzió, mert az extension még nem járt éles adaton.
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
}])

const now = () => new Date().toISOString()
const str = (v) => (typeof v === 'string' ? v.trim() : '')

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

    listContacts(accountId) {
      return S.all(
        'SELECT * FROM ext_crm_contact WHERE account_id = ? ORDER BY name',
        [accountId],
      ).map(contactOut)
    },
  }
}
