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
