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
 * One video as the `video.videos` contract's `get` promises one: exactly the
 * eleven columns of `VIDEO_CONTRACT_COLUMNS`, and no twelfth.
 *
 * Shared rather than copied into each suite, because two hand-maintained
 * copies of a projection drift, and the drift is invisible: a suite testing
 * against a stale eleven columns passes while the real contract has moved.
 * `extensions/mcp-shim-parity.test.mjs` is what checks this shape against the
 * provider's own column list.
 */
export function videoRow(over = {}) {
  return {
    id: 'vid_1',
    cim: 'Miért drágul a kávé',
    status: 'kesz',
    forras_tipus: 'signal',
    forras_id: 'sig_9',
    out_path: 'out/vid_1.mp4',
    file_sha256: 'aabb',
    hossz_ms: 42300,
    narracio_szoveg: 'Első mondat. Második mondat.',
    created_at: '2026-09-01T10:00:00.000Z',
    qa_ok_at: '2026-09-01T11:00:00.000Z',
    ...over,
  }
}

/**
 * An `ExtensionContractError` as the host raises one, built by shape.
 *
 * The host's class is in `src/lib/server/extensions/extension-contracts.ts`
 * and an extension may not import from there, so the double carries the four
 * fields the consumer recognises it by and nothing else.
 */
export function contractError(code, extra = {}) {
  return Object.assign(new Error(`contract video.videos.get failed: ${code}`), {
    code,
    consumerId: 'docs.mjs',
    extensionId: 'video',
    contract: 'videos',
    method: 'get',
    ...extra,
  })
}
