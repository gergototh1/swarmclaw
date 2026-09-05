import crypto from 'node:crypto'

/**
 * Schema and repository for the gmail extension.
 *
 * Four shapes only: a *cimzett* is one entry in the address book the operator
 * keeps by hand, a *kimeno* is one outbound item from draft to release, a
 * *kiserlet* is one refused outbound request, and a *napi* row is one day's
 * two counters. Nothing that is read out of the mailbox is stored here at all
 * (design spec 3.4): a read passes through, and the consumer keeps what the
 * consumer wants to keep. Two copies of a mailbox are two places it can leak
 * from, and the frontier belongs to whoever is sweeping, not to this module.
 *
 * The repository is pure logic over the host's storage handle, so it is tested
 * without the host.
 *
 * WHAT THIS LAYER DOES TO THE TEXT IT STORES: nothing but store it. A subject
 * and a body on an outbound row were composed by a caller, and on the reply
 * path they may quote a message a stranger wrote. Every one of them is bound as
 * a parameter, never spliced into SQL, never used as a name or a key, and never
 * read back to decide a branch. The one text this layer cuts is `mit` on a
 * refused attempt, and `insertKiserlet` carries the argument for why cutting is
 * right exactly there.
 */

/*
 * EVERY KEY IN THIS SCHEMA, AND WHAT IT GATES
 * ===========================================
 * The AI Signal module found eight defects of one shape across seven review
 * rounds, every one of them a key that decided something while blind to what it
 * was deciding about. The shape to avoid here is the outbound mirror of it: A
 * GATE THAT PERMITS SOMETHING OTHER THAN WHAT IT LOOKED AT. This module is the
 * first thing in this system that can put text into the world, so a key that
 * approves an item id while a different byte sequence goes out is the failure
 * that matters, not a miscounted row.
 *
 * This is the whole key set: every primary key, every index, and every lookup
 * and every column that is read as one. A key GATES when a hit or a miss on it
 * changes whether a draft may be written, whether a letter goes out, or how
 * many of either may happen today. Everything else is reporting, ordering or
 * display, and says so.
 *
 *   ext_gmail_cimzettek -- PRIMARY KEY (handle)
 *     gates   WHO A DRAFT MAY BE ADDRESSED TO, together with the
 *             `visszavonva_at IS NULL` test below. A recipient cannot be
 *             derived from text: it is either a handle that hits this key, or
 *             the `From` envelope address of a message being replied to. This
 *             is also the module's killswitch -- an operator who retires every
 *             handle allows no new draft at all, without disabling the
 *             extension -- which is why there is no "enabled" setting beside
 *             it: a switch would do the same job while saying less about what
 *             is actually reachable.
 *     source  the operator, and nothing else: the rpc method that adds an entry
 *             is on the page's surface only, and neither the contract nor the
 *             MCP shim declares one (design spec 3.3). A book a consumer could
 *             write to is not a gate, it is an extra step to the same place.
 *             That method is a later step; what holds today is that this file
 *             offers exactly one way in, `addCimzett`, and that the surfaces
 *             which would expose it do not exist yet.
 *     note    a retired row STAYS. `retireCimzett` sets `visszavonva_at`
 *             rather than deleting, so an outbound row that names the handle
 *             still resolves to something a reader can understand.
 *
 *   cimzett(handle) -- WHERE handle = ?
 *     The read side of that primary key, and the read the resolution step asks.
 *     Gates exactly what the key gates. It answers the ROW, retired or not, so
 *     the caller can tell "no such handle" from "a handle the operator retired"
 *     -- two different facts with two different codes
 *     (`gmail_cimzett_ismeretlen`, `gmail_cimzett_visszavonva`), and collapsing
 *     them here would make that distinction unavailable to every caller.
 *
 *   cimzettek({ elo }) / eloCimzettCount() -- WHERE visszavonva_at IS NULL
 *     gates   the same thing, counted rather than looked up: an empty live book
 *             is the state `health` reports as `gmail_cimzettkonyv_ures` and the
 *             state in which no draft can be addressed. Not an index -- the book
 *             is small by design (design spec 5.2: it grows by hand, one
 *             sentence per entry) and a scan of it is a scan of a few rows.
 *
 *   ext_gmail_kimeno -- PRIMARY KEY (id)
 *     gates   which row a release or a discard acts on, and nothing else about
 *             whether it may act. Surrogate, minted by `uid()` per insert; no
 *             two callers can arrive at it independently.
 *
 *   ext_gmail_kimeno.torzs_hash -- a column read as a key
 *     gates   THE RELEASE, and it is the most important entry in this list. The
 *             page sends back the hash of the body it displayed, as
 *             `megerosites`, and the release step compares it against a hash
 *             computed from the draft it reads FRESH OUT OF GMAIL. The permission
 *             is bound to the byte sequence that is about to go out, not to the
 *             id of the item it was filed under. That is the lesson the video
 *             module took from the 2026-08-06 incident: a gate that approves
 *             something other than what it looked at approves nothing.
 *     source  computed here by `torzsHashOf` from `(cimek, targy, torzs)`, and
 *             never accepted as an argument. A caller that could send its own
 *             hash could send the hash of a body it never displayed.
 *     note    this column holds the hash AS OF THE DRAFT ROW; the comparison
 *             hash is recomputed at release time from Gmail and is not stored
 *             until a `markSzerkesztve` writes it. The two differing is not a
 *             refusal -- see `markSzerkesztve`.
 *
 *   ext_gmail_kimeno.allapot -- a column read as a key
 *     gates   THE SECOND RELEASE. A row already `kiadva` is refused with
 *             `gmail_kimeno_allapot`, never answered with an idempotent "it is
 *             already sent, fine": after a second click the operator has to know
 *             whether the letter went out once or twice, and only a refusal says
 *             which. The vocabulary is closed (`KIMENO_ALLAPOTOK`) and the
 *             transitions are written only by the methods below.
 *     note    THE CHECK IS THE CALLER'S, NOT THIS LAYER'S. `markKiadva`,
 *             `markElvetve` and `setKimenoHiba` write unconditionally; they do
 *             not carry `AND allapot = 'piszkozat'` in their WHERE clauses,
 *             because a write that silently matched no row would report success
 *             for something that did not happen. A caller that skips the state
 *             check therefore overwrites a released row rather than being
 *             stopped here.
 *
 *   ext_gmail_kimeno -- INDEX (allapot, created_at)
 *     gates   nothing. The page lists drafts first and then the rest in time
 *             order, and the outbox method counts by state; both are display.
 *
 *   kimeno(id) -- WHERE id = ?
 *     The read side of the outbound primary key. Answers null for an id no row
 *     carries, rather than a blank row: "there is no such item" and "here is an
 *     item with nothing in it" are different facts and only the first is true.
 *
 *   ext_gmail_kiserletek -- PRIMARY KEY (id)
 *     gates   NOTHING, and that is the entry's whole content. This table is
 *             reporting: it is what a prompt injection becomes -- a row, not an
 *             act. A refusal that leaves no trace is the same as one that never
 *             happened, and on the outbound side a repeated refusal is the most
 *             useful signal this module produces. Surrogate id, as above.
 *
 *   ext_gmail_kiserletek -- INDEX (at)
 *     gates   nothing; the attempts view lists newest first.
 *
 *   ext_gmail_napi -- PRIMARY KEY (nap)
 *     gates   HOW MUCH MAY HAPPEN TODAY, as two separate counters, because a
 *             draft and a release are two different risks: a runaway consumer
 *             makes twenty drafts and stops
 *             (`gmail_piszkozat_keret_kimerult`), a runaway click releases ten
 *             (`gmail_kiadas_keret_kimerult`). The upsert on this key is what
 *             makes two overlapping increments sum rather than overwrite.
 *     source  the `nap` string is THE CALLER'S, and this layer neither computes
 *             it nor checks its shape: the key is exact string equality, so two
 *             callers that spell "today" differently get two rows and two
 *             separate budgets. Design spec 12.2 says the day turns over by
 *             LOCAL date, which is a decision the layer that calls this owes,
 *             not one this file can make on its behalf.
 *     note    NO CAP IS ENFORCED HERE. `bumpNapi` increments and reports; which
 *             number it is compared against, and whether the comparison happens
 *             before or after the increment, is the caller's. See `bumpNapi`.
 *
 *   napi(nap) -- WHERE nap = ?
 *     The read side of that key, answering zeros for a day with no row so a
 *     first call of the day is not a missing-row special case at every caller.
 *
 * WHAT IS DELIBERATELY NOT A KEY: there is no unique index on
 * `(targy, torzs)`. A consumer that writes the same draft twice gets two rows,
 * and that is right -- two drafts are two decisions for the operator, and a
 * quiet merge would take away exactly the thing worth seeing, which is that
 * something ran twice.
 */
