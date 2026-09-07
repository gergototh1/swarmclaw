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
 *     redundant, not invalid, choice. Redundant and INERT, though, not
 *     redundant and doubling: `kovetkezoSzabadSav` (src/utemezes.mjs) keys a
 *     reservation on the INSTANT ALONE, so both rows compute the same minute,
 *     the first release takes it, and the second slot rolls to the following
 *     week rather than handing that same minute out a second time. One
 *     release goes out in a given minute however many slot rows name it. The
 *     tie between them goes to whichever `savok()` returns first, which is
 *     the `nap, ora, perc` order below -- and since both rows sort to the
 *     same place, to whichever the driver walks first. That is a reporting
 *     detail: the two rows are interchangeable by construction.
 *
 *     Keying on (sav_id, instant) instead would make the duplicate row
 *     DOUBLE that minute's capacity, silently: two releases dispatched to
 *     four platforms at the same second, from an operator having done
 *     nothing but type the same time twice.
 *
 *     `nap`/`ora`/`perc` (not the `idopont` this table started with in Task
 *     1) because a slot is a WEEKLY RECURRENCE, not a point in time: "every
 *     Monday at 09:00" has no single instant to store. `idopont` never
 *     shipped a caller -- Task 1's own comment on this table said "nothing
 *     in this task writes or reads it" -- so Task 3 corrects the column set
 *     on the same migration version rather than layering an ALTER TABLE on a
 *     shape nothing ever depended on; design spec 10 lists this as fresh
 *     work, not archaeology on a released schema (spec doc section on the
 *     data model). `nap` numbers the days 0 = Sunday ... 6 = Saturday rather
 *     than inventing a Monday-first scheme, so `src/utemezes.mjs` -- which
 *     reaches the same numbering through `getUTCDay()` on the zone's wall
 *     clock -- never has to translate between the two. The triple is read in
 *     the module's configured zone (`ALAP_IDOZONA` above), NOT in UTC: see
 *     `src/utemezes.mjs`'s file docblock for why a weekly slot that means UTC
 *     is a slot that silently moves an hour twice a year.
 */

export const now = () => new Date().toISOString()
export const uid = () => crypto.randomBytes(8).toString('hex')

/** The four platforms this spec ships (design spec 1, 6). A closed list: nothing here guesses a fifth. */
export const PLATFORMOK = Object.freeze(['youtube', 'facebook', 'instagram', 'tiktok'])

/**
 * The zone `ext_publish_savok`'s `nap`/`ora`/`perc` is read in when the
 * operator has not configured one.
 *
 * It lives here, beside the three columns it gives meaning to, for the same
 * reason `KIADAS_ALLAPOTOK` and `AG_ALLAPOTOK` do: the column and the words
 * that make sense of it are one fact, and three readers -- `ujSav`'s own
 * refusals below, `src/utemezes.mjs`'s conversion, and `index.mjs`'s
 * `idozona` settings field and `SCHEDULES` declaration -- must not each carry
 * their own copy of the zone name. A slot is a WALL CLOCK, not a UTC triple;
 * `src/utemezes.mjs`'s file docblock has the whole argument.
 */
