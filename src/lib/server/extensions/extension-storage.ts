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
 *
 * The prefix does NOT identify exactly one extension. The mapping is lossy: the
 * extension suffix is dropped, every non-alphanumeric character becomes '_' and
 * the result is lowercased, so 'ai-signal.mjs', 'ai_signal.mjs' and
 * 'AI.Signal.js' all yield 'ext_ai_signal_'. ext_migrations, by contrast, keys
 * on the raw filename. Two extensions that collide this way would each see
 * their own migrations as unapplied, both create the same tables and then
 * silently share rows. Nothing detects that today; if it ever needs to be
 * prevented, the check belongs where an extension file is installed, not here.
 */
export function extensionTablePrefix(extensionId: string): string {
  const base = extensionId.replace(/\.(m?js)$/i, '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
  return `ext_${base}_`
}

/**
 * Table name of a CREATE [TEMP|TEMPORARY|VIRTUAL] TABLE [IF NOT EXISTS]
 * statement, or of a CREATE [TEMP|TEMPORARY] VIEW [IF NOT EXISTS] statement.
 * A plain (non-temp) CREATE VIEW is deliberately not matched — see the doc
 * comment on validateMigrationSql for why.
 *
 * The separator after TABLE/VIEW (and after EXISTS) is whitespace *or* an
 * opening quote, because `CREATE TABLE"evil"(...)` is legal SQLite: the quote
 * is its own token. Brackets are quote characters here for the same reason
 * SQLite treats them as such.
 *
 * The captured name may be empty, and that is deliberate: a name SQLite accepts
 * but this pattern cannot spell (`"évil"` with a non-ascii letter, say) then
 * matches as an empty name instead of backtracking into the IF NOT EXISTS
 * keywords and reporting a table called "IF". validateMigrationSql turns an
 * empty capture into its own message.
 */
const CREATE_TABLE_RE = /create\s+(?:(?:temp|temporary)\s+view|(?:(?:temp|temporary|virtual)\s+)?table)(?:\s+|(?=["'`[]))(?:if\s+not\s+exists(?:\s+|(?=["'`[])))?["'`[]?([A-Za-z0-9_]*)/gi

/**
 * Checks the CREATE TABLE and CREATE [TEMP|TEMPORARY] VIEW names in a
 * migration against the extension's prefix. Deliberately a regex over the
 * declared migration text rather than a SQL parser: the point is to catch a
 * typo or a careless copy-paste at install time, not to contain a hostile
 * extension (which this could not do anyway — extensions are trusted,
 * same-process code that can already reach anything the host can).
 *
 * CREATE TEMP TABLE and CREATE TEMP VIEW are both checked, and that matters
 * more than tidiness: migrations run on the host's shared connection, SQLite
 * resolves the temp schema before main, so an unprefixed temp table or temp
 * view named after a host table (e.g. `settings`) shadows it for the rest of
 * the process — every later host read of that name sees the extension's
 * empty temp object instead. The migration is still recorded as applied, so
 * a restart hides the symptom and it never runs again.
 *
 * A plain (non-temp) CREATE VIEW is not checked, and not because it is safe.
 * It is not: an unprefixed view in the main schema, under a name the host
 * adopts in a later version, shadows that table permanently and across
 * restarts — worse than the temp case, not milder. `CREATE TABLE IF NOT
 * EXISTS settings` against an existing *view* named settings is silently
 * skipped by SQLite and the name stays a view, and the host creates its own
 * tables with CREATE TABLE IF NOT EXISTS in six places. It goes unchecked for
 * the same reason as everything else on the list below: this pattern
 * enumerates the spellings that were surveyed, and is not a SQL parser.
 *
 * What this does not catch: a plain CREATE VIEW; a comment inside the
 * statement (put a /*c*\/ block comment between TEMP and TABLE and
 * `CREATE TEMP TABLE settings (id)` matches nothing and validates ok — the
 * same silent-shadow bug in a spelling nobody enumerated); ALTER TABLE, DROP
 * TABLE, CREATE TRIGGER and CREATE INDEX; and ordinary DML (INSERT, UPDATE,
 * DELETE, SELECT) against a host table. A name that only appears inside a
 * comment or a string literal is treated as if it were a real declaration. None of that can be caught without actually parsing
 * the SQL, which this deliberately does not do. Do not read this function as a
 * guarantee that a migration cannot touch host tables — it is not one, and
 * was never meant to be.
 */
export function validateMigrationSql(prefix: string, sql: string): { ok: true } | { ok: false; error: string } {
  for (const m of sql.matchAll(CREATE_TABLE_RE)) {
    const name = m[1]
    if (!name) {
      return { ok: false, error: `could not read the table name in "${m[0].trim()}": spell it with letters, digits and underscore only, starting with "${prefix}"` }
    }
    if (name.startsWith(prefix)) continue
    if (name.toLowerCase().startsWith(prefix)) {
      return { ok: false, error: `table "${name}" must start with "${prefix}": the prefix is compared case-sensitively, so declare the name in lower case` }
    }
    return { ok: false, error: `table "${name}" must start with "${prefix}"` }
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

/** DROP keyword per sqlite_master type. Anything else is left alone. */
const DROPPABLE_OBJECT_TYPES: Record<string, string> = { trigger: 'TRIGGER', view: 'VIEW', table: 'TABLE' }

/**
 * Drops everything one extension owns in the database: its ext_migrations rows
 * and every table, view and trigger under its `ext_<id>_` prefix, minus the
 * objects that belong to another installed extension (see below). Called on
 * uninstall, with the ids of the extension files still present.
 *
 * Without it an uninstall leaves the schema behind while the file is gone, so
 * reinstalling a version whose v1 declares a different shape finds the old
 * ext_migrations row, skips the migration, and every tool call fails at runtime
 * with "no such column" while load time reports success. Views and triggers are
 * dropped for the same reason from the other side: a migration may legally
 * create a prefixed view, and a survivor makes the reinstall's re-run of that
 * same migration die with "view ... already exists", so the extension never
 * loads again.
 *
 * Prefixes nest, which is why `otherExtensionIds` exists. 'notes.mjs' yields
 * 'ext_notes_' and 'notes_pro.mjs' yields 'ext_notes_pro_', so a plain
 * startsWith test would drop the still-installed notes_pro tables while its
 * ext_migrations rows (keyed on the exact id) survive — its migrations then
 * count as applied forever, the tables are never recreated and every tool call
 * fails with "no such table". So any name that also matches a longer prefix of
 * an extension still on disk is skipped. Equally-long prefixes are the lossy
 * collision described on extensionTablePrefix and are still not handled here.
 *
 * Tolerates the cases an uninstall actually hits: an extension that never ran a
 * migration, a database where ext_migrations was never created, and a table
 * recorded in ext_migrations that no longer exists. Objects and rows go in one
 * transaction so an uninstall never half-drops a schema.
 */
export function dropExtensionStorage(extensionId: string, otherExtensionIds: string[] = []): { droppedObjects: string[]; droppedMigrationRows: number } {
  const db = getDb()
  const prefix = extensionTablePrefix(extensionId)
  const siblingPrefixes = otherExtensionIds
    .map((id) => extensionTablePrefix(id))
    .filter((other) => other.length > prefix.length && other.startsWith(prefix))
  // sqlite_master is filtered in JS, not with LIKE: the prefix contains '_',
  // which LIKE reads as a single-character wildcard. Triggers go before views
  // and views before tables, so nothing is dropped out from under a dependant.
  const objects = (db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view', 'table') ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name").all() as Array<{ type: string; name: string }>)
    .filter((row) => {
      const name = row.name.toLowerCase()
      return name.startsWith(prefix) && !siblingPrefixes.some((sibling) => name.startsWith(sibling))
    })
    .filter((row) => DROPPABLE_OBJECT_TYPES[row.type] !== undefined)
  const hasMigrationsTable = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ext_migrations'").get() != null

  let droppedMigrationRows = 0
  db.transaction(() => {
    for (const row of objects) db.exec(`DROP ${DROPPABLE_OBJECT_TYPES[row.type]} IF EXISTS "${row.name.replace(/"/g, '""')}"`)
    if (hasMigrationsTable) {
      droppedMigrationRows = db.prepare('DELETE FROM ext_migrations WHERE extension_id = ?').run(extensionId).changes
    }
  })()

  return { droppedObjects: objects.map((row) => row.name), droppedMigrationRows }
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
    // One statement per call: this prepares the SQL, unlike migrations, which
    // go through db.exec(). See the note on ExtensionStorage.exec.
    exec(sql, params = []) { db.prepare(sql).run(...params) },
    all<T>(sql: string, params: unknown[] = []): T[] { return db.prepare(sql).all(...params) as T[] },
    get<T>(sql: string, params: unknown[] = []): T | undefined { return db.prepare(sql).get(...params) as T | undefined },
    transaction(fn) { return db.transaction(fn)() },
  }
}