export const MIGRATIONS = Object.freeze([{
  version: 1,
  sql: `
CREATE TABLE IF NOT EXISTS ext_gmail_cimzettek (
  handle TEXT PRIMARY KEY, cim TEXT NOT NULL, megjegyzes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, visszavonva_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_gmail_kimeno (
  id TEXT PRIMARY KEY, allapot TEXT NOT NULL, ajto TEXT NOT NULL,
  cimzett_handlek TEXT NOT NULL DEFAULT '[]', cimzett_cimek TEXT NOT NULL DEFAULT '[]',
  valasz_uzenet_id TEXT NOT NULL DEFAULT '', targy TEXT NOT NULL DEFAULT '', torzs TEXT NOT NULL DEFAULT '',
  torzs_hash TEXT NOT NULL, gmail_draft_id TEXT NOT NULL DEFAULT '', gmail_message_id TEXT,
  szerkesztve_at TEXT, cimzett_konyvon_kivul TEXT NOT NULL DEFAULT '[]', kiadva_at TEXT,
  hiba_kod TEXT NOT NULL DEFAULT '', hiba_szoveg TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_gmail_kimeno_allapot ON ext_gmail_kimeno (allapot, created_at);
CREATE TABLE IF NOT EXISTS ext_gmail_kiserletek (
  id TEXT PRIMARY KEY, ajto TEXT NOT NULL, kod TEXT NOT NULL, mit TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_gmail_kiserletek_at ON ext_gmail_kiserletek (at);
CREATE TABLE IF NOT EXISTS ext_gmail_napi (
  nap TEXT PRIMARY KEY, piszkozat INTEGER NOT NULL DEFAULT 0, kiadas INTEGER NOT NULL DEFAULT 0
);
`,
}])

