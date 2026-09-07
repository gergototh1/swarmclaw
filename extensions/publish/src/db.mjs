import crypto from 'node:crypto'

/**
 * Schema and repository for the publish module.
 *
 * This is Task 1's slice: the module's own storage, and only the account and
 * release primitives the brief's tests exercise (`ujKiadas`, `ujAg`, `agak`,
 * `fiokotIr`, `fiokok`). Nothing here sends anything anywhere -- the four
 * platform adapters, the scheduler that walks `ext_publish_savok`, and the
 * write side of a branch's own lifecycle (`kiment`, a stored `url`, a retry)
 * are later tasks' work (spec 4, 5, 6, 7). What exists already is the shape
 * design spec 3 fixes: an account keyed on the outlet's own id, one row per
 * release, and one row per release-AND-platform -- because that last key is
 * the decision the whole schema is built to make (see the key register
 * below).
 *
 * Like the sibling modules, the repository does not interpret the text it
 * stores. `nev` (an account's display name) and `szoveg` (a branch's
 * platform-bound post text, added by a later task) are written by an agent or
 * copied from a platform's own API response; every one of them is bound as a
 * parameter, never spliced into SQL, and never read back to decide a branch.
 */

/*
 * EVERY KEY IN THIS SCHEMA, AND WHAT IT GATES
 * ============================================
 * The video module's own register (extensions/video/src/db.mjs) explains why
 * this list exists: a key GATES when a hit or a miss on it changes whether
 * something happens, and everything else is reporting or ordering. This
 * module's whole reason for existing as a separate table from `kiadasok` is
 * one such key, so it gets top billing below.
 *
 *   ext_publish_fiokok -- PRIMARY KEY (id)
 *     gates nothing by itself. Surrogate, minted by uid(); the row it names
 *     carries `platform`, `kulso_id` and `nev`, none of which is ever used as
 *     a key on its own.
 *
 *   ext_publish_fiokok -- UNIQUE INDEX (platform, kulso_id)
 *     gates whether connecting an outlet's account a second time creates a
 *     second row or updates the first. `fiokotIr` does not read the pair and
 *     then decide -- it hands the decision to this index with `INSERT ... ON
 *     CONFLICT(platform, kulso_id) DO UPDATE`, for the same reason `ujAg`
 *     leans on its own index below. A SELECT-then-INSERT leaves a race, and
 *     the caller that loses it gets no named refusal at all: it gets the
 *     driver's raw `UNIQUE constraint failed: ext_publish_fiokok...` text in
 *     front of the operator, which is at once an unnamed refusal and stored
 *     schema text spoken back. Design spec 9 rules out a second account per
 *     platform on purpose ("Nincs több fiók platformonként ebben a
 *     specben"), and this index is what makes that true at the database
 *     rather than only in the one place that calls `fiokotIr` today.
 *
 *   ext_publish_kiadasok -- PRIMARY KEY (id)
 *     gates nothing by itself. Surrogate, minted by uid(); this is the id
 *     every branch in `ext_publish_agak` is filed under (`kiadas_id`), so a
 *     release id that named two releases would put one release's branches on
 *     another release's calendar entry.
 *
 *   ext_publish_agak -- UNIQUE INDEX (kiadas_id, platform)
 *     gates THE decision this whole table exists for (design spec 3): one
 *     release, one row per platform. If TikTok fails and YouTube goes out,
 *     that is one row each, and retrying the failed branch touches only that
 *     row -- never a second "youtube" branch under the same release, and
 *     never four separate calendar entries for what the operator sees as one
 *     release. `ujAg` relies on this index rather than a SELECT-then-INSERT:
 *     a repository-level check would still leave a race between two callers,
 *     and this module's later tasks (the four adapters, the scheduler) will
 *     call `ujAg` from more than one place.
 *
 *   ext_publish_savok -- PRIMARY KEY (id)
 *     gates nothing yet. The table exists because design spec 3 names it as
 *     one of the four, and later tasks read it to place an approved release
 *     in the next free slot; nothing in this task writes or reads it.
 */

export const now = () => new Date().toISOString()
export const uid = () => crypto.randomBytes(8).toString('hex')

