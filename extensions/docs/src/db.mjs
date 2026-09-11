/**
 * The index over the files, and the version history beside it.
 *
 * Four tables, all prefixed `ext_docs_` because the host derives that prefix
 * from the extension's file name (`docs.mjs`) and refuses a migration that
 * declares anything else. The comparison is case sensitive, so the names are
 * lower case.
 *
 * NONE OF THIS IS THE TRUTH. `ext_docs_docs`, `ext_docs_fts` and
 * `ext_docs_links` are derived from what is on disk and a full reindex rebuilds
 * every one of them. The single exception is `ext_docs_versions`, which is
 * history rather than state: it records what a document used to say, and no
 * walk of the current files could reconstruct it.
 *
 * The FTS table is a standalone FTS5 table rather than one bound to `docs` with
 * `content=`. That costs one extra write per document -- the row and the FTS
 * entry are written separately -- and buys not having to maintain the three
 * synchronisation triggers an external-content table needs, where a missed
 * trigger corrupts the index silently.
 */

const TOKENIZER = 'unicode61 remove_diacritics 2'

export const MIGRATIONS = Object.freeze([{
  version: 1,
  sql: `
CREATE TABLE IF NOT EXISTS ext_docs_docs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  title_lower TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created TEXT NOT NULL DEFAULT '',
  updated TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ext_docs_docs_owner ON ext_docs_docs (owner);
CREATE INDEX IF NOT EXISTS ext_docs_docs_updated ON ext_docs_docs (updated);
CREATE INDEX IF NOT EXISTS ext_docs_docs_title ON ext_docs_docs (title);
CREATE INDEX IF NOT EXISTS ext_docs_docs_title_lower ON ext_docs_docs (title_lower);

CREATE VIRTUAL TABLE IF NOT EXISTS ext_docs_fts USING fts5(
  doc_id UNINDEXED, title, body,
  tokenize='${TOKENIZER}'
);

CREATE TABLE IF NOT EXISTS ext_docs_versions (
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, version)
);

CREATE TABLE IF NOT EXISTS ext_docs_links (
  from_id TEXT NOT NULL,
  to_id TEXT,
  to_raw TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ext_docs_links_from ON ext_docs_links (from_id);
CREATE INDEX IF NOT EXISTS ext_docs_links_to ON ext_docs_links (to_id);
CREATE INDEX IF NOT EXISTS ext_docs_links_raw ON ext_docs_links (to_raw);
`,
}])

/**
 * Case folding that knows about more than ASCII.
 *
 * SQLite's own `lower()` folds ASCII and nothing else, so `lower('Ü')` is still
 * `'Ü'` and a case-insensitive title match would never fire on a Hungarian
 * title. The fold is therefore computed here and stored in its own column,
 * which is also what lets the lookup stay a single indexed equality.
 */
export function foldTitle(title) {
  return String(title).toLocaleLowerCase('hu-HU')
}

/**
 * A plain object with the same fields.
 *
 * `node:sqlite`, which the tests run against, returns rows with a null
 * prototype; `better-sqlite3`, which the host uses, returns ordinary objects.
 * Normalising here means the repository answers the same shape either way,
 * rather than the difference surfacing somewhere far from the cause.
 */
function plain(row) {
  return row ? { ...row } : undefined
}

/** The stored row, with `tags` turned back into a list. */
function hydrate(row) {
  if (!row) return undefined
  let tags = []
  try {
    const parsed = JSON.parse(row.tags)
    if (Array.isArray(parsed)) tags = parsed
  } catch {
    // A hand-edited row is not worth failing a listing over; an empty tag list
    // is the honest reading of a value we cannot parse.
  }
  return { ...row, tags }
}

/**
 * A user's search string as one FTS5 term.
 *
 * FTS5 gives `"`, `*`, `:`, `-`, `^`, `(` and `)` syntactic meaning, so a
 * perfectly ordinary query like `B2B-ügyfél` is a syntax error rather than a
 * search. Wrapping the whole thing in quotes makes it a single phrase, and
 * doubling any embedded quote keeps that wrapper intact. A query that is all
 * punctuation ends up an empty phrase, which matches nothing -- the right
 * answer, and not an exception.
 */
function ftsPhrase(query) {
  return `"${String(query).replace(/"/g, '""')}"`
}

/**
 * A LIKE pattern that matches a folder's contents and nothing beside it.
 *
 * The trailing slash is what stops `kozos` from also matching `kozosseg/`, and
 * the escape clause is what stops a folder with `%` or `_` in its name from
 * turning into a wildcard.
 */
function folderPattern(folder) {
  const escaped = String(folder).replace(/[\\%_]/g, (c) => `\\${c}`)
  return `${escaped}/%`
}