/**
 * The closed state vocabulary of an outbound row.
 *
 * `piszkozat` is the only state a release or a discard may start from;
 * `kiadva`, `elvetve` and `hiba` are ends. Exported because the outbox filter
 * and the release step both name it, and a second copy is how one of them ends
 * up accepting a state the other does not.
 */
export const KIMENO_ALLAPOTOK = Object.freeze(['piszkozat', 'kiadva', 'elvetve', 'hiba'])

/**
 * The two doors a request can arrive through, and the value of the `ajto`
 * column.
 *
 * IT IS THE DOOR, NOT THE CALLER, and the difference is the honest part. No
 * verifiable caller identity reaches this module: a contract handle is a bearer
 * capability whose audience is whoever the consumer passed it to, and the rpc
 * sits behind the host's access key rather than behind a session. So `ajto`
 * records which of this module's own files made the call, as a constant in each
 * of those files rather than as an argument, which is what makes it the one
 * field a caller cannot lie about. It does not say which agent or which module
 * asked. The two files that will spell these -- `contract.mjs` writing
 * `szerzodes` and `rpc.mjs` writing `rpc` -- are later steps; this constant is
 * the vocabulary they are held to, and nothing writes the column yet.
 */
export const AJTOK = Object.freeze(['szerzodes', 'rpc'])

/**
 * The longest `mit` an attempt row stores, in characters.
 *
 * CUT RATHER THAN REFUSED, and this is the one place in the module where that
 * is right. Every other bound here refuses, because a shortened value would be
 * used as if it were whole. This one is not used for anything: it is a line the
 * operator reads on the attempts view to recognise what was being tried. A
 * refusal would mean the module declines to record an attempt because the
 * attempt was too long, which is precisely backwards -- the longest ones are
 * the ones worth seeing a trace of.
 */
export const MAX_KISERLET_MIT = 2000

/** Hex SHA-256 of a string. */
export const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex')

/** A surrogate id: 16 hex characters. Never derived from anything a caller sent. */
export const uid = () => crypto.randomBytes(8).toString('hex')

/** This moment as an ISO-8601 UTC timestamp, which is how every `_at` column in this schema is spelled. */
export const now = () => new Date().toISOString()

