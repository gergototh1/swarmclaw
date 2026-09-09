import { DatabaseSync } from 'node:sqlite'

/**
 * An in-memory stand-in for the `ExtensionStorage` handle the host passes to
 * `setup(ctx)`.
 *
 * The host handle wraps `better-sqlite3` on the shared application connection;
 * that is a native module compiled against either Node's or Electron's ABI and
 * cannot be opened twice from a test, so the repository is exercised against
 * `node:sqlite` instead. The two speak the same SQL, and the surface copied
 * here is deliberately the whole contract: `exec` runs exactly one statement
 * (it prepares the SQL, so a semicolon-separated batch throws, same as the
 * host), `all`/`get` read, and `transaction` rolls back and rethrows.
 *
 * `raw` is the extra: migrations do not go through `exec` on the host either,
 * they go through a `db.exec()` path that accepts a whole batch, so the tests
 * apply `MIGRATIONS` through `raw.exec` for the same reason.
 */
export function memStorage() {
  const db = new DatabaseSync(':memory:')
  return {
    exec: (sql, p = []) => { db.prepare(sql).run(...p) },
    all: (sql, p = []) => db.prepare(sql).all(...p),
    get: (sql, p = []) => db.prepare(sql).get(...p),
    transaction: (fn) => {
      db.exec('BEGIN')
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    raw: db,
  }
}

/**
 * A `mailbox` szerződés kettőse, ami a GMAIL VALÓDI `labelIds`-SZEMANTIKÁJÁT
 * utánozza: a `users.messages.list` `labelIds` paramétere ÉS-kapcsolat, tehát
 * csak az a levél jön vissza, amelyiken MINDEN felsorolt címke rajta van.
 *
 * EZ NEM PEDANTÉRIA, HANEM PONTOSAN AZ A HIBA, AMIT EZ A DUPLA FOG. A söprés
 * korábban egyetlen `list({ labelIds: ['INBOX','SENT'] })` hívást tett, és
 * mivel egy levél vagy a beérkezettben van, vagy elküldött, sosem mindkettő,
 * a valódi Gmail üres halmazt adott rá -- a söprés élesben EGYETLEN levelet
 * sem húzott be, miközben egy címkére közömbös dublőr mellett minden teszt
 * zöld maradt. A dublőr, ami nem nézi a `labelIds`-t, ezt a hibát elfedi.
 *
 * `q` és `cursor` szándékosan nincs modellezve: a hiba a címkékben volt, és
 * egy féllábon álló keresés-utánzat csak új, hamis feltevéseket szülne.
 */
export function gmailFakeMailbox(uzenetek) {
  return {
    list: async ({ labelIds = [] } = {}) => {
      const kert = labelIds.map((l) => String(l))
      const talalat = uzenetek.filter((u) => kert.every((l) => (u.labelIds || []).includes(l)))
      return { ids: talalat.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }
    },
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
}