export const ALAP_IDOZONA = 'Europe/Budapest'

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
  idopont TEXT,
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
      S.exec('INSERT INTO ext_publish_kiadasok (id, video_id, allapot, sav_id, idopont, felulirt_idopont, letrehozva_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, videoId, KIADAS_KEZDO_ALLAPOT, null, null, null, t, t])
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
     * Opens one weekly publishing slot: every `nap` (0-6, Sunday-first) at
     * `ora:perc` ON THE WALL CLOCK OF THE MODULE'S CONFIGURED ZONE
     * (`ALAP_IDOZONA` above, the `idozona` setting's default) -- not UTC.
     * The refusals say so, in the operator's own words rather than in the
     * name of the accessor `src/utemezes.mjs` happens to use. Refused by
     * name, and the caller's value is never echoed -- same discipline as `ujAg`/`fiokotIr` above -- because
     * an out-of-range number is exactly the kind of value a refusal must not
     * hand back verbatim next to the module's own range text.
     *
     * No uniqueness check: see the key register at the top of this file for
     * why two slots at the same weekly minute is a redundant operator choice,
     * not an invalid one.
     */
    ujSav({ nap, ora, perc }) {
      if (!Number.isInteger(nap) || nap < 0 || nap > 6) throw new Error(`ujSav: nap 0 és 6 közötti egész szám lehet, ahol 0 = vasárnap, a beállított időzóna fali óráján (alapból ${ALAP_IDOZONA})`)
      if (!Number.isInteger(ora) || ora < 0 || ora > 23) throw new Error(`ujSav: ora 0 és 23 közötti egész szám lehet, a beállított időzóna fali óráján (alapból ${ALAP_IDOZONA})`)
      if (!Number.isInteger(perc) || perc < 0 || perc > 59) throw new Error('ujSav: perc 0 és 59 közötti egész szám lehet')
      const id = uid()
      const t = now()
      S.exec('INSERT INTO ext_publish_savok (id, nap, ora, perc, created_at) VALUES (?,?,?,?,?)', [id, nap, ora, perc, t])
      return repo.sav(id)
    },
    sav(id) { return S.get('SELECT * FROM ext_publish_savok WHERE id = ?', [id]) || null },
    /** Every declared slot, ordered by when it falls in the week -- the shape `kovetkezoSzabadSav` (src/utemezes.mjs) takes as its `savok` argument. */
    savok() { return S.all('SELECT * FROM ext_publish_savok ORDER BY nap ASC, ora ASC, perc ASC') },

    // --- the write path (Task 4): draft text, review, scheduling, dispatch results ---
    //
    // Task 1's own comment on this file called this "later tasks' work (spec
    // 4, 6)" -- spec 4 is the workflow this block writes, spec 6 is the four
    // adapters (a later task's own file). Task 3's report flagged the same
    // gap twice, from the read side: no repo writer for `idopont`, and no
    // reader that derives `foglaltak` from stored rows -- "that's the
    // scheduler tool's job on Task 4's file list". These methods are that
    // job. None of them import `src/utemezes.mjs` or `src/allapot.mjs`:
    // `kovetkezoSzabadSav` and `kiadasAllapot` are PURE functions a caller
    // above this file runs, and this file only ever receives their answer
    // and writes it -- importing either back in here would make `db.mjs`
    // depend on the two modules that already depend on it (both import
    // `ALAP_IDOZONA`/`KIADAS_ALLAPOTOK`/`AG_ALLAPOTOK` from here), a cycle
    // for no reason: every one of the methods below is a plain read or a
    // plain write, with the scheduling and outcome ARITHMETIC left to
    // `src/szoveg.mjs`.

    /** The most recently opened release for one video, or null. A lookup, not a uniqueness rule: design spec 9 does not forbid a second release on the same video, so this is "the one to reuse", not "the only one that may exist". */
    kiadasVideohoz(videoId) {
      if (typeof videoId !== 'string' || videoId === '') throw new Error('kiadasVideohoz: videoId nem lehet üres')
      return S.get('SELECT * FROM ext_publish_kiadasok WHERE video_id = ? ORDER BY letrehozva_at DESC, rowid DESC LIMIT 1', [videoId]) || null
    },

    /**
     * Writes (or overwrites) one branch's platform text, opening the branch
     * first if this release has none yet for that platform -- upserts on
     * (kiadas_id, platform), same discipline as `fiokotIr` above. Every call
     * also sends the release back to `vazlat` (design spec 4): a new draft
     * invalidates whatever a reviewer already judged or an operator already
     * approved, the same way `videoDraft` (extensions/video/src/terv.mjs)
     * resets its own video's status on every new plan version. The branch's
     * own `allapot`, `hiba_kod`, `url` and `kikuldve_at` are left untouched
     * on an update -- design spec 9 forbids rewriting after a branch has
     * gone out, and the caller (`publishDraft`, src/szoveg.mjs) is the one
     * that refuses a re-draft on a release already past `vazlat`/`lektoralt`,
     * so a branch already `kesz` is never reached by this method in practice.
     */
    szovegetIr({ kiadasId, platform, szoveg }) {
      if (typeof kiadasId !== 'string' || kiadasId === '') throw new Error('szovegetIr: kiadasId nem lehet üres')
      if (!PLATFORMOK.includes(platform)) throw new Error(`szovegetIr: platform csak ezek egyike lehet: ${PLATFORMOK.join(', ')}`)
      if (typeof szoveg !== 'string' || szoveg === '') throw new Error('szovegetIr: szoveg nem lehet üres (JSON-ként tárolt szöveg kell)')
      const t = now()
      S.transaction(() => {
        S.exec(`INSERT INTO ext_publish_agak (id, kiadas_id, platform, szoveg, allapot, hiba_kod, url, kikuldve_at, created_at, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(kiadas_id, platform) DO UPDATE SET szoveg = excluded.szoveg, updated_at = excluded.updated_at`,
          [uid(), kiadasId, platform, szoveg, AG_KEZDO_ALLAPOT, null, null, null, t, t])
        S.exec('UPDATE ext_publish_kiadasok SET allapot = ?, updated_at = ? WHERE id = ?', [KIADAS_ALLAPOTOK.VAZLAT, t, kiadasId])
      })
      return S.get('SELECT * FROM ext_publish_agak WHERE kiadas_id = ? AND platform = ?', [kiadasId, platform]) || null
    },

    /**
     * Sets a release's stored workflow/outcome column directly. A mechanical
     * setter -- it does not check the CURRENT value before writing, the same
     * way `fiokotIr`'s upsert does not read first -- because every state
     * transition rule (which allapot may follow which) is a business rule a
     * caller enforces before it gets here (`publishVerdict`/`publishDue`,
     * src/szoveg.mjs), not a fact this repository layer is in a position to
     * judge. `allapot` is checked against the closed vocabulary so a typo
     * cannot wedge an unrecognised word into the column `kiadasAllapot`
     * (src/allapot.mjs) and the calendar both read.
     */
    kiadasAllapototIr(kiadasId, allapot) {
      if (typeof kiadasId !== 'string' || kiadasId === '') throw new Error('kiadasAllapototIr: kiadasId nem lehet üres')
      if (!Object.values(KIADAS_ALLAPOTOK).includes(allapot)) throw new Error(`kiadasAllapototIr: allapot csak ezek egyike lehet: ${Object.values(KIADAS_ALLAPOTOK).join(', ')}`)
      S.exec('UPDATE ext_publish_kiadasok SET allapot = ?, updated_at = ? WHERE id = ?', [allapot, now(), kiadasId])
      return repo.kiadas(kiadasId)
    },

    /** Moves a release from `lektoralt` to `jovahagyva` (design spec 4, the operator's own action -- no agent tool calls this in this task; it is here for the approval surface a later task wires up). Refused by name when the release is not currently `lektoralt`, so an approval cannot land on a release nobody has reviewed, or twice on one already approved. */
    kiadastJovahagy(kiadasId) {
      const k = repo.kiadas(kiadasId)
      if (!k) throw new Error('kiadastJovahagy: nincs kiadás a megadott kiadasId-vel')
      if (k.allapot !== KIADAS_ALLAPOTOK.LEKTORALT) throw new Error(`kiadastJovahagy: csak ${KIADAS_ALLAPOTOK.LEKTORALT} állapotú kiadás hagyható jóvá (jelenlegi: ${k.allapot})`)
      return repo.kiadasAllapototIr(kiadasId, KIADAS_ALLAPOTOK.JOVAHAGYVA)
    },

    /**
     * Every reserved slot-instant, read from the STORED `idopont` column
     * alone -- never from `sav_id` or `felulirt_idopont`. This is the second
     * invariant task-4-brief.md names: D6's guarantee (two slots on the same
     * weekly minute do not double that minute's capacity) holds only when
     * "already taken" is read from the column `esedekes` (src/utemezes.mjs)
     * ultimately dispatches on. Deriving `foglaltak` from `sav_id` would
     * treat "assigned to slot X" as the reservation, when two releases can
     * share a `sav_id` across different weeks; deriving it from
     * `felulirt_idopont` would miss every release scheduled straight from a
     * slot with no override at all. Reading `idopont` is the one derivation
     * where "reserved" and "occupies a real, singular instant" are the same
     * fact.
     *
     * The shape this returns (`{ savId, idopont }`) is exactly
     * `kovetkezoSzabadSav`'s (src/utemezes.mjs) own `foglaltak` argument, so
     * a caller passes this straight through with no reshaping in between.
     */
    foglaltSavIdopontok() {
      return S.all("SELECT sav_id, idopont FROM ext_publish_kiadasok WHERE sav_id IS NOT NULL AND idopont IS NOT NULL")
        .map((r) => ({ savId: r.sav_id, idopont: r.idopont }))
    },

    /**
     * Assigns a release to a slot's occurrence, atomically: `sav_id` and
     * `idopont` are written together with `allapot -> utemezve`, in one
     * UPDATE, so no reader can ever observe one written without the other.
     * Only from `jovahagyva` -- refused by name otherwise, the same
     * discipline as `kiadastJovahagy` above -- because a release that has
     * not been approved has no business claiming a slot, and a release that
     * is already `utemezve` is reassigned through `idopontFeluliras` below,
     * never through this method a second time (it would silently double-book
     * whichever slot the caller happened to pass).
     *
     * This method does not compute the occurrence itself -- see the
     * docblock at the top of this block for why `kovetkezoSzabadSav` stays
     * out of this file. The caller (`src/szoveg.mjs`) is the one that reads
     * `foglaltSavIdopontok()` above, calls `kovetkezoSzabadSav`, and hands
     * the ONE resulting `{ savId, idopont }` pair here.
     */
    kiadastUtemez({ kiadasId, savId, idopont }) {
      const k = repo.kiadas(kiadasId)
      if (!k) throw new Error('kiadastUtemez: nincs kiadás a megadott kiadasId-vel')
      if (k.allapot !== KIADAS_ALLAPOTOK.JOVAHAGYVA) throw new Error(`kiadastUtemez: csak ${KIADAS_ALLAPOTOK.JOVAHAGYVA} állapotú kiadás ütemezhető (jelenlegi: ${k.allapot})`)
      if (typeof savId !== 'string' || savId === '') throw new Error('kiadastUtemez: savId nem lehet üres')
      if (typeof idopont !== 'string' || Number.isNaN(Date.parse(idopont))) throw new Error('kiadastUtemez: idopont csak érvényes ISO időpont lehet')
      S.exec('UPDATE ext_publish_kiadasok SET sav_id = ?, idopont = ?, allapot = ?, updated_at = ? WHERE id = ?',
        [savId, idopont, KIADAS_ALLAPOTOK.UTEMEZVE, now(), kiadasId])
      return repo.kiadas(kiadasId)
    },

    /**
     * The operator's manual override, on an already-scheduled release. This
     * is the first invariant task-4-brief.md names: the write collapses the
     * override straight onto `idopont` IN THE SAME UPDATE that sets
     * `felulirt_idopont`, so the two columns can never disagree -- there is
     * no window where `felulirt_idopont` holds the operator's new time and
     * `idopont` still holds the stale slot instant `esedekes`
     * (src/utemezes.mjs) and `foglaltSavIdopontok` above both read. From this
     * write onward the two columns carry the identical value; the release's
     * effective dispatch time is `idopont` either way, and `felulirt_idopont`
     * remains only so the calendar can tell an overridden release apart from
     * a slotted one (design spec 3).
     *
     * Only from `utemezve` -- a release with no slot yet has nothing to
     * override; `kiadastUtemez` above is where a fresh release gets its
     * first instant. `sav_id` is left untouched: the override changes WHEN,
     * not which slot the release nominally belongs to.
     */
    idopontFeluliras({ kiadasId, felulirtIdopont }) {
      const k = repo.kiadas(kiadasId)
      if (!k) throw new Error('idopontFeluliras: nincs kiadás a megadott kiadasId-vel')
      if (k.allapot !== KIADAS_ALLAPOTOK.UTEMEZVE) throw new Error(`idopontFeluliras: csak ${KIADAS_ALLAPOTOK.UTEMEZVE} állapotú kiadás időpontja írható felül (jelenlegi: ${k.allapot})`)
      if (typeof felulirtIdopont !== 'string' || Number.isNaN(Date.parse(felulirtIdopont))) throw new Error('idopontFeluliras: felulirtIdopont csak érvényes ISO időpont lehet')
      S.exec('UPDATE ext_publish_kiadasok SET felulirt_idopont = ?, idopont = ?, updated_at = ? WHERE id = ?',
        [felulirtIdopont, felulirtIdopont, now(), kiadasId])
      return repo.kiadas(kiadasId)
    },

    /**
     * Writes one branch's dispatch result: `kesz` with a `url`, `hiba` with
     * a `hibaKod`, or `nincs_fiok` with neither -- design spec 8's three
     * branch facts (a fourth, `var`, is the branch's own starting state and
     * never written back here). `kikuldve_at` is stamped only on `kesz`: a
     * branch that failed or had no account never went out, and the column
     * says so by staying null. The release's own aggregate `allapot` is NOT
     * written here -- that is `kiadasAllapot`'s (src/allapot.mjs) answer,
     * computed by the caller once every branch of a release has an answer,
     * and written through `kiadasAllapototIr` above.
     */
    agEredmenyetIr({ agId, allapot, hibaKod = null, url = null }) {
      if (typeof agId !== 'string' || agId === '') throw new Error('agEredmenyetIr: agId nem lehet üres')
      if (![AG_ALLAPOTOK.KESZ, AG_ALLAPOTOK.HIBA, AG_ALLAPOTOK.NINCS_FIOK].includes(allapot)) {
        throw new Error(`agEredmenyetIr: allapot csak ezek egyike lehet: ${AG_ALLAPOTOK.KESZ}, ${AG_ALLAPOTOK.HIBA}, ${AG_ALLAPOTOK.NINCS_FIOK}`)
      }
      const kikuldveAt = allapot === AG_ALLAPOTOK.KESZ ? now() : null
      S.exec('UPDATE ext_publish_agak SET allapot = ?, hiba_kod = ?, url = ?, kikuldve_at = ?, updated_at = ? WHERE id = ?',
        [allapot, hibaKod, url, kikuldveAt, now(), agId])
      return S.get('SELECT * FROM ext_publish_agak WHERE id = ?', [agId]) || null
    },
  }
  return repo
}