/**
 * JSON with every object's keys in sorted order, so two values that differ only
 * in key order serialise identically.
 *
 * `JSON.stringify` walks an object in insertion order, so `{a:1,b:2}` and
 * `{b:2,a:1}` produce different bytes and therefore different hashes. A
 * confirmation hash that changed because a caller built its object in a
 * different order would refuse a release that should have gone through, with a
 * message about a stale page that was not stale.
 *
 * ARRAY ORDER IS PRESERVED. An array is an ordered value and reordering one
 * here would be this function deciding that two different lists are the same.
 * Where order genuinely does not matter -- the recipient set -- the sorting is
 * done by the caller that knows it, which is `torzsHashOf` below.
 *
 * Handles the shapes `torzsHashOf` feeds it: strings, finite numbers, booleans,
 * null, arrays and plain objects. `undefined` becomes `null`, matching what
 * JSON does with an array hole, and anything `JSON.stringify` renders as
 * `undefined` (a function, a symbol) becomes `null` too rather than producing
 * invalid output. It is not a general canonical-JSON implementation: it does
 * not handle cycles, `BigInt` or `toJSON`, and no caller in this module sends
 * one.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const rendered = JSON.stringify(value)
  return rendered === undefined ? 'null' : rendered
}

/**
 * The fingerprint of what would actually go out: the SHA-256 of the canonical
 * JSON of the recipient addresses, the subject and the body.
 *
 * THE ADDRESSES ARE SORTED before they are hashed, so one set of recipients has
 * one fingerprint regardless of the order they were listed in. Without that,
 * re-reading the same draft out of Gmail -- where the order comes back from a
 * header the module did not write -- would produce a different hash than the
 * one stored, and every release of a multi-recipient draft would be refused as
 * stale. A copy is sorted, not the caller's array: a hash function that
 * reordered its input's array would be a surprise at every call site.
 *
 * The three values go in raw. This is a fingerprint of what will be sent, so
 * normalising anything -- trimming the body, lowercasing an address -- would
 * make two different letters fingerprint the same, which is the one thing this
 * value must never do.
 */
export function torzsHashOf({ cimek, targy, torzs }) {
  if (!Array.isArray(cimek)) throw new Error('torzsHashOf needs cimek to be an array of addresses')
  return sha256(canonicalJson({ cimek: [...cimek].sort(), targy, torzs }))
}

/** The two counters `bumpNapi` may raise. A column name is never interpolated from an argument; see `bumpNapi`. */
const NAPI_MEZOK = Object.freeze(['piszkozat', 'kiadas'])