export function createRepo(storage) {
  const DOC_COLUMNS = 'id, path, title, owner, tags, created, updated, size, hash, version, deleted_at'
  const rows = (sql, params) => storage.all(sql, params).map(plain)

  /**
   * Writes the row and its FTS entry together.
   *
   * `storage.exec` runs exactly one statement -- it prepares the SQL, so a
   * semicolon-separated batch throws -- which is why this is three calls inside
   * one transaction rather than one call with three statements.
   */
  function upsertDoc(row) {
    return storage.transaction(() => {
      storage.exec(
        `INSERT INTO ext_docs_docs
           (id, path, title, title_lower, owner, tags, created, updated, size, hash, version, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path, title = excluded.title, title_lower = excluded.title_lower,
           owner = excluded.owner, tags = excluded.tags, created = excluded.created,
           updated = excluded.updated, size = excluded.size, hash = excluded.hash,
           version = excluded.version`,
        [
          row.id, row.path, row.title, foldTitle(row.title), row.owner ?? '', JSON.stringify(row.tags ?? []),
          row.created ?? '', row.updated ?? '', row.size ?? 0, row.hash ?? '', row.version ?? 1,
        ],
      )
      storage.exec('DELETE FROM ext_docs_fts WHERE doc_id = ?', [row.id])
      storage.exec(
        'INSERT INTO ext_docs_fts (doc_id, title, body) VALUES (?, ?, ?)',
        [row.id, row.title, row.body ?? ''],
      )
    })
  }

  function getById(id) {
    return hydrate(storage.get(`SELECT ${DOC_COLUMNS} FROM ext_docs_docs WHERE id = ?`, [id]))
  }

  function getByPath(path) {
    return hydrate(storage.get(`SELECT ${DOC_COLUMNS} FROM ext_docs_docs WHERE path = ?`, [path]))
  }

  /** Exact title first; only with `caseInsensitive` does a fold-match count. */
  function findByTitle(title, { caseInsensitive = false } = {}) {
    const exact = storage.get(
      `SELECT ${DOC_COLUMNS} FROM ext_docs_docs WHERE title = ? AND deleted_at IS NULL LIMIT 1`,
      [title],
    )
    if (exact) return hydrate(exact)
    if (!caseInsensitive) return undefined
    return hydrate(storage.get(
      `SELECT ${DOC_COLUMNS} FROM ext_docs_docs
       WHERE title_lower = ? AND deleted_at IS NULL LIMIT 1`,
      [foldTitle(title)],
    ))
  }

  function listDocs({ folder, owner, tag, includeDeleted = false, limit = 500 } = {}) {
    const where = []
    const params = []
    if (!includeDeleted) where.push('deleted_at IS NULL')
    if (folder) {
      where.push("path LIKE ? ESCAPE '\\'")
      params.push(folderPattern(folder))
    }
    if (owner) {
      where.push('owner = ?')
      params.push(owner)
    }
    const sql = `SELECT ${DOC_COLUMNS} FROM ext_docs_docs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated DESC, path ASC LIMIT ?`
    const found = storage.all(sql, [...params, limit]).map(hydrate)
    // Tag filtering happens here rather than in SQL: the column is a JSON list,
    // and a LIKE over it would match a tag that is only a substring of another.
    return tag ? found.filter((r) => r.tags.includes(tag)) : found
  }

  function search(query, { folder, owner, limit = 20 } = {}) {
    const where = ['ext_docs_fts MATCH ?', 'd.deleted_at IS NULL']
    const params = [ftsPhrase(query)]
    if (folder) {
      where.push("d.path LIKE ? ESCAPE '\\'")
      params.push(folderPattern(folder))
    }
    if (owner) {
      where.push('d.owner = ?')
      params.push(owner)
    }
    return rows(
      `SELECT d.id AS id, d.path AS path, d.title AS title,
              snippet(ext_docs_fts, 2, '', '', '…', 12) AS snippet
       FROM ext_docs_fts
       JOIN ext_docs_docs d ON d.id = ext_docs_fts.doc_id
       WHERE ${where.join(' AND ')}
       ORDER BY rank LIMIT ?`,
      [...params, limit],
    )
  }

  /**
   * Out of the listing and out of the search, but the row stays.
   *
   * The row has to survive so that a link pointing at this document can say
   * "deleted" rather than silently resolving to nothing, and so that restoring
   * knows where the file used to live.
   */
  function softDelete(id, at) {
    return storage.transaction(() => {
      storage.exec('UPDATE ext_docs_docs SET deleted_at = ? WHERE id = ?', [at, id])
      storage.exec('DELETE FROM ext_docs_fts WHERE doc_id = ?', [id])
    })
  }

  /**
   * Back into the listing, with the search entry rebuilt from the newest
   * version row.
   *
   * The `docs` table does not store the body, so the text has to come from
   * somewhere: it comes from the version history, which always has at least one
   * row for a trashed document because deleting writes one first.
   */
  function restore(id) {
    return storage.transaction(() => {
      const row = storage.get('SELECT title FROM ext_docs_docs WHERE id = ?', [id])
      if (!row) return
      const newest = storage.get(
        'SELECT content FROM ext_docs_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1',
        [id],
      )
      storage.exec('UPDATE ext_docs_docs SET deleted_at = NULL WHERE id = ?', [id])
      storage.exec('DELETE FROM ext_docs_fts WHERE doc_id = ?', [id])
      storage.exec(
        'INSERT INTO ext_docs_fts (doc_id, title, body) VALUES (?, ?, ?)',
        [id, row.title, newest?.content ?? ''],
      )
    })
  }

  function purge(id) {
    return storage.transaction(() => {
      storage.exec('DELETE FROM ext_docs_fts WHERE doc_id = ?', [id])
      storage.exec('DELETE FROM ext_docs_versions WHERE doc_id = ?', [id])
      storage.exec('DELETE FROM ext_docs_links WHERE from_id = ?', [id])
      storage.exec('DELETE FROM ext_docs_docs WHERE id = ?', [id])
    })
  }

  function addVersion(docId, { version, content, author, createdAt }) {
    storage.exec(
      `INSERT INTO ext_docs_versions (doc_id, version, content, author, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(doc_id, version) DO UPDATE SET
         content = excluded.content, author = excluded.author, created_at = excluded.created_at`,
      [docId, version, content, author ?? '', createdAt],
    )
  }

  /** Newest first, without the content: a version list is a list, not a load. */
  function listVersions(docId) {
    return rows(
      `SELECT version, author, created_at AS createdAt, length(content) AS meret
       FROM ext_docs_versions WHERE doc_id = ? ORDER BY version DESC`,
      [docId],
    )
  }

  function getVersion(docId, version) {
    return storage.get(
      'SELECT content, author, created_at AS createdAt FROM ext_docs_versions WHERE doc_id = ? AND version = ?',
      [docId, version],
    )
  }

  /** Drops everything but the newest `keep` versions. Returns how many went. */
  function pruneVersions(docId, keep) {
    const existing = rows(
      'SELECT version FROM ext_docs_versions WHERE doc_id = ? ORDER BY version DESC',
      [docId],
    )
    const doomed = existing.slice(keep)
    if (doomed.length === 0) return 0
    return storage.transaction(() => {
      for (const row of doomed) {
        storage.exec('DELETE FROM ext_docs_versions WHERE doc_id = ? AND version = ?', [docId, row.version])
      }
      return doomed.length
    })
  }

  /** Replaces this document's whole link set. */
  function setLinks(fromId, links) {
    return storage.transaction(() => {
      storage.exec('DELETE FROM ext_docs_links WHERE from_id = ?', [fromId])
      for (const link of links) {
        storage.exec(
          'INSERT INTO ext_docs_links (from_id, to_id, to_raw, resolved) VALUES (?, ?, ?, ?)',
          [fromId, link.toId ?? null, link.toRaw, link.toId ? 1 : 0],
        )
      }
    })
  }

  function backlinks(toId) {
    return rows(
      `SELECT l.from_id AS fromId, d.path AS path, d.title AS title, l.to_raw AS toRaw
       FROM ext_docs_links l
       JOIN ext_docs_docs d ON d.id = l.from_id
       WHERE l.to_id = ? AND d.deleted_at IS NULL
       ORDER BY d.title ASC`,
      [toId],
    )
  }

  /** Who is still waiting for a document by this title to appear. */
  function unresolvedTo(rawTitle) {
    return rows(
      'SELECT from_id AS fromId FROM ext_docs_links WHERE resolved = 0 AND to_raw = ?',
      [rawTitle],
    )
  }

  /**
   * Binds the rows that were waiting for this title. Returns how many bound.
   *
   * Without this a link would only attach when the *linking* document happened
   * to be reindexed, which for a document nobody touches again is never.
   */
  function resolveUnresolved(rawTitle, toId) {
    const waiting = unresolvedTo(rawTitle)
    if (waiting.length === 0) return 0
    storage.exec(
      'UPDATE ext_docs_links SET to_id = ?, resolved = 1 WHERE resolved = 0 AND to_raw = ?',
      [toId, rawTitle],
    )
    return waiting.length
  }

  /** What a full reindex starts from: every known path and the hash we saw. */
  function allPaths() {
    return rows('SELECT id, path, hash FROM ext_docs_docs ORDER BY path ASC')
  }

  return {
    upsertDoc,
    getById,
    getByPath,
    findByTitle,
    listDocs,
    search,
    softDelete,
    restore,
    purge,
    addVersion,
    listVersions,
    getVersion,
    pruneVersions,
    setLinks,
    backlinks,
    unresolvedTo,
    resolveUnresolved,
    allPaths,
  }
}
