import crypto from 'node:crypto'

/**
 * Schema and repository for the narration (TTS) extension.
 *
 * Two shapes only: a *kerelem* is one synthesis request (finished, failed, or
 * finished-then-lost), and a *napi* row is one day's spent seconds. Everything
 * the page, the contract and the MCP server will do is a read or a write
 * against these, so the repository is pure logic over the storage handle and
 * can be tested without the host.
 */

/*
 * EVERY KEY IN THIS SCHEMA, AND WHAT IT BLOCKS
 * ============================================
 *
 * `ext_tts_kerelmek_cache` UNIQUE (szolgaltato, modell, hang, nyelv,
 * szoveg_hash) WHERE status = 'kesz'
 *   blocks a second paid call for a sentence that already exists in this
 *   voice. Partial on purpose: a row that failed (`hiba`) or whose file has
 *   since gone (`elveszett`) must not hold the key, or one network error would
 *   make that sentence unsynthesisable for ever. The synthesis layer looks the
 *   key up (`cacheHit`) before it calls out; the index is the barrier behind
 *   that lookup for two calls that overlap across the network await, where
 *   the second `insertKerelem` of a finished row throws instead of storing a
 *   duplicate.
 *
 * `ext_tts_kerelmek` PRIMARY KEY (id)
 *   blocks nothing: `id` is a random 16-hex string minted per insert and never
 *   looked up as a decision. It is the handle `markLost` needs.
 *
 * `ext_tts_napi` PRIMARY KEY (nap)
 *   the day's counter. It blocks nothing by itself; the synthesis layer reads
 *   it (`maiMasodperc`) and refuses before the call when the cap is spent, and
 *   adds the measured seconds after (`addMasodperc`). The upsert on this key
 *   is what makes two overlapping additions sum rather than overwrite.
 *
 * `ext_tts_kerelmek_created` (created_at)
 *   ordering for the page's list only. Not a decision.
 */
export const MIGRATIONS = Object.freeze([{
  version: 1,
  sql: `
CREATE TABLE IF NOT EXISTS ext_tts_kerelmek (
  id TEXT PRIMARY KEY, szolgaltato TEXT NOT NULL, modell TEXT NOT NULL, hang TEXT NOT NULL, nyelv TEXT NOT NULL,
  szoveg_hash TEXT NOT NULL, szoveg TEXT NOT NULL, fajl TEXT NOT NULL, hossz_ms INTEGER NOT NULL DEFAULT 0,
  bajt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, hiba_kod TEXT NOT NULL DEFAULT '', kerte TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_tts_kerelmek_cache ON ext_tts_kerelmek (szolgaltato, modell, hang, nyelv, szoveg_hash) WHERE status = 'kesz';
CREATE INDEX IF NOT EXISTS ext_tts_kerelmek_created ON ext_tts_kerelmek (created_at);
CREATE TABLE IF NOT EXISTS ext_tts_napi (nap TEXT PRIMARY KEY, masodperc REAL NOT NULL DEFAULT 0);
`,
}])

/**
 * The hex SHA-256 of the text to synthesise. It is the only form of the text
 * that takes part in a key; the text itself is stored as a column and read
 * back for display, never used as a name or a decision.
 */
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const now = () => new Date().toISOString()
const uid = () => crypto.randomBytes(8).toString('hex')
/**
 * The calendar day of an ISO-8601 timestamp: its first ten characters. The
 * counter is keyed on this. `new Date().toISOString()` is always in UTC, so a
 * day here is a UTC day; a timestamp with an offset would be cut at its local
 * date instead, which no caller in this extension produces.
 */
export const napOf = (iso) => iso.slice(0, 10)

export function createRepo(storage) {
  const S = storage
  return {
    /** The finished row for this exact voice and text, or null. Failed and lost rows never match. */
    cacheHit({ szolgaltato, modell, hang, nyelv, szovegHash }) {
      return S.get(
        "SELECT * FROM ext_tts_kerelmek WHERE szolgaltato = ? AND modell = ? AND hang = ? AND nyelv = ? AND szoveg_hash = ? AND status = 'kesz'",
        [szolgaltato, modell, hang, nyelv, szovegHash],
      ) || null
    },
    /** Throws on the partial unique index when a finished row for this key already exists. */
    insertKerelem({ szolgaltato, modell, hang, nyelv, szoveg, fajl, hosszMs, bajt, status, hibaKod, kerte }) {
      const id = uid()
      S.exec(
        'INSERT INTO ext_tts_kerelmek (id, szolgaltato, modell, hang, nyelv, szoveg_hash, szoveg, fajl, hossz_ms, bajt, status, hiba_kod, kerte, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, szolgaltato, modell, hang, nyelv, sha256(szoveg), szoveg, fajl, hosszMs, bajt, status, hibaKod, kerte, now()],
      )
      return { id }
    },
    /** A finished row whose file is gone releases the cache key; the next call synthesises again. */
    markLost(id) {
      S.exec("UPDATE ext_tts_kerelmek SET status = 'elveszett' WHERE id = ? AND status = 'kesz'", [id])
    },
    maiMasodperc(nap) {
      const row = S.get('SELECT masodperc FROM ext_tts_napi WHERE nap = ?', [nap])
      return row ? row.masodperc : 0
    },
    addMasodperc(nap, masodperc) {
      S.exec('INSERT INTO ext_tts_napi (nap, masodperc) VALUES (?, ?) ON CONFLICT(nap) DO UPDATE SET masodperc = masodperc + excluded.masodperc', [nap, masodperc])
    },
    /** Newest first. `szoveg` comes back verbatim: it is the operator's own input, shown on the page, and nothing else reads it. */
    kerelmek(limit) {
      return S.all('SELECT id, modell, hang, nyelv, szoveg, fajl, hossz_ms, bajt, status, hiba_kod, kerte, created_at FROM ext_tts_kerelmek ORDER BY created_at DESC LIMIT ?', [limit])
    },
    counts() {
      return {
        kerelmek: S.get('SELECT COUNT(*) AS c FROM ext_tts_kerelmek').c,
        kesz: S.get("SELECT COUNT(*) AS c FROM ext_tts_kerelmek WHERE status = 'kesz'").c,
        hiba: S.get("SELECT COUNT(*) AS c FROM ext_tts_kerelmek WHERE status = 'hiba'").c,
      }
    },
  }
}
