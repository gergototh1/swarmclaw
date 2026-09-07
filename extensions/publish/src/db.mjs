import crypto from 'node:crypto'

/**
 * Schema and repository for the publish module.
 *
 * This is Task 1 and 3's slice: the module's own storage, the account and
 * release primitives Task 1's tests exercise (`ujKiadas`, `ujAg`, `agak`,
 * `fiokotIr`, `fiokok`), and Task 3's slot primitives (`ujSav`, `sav`,
 * `savok`) -- the operator data `kovetkezoSzabadSav` (src/utemezes.mjs)
 * reads to place an approved release in its next free slot. Nothing here
 * sends anything anywhere -- the four platform adapters and the write side
 * of a branch's own lifecycle (`kiment`, a stored `url`, a retry) are later
 * tasks' work (spec 4, 6). What exists already is the shape design spec 3
 * fixes: an account keyed on the outlet's own id, one row per release, one
 * row per release-AND-platform, and one row per weekly slot -- because the
 * release-AND-platform key is the decision the whole schema is built to make
 * (see the key register below).
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
 *     gates nothing by itself, same as `ext_publish_fiokok`'s primary key.
 *     Surrogate, minted by uid(); no UNIQUE index sits on (nap, ora, perc)
 *     because two slots at the same weekly minute is an operator's
 *     redundant, not invalid, choice -- `kovetkezoSzabadSav` just treats them
 *     as two independent candidates that happen to compute the same instant,
 *     and picks whichever it walks first.
 *
 *     `nap`/`ora`/`perc` (not the `idopont` this table started with in Task
 *     1) because a slot is a WEEKLY RECURRENCE, not a point in time: "every
 *     Monday at 09:00" has no single instant to store. `idopont` never
 *     shipped a caller -- Task 1's own comment on this table said "nothing
 *     in this task writes or reads it" -- so Task 3 corrects the column set
 *     on the same migration version rather than layering an ALTER TABLE on a
 *     shape nothing ever depended on; design spec 10 lists this as fresh
 *     work, not archaeology on a released schema (spec doc section on the
 *     data model). `nap` follows `Date.prototype.getUTCDay()`'s own
 *     numbering (0 = Sunday ... 6 = Saturday) rather than inventing a
 *     Monday-first scheme, so `src/utemezes.mjs` never has to translate
 *     between the two.
 */

export const now = () => new Date().toISOString()
export const uid = () => crypto.randomBytes(8).toString('hex')

/** The four platforms this spec ships (design spec 1, 6). A closed list: nothing here guesses a fifth. */
export const PLATFORMOK = Object.freeze(['youtube', 'facebook', 'instagram', 'tiktok'])

/**
 * Every word `ext_publish_kiadasok.allapot` may hold -- all EIGHT of them, in
 * the order design spec 4 walks them, followed by spec 5's three outcomes.
 *
 * It lives here, beside the column it describes, and not beside
 * `kiadasAllapot` (src/allapot.mjs), because that function produces only five
 * of these words: `vazlat`, `lektoralt` and `jovahagyva` are WORKFLOW states
 * an operator and a reviewer move a release through, written on this column by
 * later tasks' approval step, and they are not derivable from a branch's own
 * state at all (a draft and an approved-but-unsent release show the identical
 * branch shape -- every branch `var`). A caller that needs to know which of
 * those a release is in reads this column; a caller that needs to know how the
 * dispatch turned out calls `kiadasAllapot`. Task 6's `vazlat`/`jovahagyva`
 * fixtures name them from here.
 */
export const KIADAS_ALLAPOTOK = Object.freeze({
  VAZLAT: 'vazlat',
  LEKTORALT: 'lektoralt',
  JOVAHAGYVA: 'jovahagyva',
  UTEMEZVE: 'utemezve',
  KESZ: 'kesz',
  RESZBEN: 'reszben',
  HIBA: 'hiba',
  NINCS_HOVA: 'nincs_hova',
})

/** `ujKiadas`'s starting state (design spec 4: `vazlat -> lektoralt -> jovahagyva -> utemezve -> kesz`, or `reszben`/`hiba`/`nincs_hova` per spec 5). Later tasks write the rest of this arrow. */
export const KIADAS_KEZDO_ALLAPOT = KIADAS_ALLAPOTOK.VAZLAT

/**
 * Every word `ext_publish_agak.allapot` may hold -- design spec 8's four
 * per-platform flags (`kiment / vár / elbukott / nincs fiók`).
 *
 * Beside the column, for the same reason as above and for one more: spec 8
 * says the calendar draws one entry per release with FOUR platform flags, so
 * the page (task 6) names these words too, as does `kiadasAllapot`, which
 * reads them. Three readers, one place they are spelled.
 */
export const AG_ALLAPOTOK = Object.freeze({
  VAR: 'var',
  KESZ: 'kesz',
  HIBA: 'hiba',
  NINCS_FIOK: 'nincs_fiok',
})

/** `ujAg`'s starting state: written, not yet sent. Later tasks write the other three. */
export const AG_KEZDO_ALLAPOT = AG_ALLAPOTOK.VAR

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
  ora INTEGER NOT NULL,
  perc INTEGER NOT NULL,
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

    // --- savok ---

    /**
     * Opens one weekly publishing slot: every `nap` (0-6, `getUTCDay()`'s own
     * numbering) at `ora:perc` UTC. Refused by name, and the caller's value
     * is never echoed -- same discipline as `ujAg`/`fiokotIr` above -- because
     * an out-of-range number is exactly the kind of value a refusal must not
     * hand back verbatim next to the module's own range text.
     *
     * No uniqueness check: see the key register at the top of this file for
     * why two slots at the same weekly minute is a redundant operator choice,
     * not an invalid one.
     */
    ujSav({ nap, ora, perc }) {
      if (!Number.isInteger(nap) || nap < 0 || nap > 6) throw new Error('ujSav: nap 0 és 6 közötti egész szám lehet (0 = vasárnap, getUTCDay() szerint)')
      if (!Number.isInteger(ora) || ora < 0 || ora > 23) throw new Error('ujSav: ora 0 és 23 közötti egész szám lehet')
      if (!Number.isInteger(perc) || perc < 0 || perc > 59) throw new Error('ujSav: perc 0 és 59 közötti egész szám lehet')
      const id = uid()
      const t = now()
      S.exec('INSERT INTO ext_publish_savok (id, nap, ora, perc, created_at) VALUES (?,?,?,?,?)', [id, nap, ora, perc, t])
      return repo.sav(id)
    },
    sav(id) { return S.get('SELECT * FROM ext_publish_savok WHERE id = ?', [id]) || null },
    /** Every declared slot, ordered by when it falls in the week -- the shape `kovetkezoSzabadSav` (src/utemezes.mjs) takes as its `savok` argument. */
    savok() { return S.all('SELECT * FROM ext_publish_savok ORDER BY nap ASC, ora ASC, perc ASC') },
  }
  return repo
}
