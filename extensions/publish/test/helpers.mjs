import { DatabaseSync } from 'node:sqlite'

import { MIGRATIONS, createRepo } from '../src/db.mjs'

/**
 * An in-memory stand-in for the `ExtensionStorage` handle the host passes to
 * `setup(ctx)`.
 *
 * Copied from `extensions/video/test/helpers.mjs`, on the brief's own
 * instruction not to invent a third harness. The host handle wraps
 * `better-sqlite3` on the shared application connection; that is a native
 * module compiled against either Node's or Electron's ABI and cannot be
 * opened twice from a test, so the repository is exercised against
 * `node:sqlite` instead. The two speak the same SQL, and the surface copied
 * here is deliberately the whole contract: `exec` runs exactly one statement
 * (it prepares the SQL, so a semicolon-separated batch throws, same as the
 * host), `all`/`get` read, and `transaction` rolls back and rethrows.
 *
 * `raw` is the extra: migrations do not go through `exec` on the host either,
 * they go through a `db.exec()` path that accepts a whole batch, so the tests
 * apply `MIGRATIONS` through `raw.exec` for the same reason.
 *
 * `transaction` nests, because the host's does. On the host it is
 * `db.transaction(fn)()` from better-sqlite3, which opens a SAVEPOINT when it
 * is already inside a transaction. `node:sqlite` throws on a second BEGIN, so
 * the same shape is written out here: an outer call uses BEGIN/COMMIT/ROLLBACK,
 * an inner one a named savepoint that releases or rolls back to itself.
 * Without this the double would refuse a composition the host allows, which is
 * the one thing a test double must never do.
 */
export function memStorage() {
  const db = new DatabaseSync(':memory:')
  let depth = 0
  return {
    exec: (sql, p = []) => { db.prepare(sql).run(...p) },
    all: (sql, p = []) => db.prepare(sql).all(...p),
    get: (sql, p = []) => db.prepare(sql).get(...p),
    transaction: (fn) => {
      const nested = depth > 0
      const sp = `sp_${depth}`
      db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN')
      depth += 1
      try {
        const r = fn()
        db.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
        return r
      } catch (e) {
        db.exec(nested ? `ROLLBACK TO ${sp}` : 'ROLLBACK')
        if (nested) db.exec(`RELEASE ${sp}`)
        throw e
      } finally {
        depth -= 1
      }
    },
    raw: db,
  }
}

/** A repository over a fresh in-memory database with every migration applied. */
export function freshRepo() {
  const storage = memStorage()
  for (const m of MIGRATIONS) storage.raw.exec(m.sql)
  return { storage, repo: createRepo(storage) }
}