/** The four platforms this spec ships (design spec 1, 6). A closed list: nothing here guesses a fifth. */
export const PLATFORMOK = Object.freeze(['youtube', 'facebook', 'instagram', 'tiktok'])

/** `ujKiadas`'s starting state (design spec 4: `vazlat -> lektoralt -> jovahagyva -> utemezve -> kesz`, or `reszben`/`hiba`/`nincs_hova` per spec 5). Later tasks write the rest of this arrow. */
export const KIADAS_KEZDO_ALLAPOT = 'vazlat'

/** `ujAg`'s starting state: written, not yet sent (design spec 8: `kiment / vár / elbukott / nincs fiók`). Later tasks write the other three. */
export const AG_KEZDO_ALLAPOT = 'var'

export const MIGRATIONS = Object.freeze([{
  version: 1,
  sql: `
CREATE TABLE IF NOT EXISTS ext_publish_fiokok (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  kulso_id TEXT NOT NULL,
  nev TEXT NOT NULL,
  csatlakoztatva_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_publish_fiokok_platform_kulso_id ON ext_publish_fiokok (platform, kulso_id);
CREATE TABLE IF NOT EXISTS ext_publish_kiadasok (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  allapot TEXT NOT NULL,
  sav_id TEXT,
  felulirt_idopont TEXT,
  letrehozva_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_publish_kiadasok_video ON ext_publish_kiadasok (video_id);
CREATE INDEX IF NOT EXISTS ext_publish_kiadasok_allapot ON ext_publish_kiadasok (allapot);
CREATE TABLE IF NOT EXISTS ext_publish_agak (
  id TEXT PRIMARY KEY,
  kiadas_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  szoveg TEXT,
  allapot TEXT NOT NULL,
  hiba_kod TEXT,
  url TEXT,
  kikuldve_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_publish_agak_kiadas_platform ON ext_publish_agak (kiadas_id, platform);
CREATE TABLE IF NOT EXISTS ext_publish_savok (
  id TEXT PRIMARY KEY,
  nap INTEGER NOT NULL,
  idopont TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
}])

/**
 * True when a driver's thrown error is a UNIQUE violation on EXACTLY these
 * columns, on either `node:sqlite` or `better-sqlite3` (both raise the same
 * SQLite message text: `UNIQUE constraint failed: <table>.<col>, ...`).
 *
 * The columns are named rather than matched loosely, because the sentence a
 * caller maps this onto names one specific fact. `ujAg` inserts a freshly
 * minted `id` alongside the (kiadas_id, platform) pair, so a primary-key
 * collision on that `id` is also a "UNIQUE constraint failed" -- and reporting
 * it as "this release already has a branch for this platform" would state a
 * fact nobody observed, and send the operator looking for a branch that is not
 * there. An `id` collision is a different fact with no sentence of its own
 * yet, so it rethrows untouched rather than borrowing this one's.
 *
 * Exported for its own direct test (task-2-report.md's residual item): an
 * `id` collision on `ext_publish_agak` is reachable with no mocking at all
 * by reusing an id a legitimate `ujAg()` call already minted and inserting
 * it again through `storage.raw`, the same bypass `test/db.test.mjs`'s index
 * tests already use -- see `test/db.test.mjs`.
 */
export function isUniqueViolationOn(err, table, columns) {
  if (!(err instanceof Error)) return false
  return err.message.includes(`UNIQUE constraint failed: ${columns.map((c) => `${table}.${c}`).join(', ')}`)
}

export function createRepo(storage) {
  const S = storage

  const repo = {
    /** The storage handle, for a caller that must group several writes in one transaction. */
    storage: S,

    // --- fiokok ---

    /**
     * Connects or renames one platform account. Upserts on (platform,
     * kulso_id) -- see the key register above -- so calling this twice with
     * the same pair never creates a second row; it updates `nev` in place.
     * Returns the stored row either way.
     *
     * The upsert is one statement on purpose: the index decides, not a read
     * this method does first. Two processes connecting the same channel at
     * the same moment both end on the same row, and neither ever sees the
     * driver's own constraint text.
     */
    fiokotIr({ platform, kulsoId, nev }) {
      if (!PLATFORMOK.includes(platform)) throw new Error(`fiokotIr: platform csak ezek egyike lehet: ${PLATFORMOK.join(', ')}`)
      if (typeof kulsoId !== 'string' || kulsoId === '') throw new Error('fiokotIr: kulsoId nem lehet üres')
      if (typeof nev !== 'string' || nev === '') throw new Error('fiokotIr: nev nem lehet üres')
      const t = now()
      S.exec(`INSERT INTO ext_publish_fiokok (id, platform, kulso_id, nev, csatlakoztatva_at, updated_at) VALUES (?,?,?,?,?,?)
ON CONFLICT(platform, kulso_id) DO UPDATE SET nev = excluded.nev, updated_at = excluded.updated_at`,
        [uid(), platform, kulsoId, nev, t, t])
      return S.get('SELECT * FROM ext_publish_fiokok WHERE platform = ? AND kulso_id = ?', [platform, kulsoId]) || null
    },
    fiok(id) { return S.get('SELECT * FROM ext_publish_fiokok WHERE id = ?', [id]) || null },
    fiokok() { return S.all('SELECT * FROM ext_publish_fiokok ORDER BY platform ASC, nev ASC') },

    // --- kiadasok ---

    /** Opens one release for one video, starting in `vazlat` (design spec 4). Nothing here checks `videoId` against the `video.videos` contract -- that read belongs to whichever later task's tool calls this, over `videosHandle` (src/video-szerzodes.mjs). */
    ujKiadas({ videoId }) {
      if (typeof videoId !== 'string' || videoId === '') throw new Error('ujKiadas: videoId nem lehet üres')
      const id = uid()
      const t = now()
      S.exec('INSERT INTO ext_publish_kiadasok (id, video_id, allapot, sav_id, felulirt_idopont, letrehozva_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        [id, videoId, KIADAS_KEZDO_ALLAPOT, null, null, t, t])
      return repo.kiadas(id)
    },
    kiadas(id) { return S.get('SELECT * FROM ext_publish_kiadasok WHERE id = ?', [id]) || null },
    kiadasok() { return S.all('SELECT * FROM ext_publish_kiadasok ORDER BY letrehozva_at DESC, rowid DESC') },

    // --- agak ---

    /**
     * Opens one platform branch under one release, starting in `var`
     * (design spec 8). Refused by name, and by the UNIQUE index
     * (kiadas_id, platform) underneath it, when that release already has a
     * branch for this platform -- the message names the argument (`platform`)
     * and never the caller's value, per the module-wide refusal discipline.
     */
    ujAg({ kiadasId, platform }) {
      if (typeof kiadasId !== 'string' || kiadasId === '') throw new Error('ujAg: kiadasId nem lehet üres')
      if (!PLATFORMOK.includes(platform)) throw new Error(`ujAg: platform csak ezek egyike lehet: ${PLATFORMOK.join(', ')}`)
      const id = uid()
      const t = now()
      try {
        S.exec('INSERT INTO ext_publish_agak (id, kiadas_id, platform, szoveg, allapot, hiba_kod, url, kikuldve_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [id, kiadasId, platform, null, AG_KEZDO_ALLAPOT, null, null, null, t, t])
      } catch (err) {
        if (isUniqueViolationOn(err, 'ext_publish_agak', ['kiadas_id', 'platform'])) {
          throw new Error('ujAg: ezen a kiadáson már van ág ehhez a platformhoz -- egy kiadáson egy platform egyszer szerepel')
        }
        throw err
      }
      return repo.ag(id)
    },
    ag(id) { return S.get('SELECT * FROM ext_publish_agak WHERE id = ?', [id]) || null },
    /** A release's branches, in the order they were opened -- the order `ujAg` was called, which spec 3's "one row, four flags" reading depends on. */
    agak(kiadasId) { return S.all('SELECT * FROM ext_publish_agak WHERE kiadas_id = ? ORDER BY created_at ASC, rowid ASC', [kiadasId]) },
  }
  return repo
}
