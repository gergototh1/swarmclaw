import { getDb } from '@/lib/server/storage'
import type { ExtensionMigration, ExtensionStorage } from '@/types/extension'

/**
 * Extensions never open their own database.
 *
 * `better-sqlite3` is a native module: the desktop build is compiled against
 * Electron's ABI and the server build against Node's, and the two are not
 * interchangeable. An extension that bundled its own copy would work in one
 * host and die with ERR_DLOPEN_FAILED in the other. So an extension gets a thin
 * handle onto the connection the host already has open, and that is the whole
 * reason this module exists. Do not "simplify" it into a per-extension
 * Database instance.
 */

/**
 * Table-name prefix for one extension, e.g. 'aisignal.mjs' -> 'ext_aisignal_'.
 *
 * This is a tidiness and clean-uninstall convention, NOT an isolation boundary.
 * Extensions are trusted, same-process code and can already reach everything
 * the host can reach; the prefix just keeps their tables recognisable and
 * makes it possible to drop them on uninstall. It is enforced on the migration
 * declarations only (see validateMigrationSql) — runtime SQL is not parsed or
 * restricted, and nothing here should be mistaken for a sandbox.
 */
export function extensionTablePrefix(extensionId: string): string {
  const base = extensionId.replace(/\.(m?js)$/i, '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
  return `ext_${base}_`
}

const CREATE_TABLE_RE = /create\s+(?:temp|temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?["'`]?([A-Za-z0-9_]+)/gi

/**
 * Checks the CREATE TABLE names in a migration against the extension's prefix.
 * Deliberately a regex over the declared migration text rather than a SQL
 * parser: the point is to catch a typo or a careless copy-paste at install
 * time, not to contain a hostile extension (which this could not do anyway).
 */
export function validateMigrationSql(prefix: string, sql: string): { ok: true } | { ok: false; error: string } {
  for (const m of sql.matchAll(CREATE_TABLE_RE)) {
    const name = m[1]
    if (!name.startsWith(prefix)) return { ok: false, error: `table "${name}" must start with "${prefix}"` }
  }
  return { ok: true }
}

function ensureMigrationsTable(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS ext_migrations (extension_id TEXT NOT NULL, version INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (extension_id, version))')
}

/**
 * Applies the extension's not-yet-applied migrations in version order.
 *
 * Each migration runs in its own transaction together with its ext_migrations
 * row, so a statement that fails halfway leaves neither its tables nor its
 * bookkeeping row behind; migrations that already succeeded stay applied.
 * A version is applied at most once and is never re-run, so editing the SQL of
 * an already-applied version has no effect — ship a new version instead.
 */
export function runExtensionMigrations(extensionId: string, migrations: ExtensionMigration[] | undefined): { applied: number[] } {
  if (!migrations?.length) return { applied: [] }
  const db = getDb()
  const prefix = extensionTablePrefix(extensionId)

  const declared = new Set<number>()
  for (const m of migrations) {
    if (!Number.isInteger(m?.version)) throw new Error(`migration of ${extensionId}: version must be an integer, got ${JSON.stringify(m?.version)}`)
    if (typeof m?.sql !== 'string' || !m.sql.trim()) throw new Error(`migration v${m?.version} of ${extensionId}: sql must be a non-empty string`)
    if (declared.has(m.version)) throw new Error(`migration version ${m.version} of ${extensionId} is declared twice`)
    declared.add(m.version)
  }

  ensureMigrationsTable()
  const done = new Set((db.prepare('SELECT version FROM ext_migrations WHERE extension_id = ?').all(extensionId) as Array<{ version: number }>).map((r) => r.version))
  const applied: number[] = []
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  for (const m of ordered) {
    if (done.has(m.version)) continue
    const check = validateMigrationSql(prefix, m.sql)
    if (!check.ok) throw new Error(`migration v${m.version} of ${extensionId}: ${check.error}`)
    try {
      db.transaction(() => {
        db.exec(m.sql)
        db.prepare('INSERT INTO ext_migrations (extension_id, version, applied_at) VALUES (?, ?, ?)').run(extensionId, m.version, Date.now())
      })()
    } catch (err: unknown) {
      throw new Error(`migration v${m.version} of ${extensionId} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`)
    }
    applied.push(m.version)
  }
  return { applied }
}

/**
 * A handle onto the host's SQLite connection, handed to the extension in
 * `setup(ctx)`. `extensionId` is only there so a caller must name the
 * extension it is building the handle for; nothing is scoped by it, for the
 * reason described on extensionTablePrefix above.
 */
export function createExtensionStorage(extensionId: string): ExtensionStorage {
  const db = getDb()
  void extensionId
  return {
    exec(sql, params = []) { db.prepare(sql).run(...params) },
    all<T>(sql: string, params: unknown[] = []): T[] { return db.prepare(sql).all(...params) as T[] },
    get<T>(sql: string, params: unknown[] = []): T | undefined { return db.prepare(sql).get(...params) as T | undefined },
    transaction(fn) { return db.transaction(fn)() },
  }
}