export function createRepo(storage) {
  const S = storage

  /** One address-book row, retired or not, or null. Shared by the reads and by `retireCimzett`. */
  const cimzettOf = (handle) => S.get('SELECT * FROM ext_gmail_cimzettek WHERE handle = ?', [handle]) || null

  /**
   * One day's two counters, always the same three-key object whether or not a
   * row exists.
   *
   * Rebuilt rather than handed back as the driver returned it, so the answer
   * does not change shape with the driver: `better-sqlite3` in the host gives a
   * plain object, `node:sqlite` in the tests gives a null-prototype one, and a
   * caller that spreads or compares the result should not be able to tell which
   * one it is talking to.
   */
  const napiOf = (nap) => {
    const row = S.get('SELECT nap, piszkozat, kiadas FROM ext_gmail_napi WHERE nap = ?', [nap])
    return row ? { nap: row.nap, piszkozat: row.piszkozat, kiadas: row.kiadas } : { nap, piszkozat: 0, kiadas: 0 }
  }

  /**
   * Stamps `updated_at` alongside whatever an outbound write changes, so the
   * page can order by last touch.
   *
   * `setSql` is interpolated into the statement, so it may only ever be a
   * literal written in this file. It is one at every call site below, it names
   * columns and never values, and every value that goes with it is bound as a
   * parameter. A caller-supplied fragment reaching this argument would be an
   * injection, which is why it takes a fragment and a parameter list rather
   * than an object it would have to build the fragment out of.
   */
  const touchKimeno = (id, setSql, params) => {
    S.exec(`UPDATE ext_gmail_kimeno SET ${setSql}, updated_at = ? WHERE id = ?`, [...params, now(), id])
  }

  return {
    // --- the address book ---

    /**
     * One entry by handle, retired or not, or null.
     *
     * The retired row comes back rather than being filtered out, because the
     * caller needs to tell a handle that never existed from one the operator
     * retired, and answer with the code that matches.
     */
    cimzett(handle) {
      return cimzettOf(handle)
    },

    /** The book. `elo: true` narrows it to entries that are not retired; anything else lists the whole book, newest first. */
    cimzettek({ elo = false } = {}) {
      return elo
        ? S.all('SELECT * FROM ext_gmail_cimzettek WHERE visszavonva_at IS NULL ORDER BY created_at DESC, handle ASC')
        : S.all('SELECT * FROM ext_gmail_cimzettek ORDER BY created_at DESC, handle ASC')
    },

    /**
     * Adds one entry.
     *
     * A handle that is already in the book hits the primary key and throws the
     * driver's own error; this layer does not upsert. Reviving a retired handle
     * is a decision -- the operator is putting an address back that they took
     * away -- and it is made by the caller that can ask the operator, not by a
     * silent `ON CONFLICT DO UPDATE` here. The caller reads `cimzett(handle)`
     * first and refuses or revives by name.
     */
    addCimzett({ handle, cim, megjegyzes = '' }) {
      S.exec(
        'INSERT INTO ext_gmail_cimzettek (handle, cim, megjegyzes, created_at, visszavonva_at) VALUES (?,?,?,?,NULL)',
        [handle, cim, megjegyzes, now()],
      )
      return cimzettOf(handle)
    },

    /**
     * Retires one entry and answers the row as it now stands, or null when no
     * row carries that handle.
     *
     * The row is kept: an outbound row that named this handle stays readable.
     * `AND visszavonva_at IS NULL` keeps a second retirement from moving the
     * timestamp, so the stored moment is the moment the operator actually
     * withdrew the address.
     */
    retireCimzett(handle) {
      S.exec('UPDATE ext_gmail_cimzettek SET visszavonva_at = ? WHERE handle = ? AND visszavonva_at IS NULL', [now(), handle])
      return cimzettOf(handle)
    },

    /** How many entries are not retired. Zero is the state in which no draft can be addressed at all. */
    eloCimzettCount() {
      return S.get('SELECT COUNT(*) AS c FROM ext_gmail_cimzettek WHERE visszavonva_at IS NULL').c
    },

    // --- the outbound queue ---

    /**
     * Opens one outbound row and answers its id.
     *
     * WRITTEN BEFORE THE GMAIL CALL, WITH AN EMPTY `gmail_draft_id`. If the
     * draft were created in Gmail first and the row second, a failure between
     * the two would leave a draft standing in the mailbox that this module does
     * not know about and cannot show, discard or count. This way round the
     * leftover is a row with no draft id, which the page renders as an error
     * and the operator can clear. A visible inconsistency beats an invisible
     * one.
     *
     * `torzsHash` is the caller's to pass but not the caller's to invent: it is
     * computed by `torzsHashOf` from the same three values that are stored
     * beside it here. `ajto` is a constant in the calling file, not an argument
     * that reached it from outside -- see `AJTOK`.
     */
    insertKimeno({ allapot, ajto, cimzettHandlek, cimzettCimek, valaszUzenetId = '', targy, torzs, torzsHash, gmailDraftId = '' }) {
      const id = uid()
      const at = now()
      S.exec(
        `INSERT INTO ext_gmail_kimeno (
          id, allapot, ajto, cimzett_handlek, cimzett_cimek, valasz_uzenet_id, targy, torzs, torzs_hash,
          gmail_draft_id, gmail_message_id, szerkesztve_at, cimzett_konyvon_kivul, kiadva_at,
          hiba_kod, hiba_szoveg, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,'[]',NULL,'','',?,?)`,
        [
          id, allapot, ajto, JSON.stringify(cimzettHandlek), JSON.stringify(cimzettCimek), valaszUzenetId,
          targy, torzs, torzsHash, gmailDraftId, at, at,
        ],
      )
      return { id }
    },

    /** Records the draft id Gmail minted, which is the second half of the write order `insertKimeno` describes. */
    setKimenoDraftId(id, draftId) {
      touchKimeno(id, 'gmail_draft_id = ?', [draftId])
    },

    /** One outbound row by id, or null. Null is the answer for an id that never existed and for one that is gone. */
    kimeno(id) {
      return S.get('SELECT * FROM ext_gmail_kimeno WHERE id = ?', [id]) || null
    },

    /**
     * A page of outbound rows, newest first.
     *
     * `allapot` narrows to one state when it is one of `KIMENO_ALLAPOTOK`;
     * absent or blank lists every state. The value is checked against the
     * closed vocabulary by the caller's own reader (`gmail_allapot_ismeretlen`)
     * before it reaches here, and it is bound as a parameter either way.
     *
     * `limit`/`offset` paging is not a stable cursor: a row written between two
     * calls shifts every row after it, so a caller paging with a fixed offset
     * can see a row twice or miss one. `countKimeno` moving between two calls
     * is the only signal that happened. That is acceptable for a page an
     * operator is reading and is not a listing anything sweeps.
     */
    kimenok({ allapot = '', limit = 50, offset = 0 } = {}) {
      return allapot
        ? S.all('SELECT * FROM ext_gmail_kimeno WHERE allapot = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [allapot, limit, offset])
        : S.all('SELECT * FROM ext_gmail_kimeno ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [limit, offset])
    },

    /** How many outbound rows match, for the `total` beside a page. */
    countKimeno({ allapot = '' } = {}) {
      return allapot
        ? S.get('SELECT COUNT(*) AS c FROM ext_gmail_kimeno WHERE allapot = ?', [allapot]).c
        : S.get('SELECT COUNT(*) AS c FROM ext_gmail_kimeno').c
    },

    /**
     * Records that the draft standing in Gmail differs from the row, and brings
     * the row up to what is actually there.
     *
     * NOT A REFUSAL, and the reason is who could have done it: the credential
     * lives only in this module, so the only hand that can have edited that
     * draft is the operator's own, in their own mail client. That is a human
     * decision about their own letter, and refusing it would be this module
     * overruling the person it exists to serve. The page marks the row as
     * edited in Gmail so the operator sees that it happened.
     *
     * `torzsHash` is recomputed from what came back, so the row's fingerprint
     * and the row's text stay one thing.
     */
    markSzerkesztve(id, { targy, torzs, cimzettCimek, torzsHash }) {
      touchKimeno(
        id,
        'targy = ?, torzs = ?, cimzett_cimek = ?, torzs_hash = ?, szerkesztve_at = ?',
        [targy, torzs, JSON.stringify(cimzettCimek), torzsHash, now()],
      )
    },

    /**
     * Closes a row as released.
     *
     * `konyvonKivul` is the addresses that were on the draft at release time and
     * are not in the address book. They are stored rather than refused: an
     * address the operator typed into their own mailbox is a decision, and only
     * a person can tell that apart from an address that appeared without one.
     * Storing it is what lets the page put both in front of that person.
     *
     * `kiadvaAt` is the caller's so it is the same moment the caller reported;
     * it defaults to now for a caller with no opinion.
     *
     * NO STATE GUARD IN THE WHERE CLAUSE, deliberately: see the `allapot` entry
     * in the key list. The refusal for a second release belongs to the caller,
     * where it can say so by name.
     */
    markKiadva(id, { gmailMessageId, konyvonKivul = [], kiadvaAt = now() }) {
      touchKimeno(
        id,
        "allapot = 'kiadva', gmail_message_id = ?, cimzett_konyvon_kivul = ?, kiadva_at = ?",
        [gmailMessageId, JSON.stringify(konyvonKivul), kiadvaAt],
      )
    },

    /** Closes a row as discarded. Same absence of a state guard, same reason. */
    markElvetve(id) {
      touchKimeno(id, "allapot = 'elvetve'", [])
    },

    /**
     * Closes a row as failed, with the code and the text.
     *
     * The state moves to `hiba` as well as the columns being written, because
     * the page's list is grouped by state: a row that carried an error code
     * while still reading as a draft would offer a Release button for something
     * that has no draft in Gmail to release.
     */
    setKimenoHiba(id, kod, szoveg) {
      touchKimeno(id, "allapot = 'hiba', hiba_kod = ?, hiba_szoveg = ?", [kod, szoveg])
    },

    // --- refused attempts ---

    /**
     * Writes one refused outbound request.
     *
     * `mit` is cut to `MAX_KISERLET_MIT` characters here rather than at the
     * caller, so the bound holds however many callers there turn out to be. It
     * is stored raw otherwise: it is what somebody asked for, and the point of
     * the row is that the operator can read it and recognise the attempt. The
     * `String()` around it is the one coercion in this module and it is a floor
     * rather than a reader: this is the failure path, and throwing here because
     * a log field was not a string would replace a named refusal with a crash.
     * The layer that builds `mit` owes it as text. It is
     * bound as a parameter, it is never a name or a key, and nothing branches
     * on it -- the attempts view is the only thing that reads it, and it renders
     * it as text marked as somebody else's words.
     */
    insertKiserlet({ ajto, kod, mit = '' }) {
      const id = uid()
      S.exec(
        'INSERT INTO ext_gmail_kiserletek (id, ajto, kod, mit, at) VALUES (?,?,?,?,?)',
        [id, ajto, kod, String(mit).slice(0, MAX_KISERLET_MIT), now()],
      )
      return { id }
    },

    /** The most recent refused attempts, newest first. */
    kiserletek(limit) {
      return S.all('SELECT * FROM ext_gmail_kiserletek ORDER BY at DESC, id DESC LIMIT ?', [limit])
    },

    // --- the daily counters ---

    /**
     * Raises one of the day's two counters by one and answers the day as it now
     * stands.
     *
     * `mezo` names a column, so it is checked against a closed list and then
     * used to CHOOSE BETWEEN TWO LITERAL STATEMENTS rather than being
     * interpolated into one. A column name cannot be a bound parameter, so the
     * only safe spelling is the one where no caller-supplied byte reaches the
     * SQL text at all. An unknown field is a bug at the call site, not a caller
     * problem, so it throws a plain Error.
     *
     * The upsert is what makes two overlapping increments SUM rather than
     * overwrite; the read that follows it is a second statement, so the two are
     * wrapped in one transaction and the number that comes back is the day as
     * it stood at the end of this increment. That makes the pair one unit in
     * the database, so a failure cannot leave a half-applied increment. It does
     * NOT make the counter safe across two processes writing one database, and
     * nothing in this extension does that. WHAT THIS DOES NOT DO IS ENFORCE A CAP.
     * It does not know one. A caller that compares the returned value against
     * its budget has raised the counter first, which is the safe order across
     * an await -- but it then owns the fact that a refused request has still
     * counted against the day. A caller that reads `napi` first and increments
     * after has the opposite problem across the same await. Neither choice is
     * made here.
     */
    bumpNapi(nap, mezo) {
      if (!NAPI_MEZOK.includes(mezo)) throw new Error(`bumpNapi: unknown field ${JSON.stringify(mezo)}`)
      return S.transaction(() => {
        S.exec(
          mezo === 'piszkozat'
            ? 'INSERT INTO ext_gmail_napi (nap, piszkozat, kiadas) VALUES (?, 1, 0) ON CONFLICT(nap) DO UPDATE SET piszkozat = piszkozat + 1'
            : 'INSERT INTO ext_gmail_napi (nap, piszkozat, kiadas) VALUES (?, 0, 1) ON CONFLICT(nap) DO UPDATE SET kiadas = kiadas + 1',
          [nap],
        )
        return napiOf(nap)
      })
    },

    /** One day's counters. A day with no row reads as zeros, so the first call of a day is not a special case. */
    napi(nap) {
      return napiOf(nap)
    },

    /** The numbers the page's status bar shows. Display only; nothing branches on any of them. */
    counts() {
      return {
        cimzettek: S.get('SELECT COUNT(*) AS c FROM ext_gmail_cimzettek').c,
        eloCimzettek: S.get('SELECT COUNT(*) AS c FROM ext_gmail_cimzettek WHERE visszavonva_at IS NULL').c,
        piszkozat: S.get("SELECT COUNT(*) AS c FROM ext_gmail_kimeno WHERE allapot = 'piszkozat'").c,
        kiadva: S.get("SELECT COUNT(*) AS c FROM ext_gmail_kimeno WHERE allapot = 'kiadva'").c,
        elvetve: S.get("SELECT COUNT(*) AS c FROM ext_gmail_kimeno WHERE allapot = 'elvetve'").c,
        hiba: S.get("SELECT COUNT(*) AS c FROM ext_gmail_kimeno WHERE allapot = 'hiba'").c,
        kiserletek: S.get('SELECT COUNT(*) AS c FROM ext_gmail_kiserletek').c,
      }
    },
  }
}
