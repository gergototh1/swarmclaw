import crypto from 'node:crypto'

/**
 * Schema and repository for the video module.
 *
 * The module is a control plane over a Remotion project the operator owns: it
 * stores what an agent proposed (a plan), what another agent judged (a
 * verdict), what the TTS produced (narration rows), what a render run did, and
 * what the QA gate measured on the file that came out. Everything the tools,
 * the rpc and the page do is a read or a write against these tables, so the
 * repository is pure logic over the host's storage handle and is tested
 * without the host.
 *
 * The repository does not interpret the text it stores. Titles, source text,
 * scene lists, narration sentences, feedback and turn transcripts are written
 * by strangers or assembled from what strangers wrote; every one of them is
 * bound as a parameter, never spliced into SQL, never used as a key by itself,
 * and never read back to decide a branch. The one place a stored text is part
 * of a key is the feedback dedup, and there it is compared for equality and
 * nothing else.
 */

/*
 * EVERY KEY IN THIS SCHEMA, AND WHAT IT GATES
 * ===========================================
 * The AI Signal module found eight defects of one shape across seven review
 * rounds: a key that decided one thing while blind to another, letting a
 * watermark advance past material nobody had read. The shape to avoid here is
 * its mirror image: a GATE THAT PERMITS SOMETHING OTHER THAN WHAT IT LOOKED AT.
 * The incident this module exists to close was an approval given to an item,
 * thirty-six minutes before the file that shipped under it existed. So every
 * gate key below is bound to the fingerprint of the artefact it approves, not
 * to the id of the item it was filed under, and this list is the whole key
 * set: every primary key, every unique index, and every lookup that acts as
 * one. A key GATES when a hit or a miss on it changes whether something is
 * rendered, narrated, shipped or re-proposed. Everything else is reporting,
 * ordering or idempotency, and says so.
 *
 *   ext_video_videos -- PRIMARY KEY (id)
 *     gates   nothing by itself. Surrogate, minted by uid(). The row it names
 *             carries `status`, which the tools read to refuse a call out of
 *             order; that is a column, not a key, and the arrow functions in
 *             the spec's 2.3 are the only writers of it (`setVideoStatus`,
 *             `lezarVideo`).
 *     carries `forras_szoveg`, the raw material written by a stranger, and
 *             `cim`, a title an agent derived from it. Neither is ever a key.
 *
 *   ext_video_videos -- INDEX (status)
 *     gates   nothing. Ordering and the page's counts.
 *
 *   videoForSignal -- WHERE forras_tipus = 'signal' AND forras_id = ?
 *     gates   whether a second video may be opened from one AI Signal card
 *             (`signal_mar_videos` in the tool). Not unique in the schema: the
 *             tool's refusal is the barrier, and this read is what it asks.
 *             Keyed on the card id the `signals` contract handed over, which
 *             is the provider's own surrogate; the card's text is not in it.
 *
 *   ext_video_tervek -- UNIQUE (video_id, verzio)
 *     gates   which plan is THE LATEST. A verdict, a narration set and a render
 *             are written only against the latest plan; the tools refuse an
 *             older one by name (`terv_elavult`), because a judgement is about
 *             a text and the text has moved on. `insertTerv` assigns `verzio`
 *             inside a transaction from MAX(verzio) + 1, so two submissions
 *             cannot both become version 3; the index is what makes that
 *             a guarantee rather than a race the transaction usually wins.
 *
 *   terv_hash -- sha256 of the canonical JSON of {jelenetek, narracio,
 *                asset_ujjlenyomatok}
 *     gates   every fingerprint gate below is keyed on it. It is computed by
 *             `insertTerv` from what is stored and never accepted from a
 *             caller, so a row's hash is a fact about that row.
 *     inside  the scene list, the narration sentences, and the sha256 of every
 *             public/ file the scenes reference -- the reviewer judged the
 *             picture too, and a `kep.png` swapped after the verdict would
 *             otherwise ship under a verdict about another picture.
 *     outside, deliberately: the catalogue hash (`katalogus_hash` is its own
 *             column, and a kit that grew does not change what the reviewer
 *             read); the TTS voice and model (a verdict is about the words,
 *             and the voice is on the narration row, where the render checks
 *             it against the TTS's current setting); the Remotion source
 *             (not watched by this module at all).
 *
 *   ext_video_verdiktek -- INDEX (terv_id, terv_hash); read by passingVerdikt
 *                          WHERE terv_id = ? AND terv_hash = ? AND verdikt = 'atmegy'
 *     gates   THE RENDER. `videoRender` asks for a passing verdict on the
 *             latest plan's id AND that plan's current hash. Both halves are
 *             load-bearing: the id says which submission the reviewer read,
 *             the hash says the content has not changed since. A (video_id,
 *             hash) lookup would find the same content, and would let a v1
 *             verdict approve an identical v3 that followed a failed v2 --
 *             a plan the reviewer never saw. The producer waits for a new
 *             review instead, and that is the price of a verdict being about
 *             one submission. `terv_hash` on the verdict row is COPIED from
 *             the plan at the moment of judgement, so a verdict cannot drift
 *             onto content written later.
 *
 *   ext_video_verdiktek.lektor_agent_id versus ext_video_tervek.szerzo_agent_id
 *     gates   self-review (`onlektoralas`). Not a database key: enforced in
 *             `videoVerdict` by comparing the caller's `ctx.session.agentId`
 *             with the plan's author. Both come from the session the host
 *             hands the tool, never from an argument, and a session with no
 *             agent is refused (`agent_hianyzik`) because `null != null` is
 *             false and would let a self-review through.
 *
 *   ext_video_narraciok -- PRIMARY KEY (terv_id, jelenet), plus terv_hash,
 *                          szoveg_hash, hang, modell, nyelv on the row
 *     gates   THE RENDER, one scene at a time. Every scene with a narration
 *             sentence needs a row whose `szoveg_hash` is the sha256 of the
 *             plan's CURRENT sentence and whose (hang, modell, nyelv) triple
 *             is the TTS's current setting. A reworded sentence with an old
 *             mp3 is not renderable, and neither is a voice change with an
 *             old-voice mp3 (`narracio_hang_valtozott`): the TTS's cache key
 *             is (szolgaltato, modell, hang, nyelv, szoveg_hash), so a text
 *             hash alone would be blind to it, and so would a (hang, modell)
 *             pair -- the spec's table names those two, but the tts answers
 *             with all three, and a language change under an unchanged voice
 *             name is a different mp3 for the same sentence. `nyelv` is
 *             therefore on the row and in the comparison (narracio.mjs,
 *             `hangEgyezik`), and it arrived in migration v2: a row from
 *             before it reads '' there, which matches no current setting and
 *             so reads as "voice changed". That is the safe direction, since
 *             a re-narration of an unchanged sentence is a tts cache hit and
 *             costs nothing, while the other direction ships the wrong audio.
 *             The primary key makes `replaceNarraciok` a whole-set
 *             replacement -- a narration set is one thing, not a pile of rows
 *             to merge into.
 *
 *   ext_video_renderek -- PRIMARY KEY (id)
 *     gates   which row `finishRender` closes. The id is minted by the tool
 *             before the child process exists, so the exit handler names a
 *             row and not a memory it may no longer have.
 *
 *   ext_video_renderek_fut -- UNIQUE INDEX (status) WHERE status = 'fut'
 *     gates   ONE RENDER AT A TIME. A render saturates the machine; two at
 *             once push both past the watchdog's threshold. The partial index
 *             is the barrier, so a second `claimRender` fails at the INSERT
 *             rather than at a check that ran a moment earlier; `claimRender`
 *             turns that failure into `render_folyamatban` and names the
 *             running render's id, so the refusal is something a caller can
 *             wait on. `finishRender` closes a row only WHERE status = 'fut',
 *             so two closers cannot both win and a closed row is never
 *             rewritten.
 *
 *   ext_video_renderek -- INDEX (video_id, started_at)
 *     gates   nothing. The per-video history and the retention sweep's order.
 *
 *   ext_video_qa -- UNIQUE (render_id, file_sha256, szabalykeszlet)
 *     gates   `qa_ok`. A video is `qa_ok` when there is a row with ok = 1 for
 *             the render's CURRENT `file_sha256` under the CURRENT rule set. A
 *             re-render is a new sha and the old pass says nothing about it; a
 *             rule-set bump is a new key and every old pass falls silent. This
 *             is the gate the 2026-08-06 incident lacked: the approval is
 *             bound to the bytes that will ship. `qaFor` spells the key
 *             exactly, and `insertQa` writes with `ON CONFLICT ... DO NOTHING`
 *             on the same three columns, so the first measurement of a
 *             fingerprint stands and a second run cannot flip it. A
 *             measurement that could not run writes NO row here: it is
 *             `qa_meres_sikertelen` on the render row and `qa_meretlen` on
 *             the video, because "the gate failed" and "the gate never ran"
 *             are different facts and only one of them is a row in this table.
 *
 *   ext_video_visszajelzesek_dedup -- UNIQUE INDEX (video_id, COALESCE(at_ms, -1),
 *                                     COALESCE(jelenet, -1), szoveg)
 *     gates   nothing. Idempotent import: the same note at the same moment on
 *             the same video is one row however many times the file is read
 *             back in. SQLite treats NULLs as distinct in a unique index, so a
 *             nullable timestamp and a nullable scene have to be coalesced or
 *             the index enforces nothing for the rows that lack them. `szoveg`
 *             is a stranger's text and is in the key for equality only.
 *
 *   ext_video_megtartas -- PRIMARY KEY (video_id, platform, t_s)
 *     gates   nothing. Idempotent import; a re-import upserts the ratio.
 *
 *   ext_video_fordulok -- PRIMARY KEY (id); INDEX (at)
 *     gates   nothing. `atnezve_at IS NULL` is the review queue and `atnezes_id`
 *             is a stamp a review run leaves before it closes, so an
 *             interrupted review hands its turns back: a stamp is not a
 *             review, and `unreviewedFordulok` reads `atnezve_at` only.
 *
 *   ext_video_javaslatok -- PRIMARY KEY (id)
 *     gates   nothing by index. The duplicate rule and the caps
 *             (`javaslat_duplikat`, `javaslat_nyitott_sapka`) are lookups the
 *             proposal tool applies over `openJavaslatok`, `rejectedSince`
 *             and `countOpen`. `decideJavaslat` writes only WHERE status =
 *             'nyitott', so a decision is made once.
 *
 *   ext_video_tanulsagok -- PRIMARY KEY (id); read by (cel, aktiv)
 *     gates   nothing. A lesson is prompt material for `videoLessons`, not a
 *             gate.
 *
 *   ext_video_ugynokok -- PRIMARY KEY (agent_id)
 *     gates   nothing about a video. Not in the spec's table list: it records
 *             which agent ids have acted through videoDraft and videoVerdict,
 *             so the afterChatTurn hook can tell the module's own agents from
 *             every other agent on the host without a host API extension code
 *             cannot reach. The first role seen is kept and later ones are
 *             ignored; the row answers "is this one of ours", not "which one".
 *
 *   bizonyitekLetezik -- one id against fordulok, videos, tervek, verdiktek,
 *                        renderek, qa and visszajelzesek
 *     gates   whether a proposal may cite an id as evidence. A miss refuses
 *             the proposal by name; an evidence list is the proposal's claim
 *             to have looked at something, and an id that names nothing is a
 *             claim nothing backs.
 *
 * Video status values: nyitott, terv, lektoralt, elbukott, narralt, renderel,
 * render_hiba, qa_ok, qa_hiba, qa_meretlen, lezart. `qa_meretlen` is the
 * plan's addition for a finished file the QA could not measure: calling that
 * `qa_hiba` would report a failed check that never ran. The spec's render
 * status `elveszett` is kept in the vocabulary and written by nothing, and
 * `finishRender` refuses it: the recovery procedure in the spec's 3.4 closes
 * every dead render as `kesz` or `hiba` with a code, so a row that read
 * `elveszett` would be one the procedure had not run on.
 */
export const MIGRATIONS = Object.freeze([{
  version: 1,
  sql: `
CREATE TABLE IF NOT EXISTS ext_video_videos (
  id TEXT PRIMARY KEY, cim TEXT NOT NULL, forras_tipus TEXT NOT NULL, forras_id TEXT NOT NULL DEFAULT '',
  forras_szoveg TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, nyitotta_agent_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lezarva_at TEXT
);
CREATE INDEX IF NOT EXISTS ext_video_videos_status ON ext_video_videos (status);
CREATE TABLE IF NOT EXISTS ext_video_tervek (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL, verzio INTEGER NOT NULL, jelenetek TEXT NOT NULL, narracio TEXT NOT NULL,
  asset_ujjlenyomatok TEXT NOT NULL DEFAULT '[]', terv_hash TEXT NOT NULL, katalogus_hash TEXT NOT NULL,
  szerzo_agent_id TEXT NOT NULL, szerzo_session_id TEXT NOT NULL DEFAULT '', ellenorzes TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (video_id, verzio)
);
CREATE TABLE IF NOT EXISTS ext_video_verdiktek (
  id TEXT PRIMARY KEY, terv_id TEXT NOT NULL, terv_hash TEXT NOT NULL, lektor_agent_id TEXT NOT NULL,
  lektor_session_id TEXT NOT NULL DEFAULT '', verdikt TEXT NOT NULL, talalatok TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_video_verdiktek_terv ON ext_video_verdiktek (terv_id, terv_hash);
CREATE TABLE IF NOT EXISTS ext_video_narraciok (
  terv_id TEXT NOT NULL, terv_hash TEXT NOT NULL, jelenet INTEGER NOT NULL, szoveg_hash TEXT NOT NULL,
  hang TEXT NOT NULL, modell TEXT NOT NULL, fajl TEXT NOT NULL, hossz_ms INTEGER NOT NULL,
  tts_keres_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  PRIMARY KEY (terv_id, jelenet)
);
CREATE TABLE IF NOT EXISTS ext_video_renderek (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL, terv_id TEXT NOT NULL, terv_hash TEXT NOT NULL, verdikt_id TEXT NOT NULL,
  status TEXT NOT NULL, pid INTEGER, host_boot_at INTEGER NOT NULL, jelenet_hatarok TEXT NOT NULL DEFAULT '[]',
  props_path TEXT, out_path TEXT, log_path TEXT, torolve_at TEXT, file_sha256 TEXT,
  hiba_kod TEXT NOT NULL DEFAULT '', hiba_szoveg TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_video_renderek_fut ON ext_video_renderek (status) WHERE status = 'fut';
CREATE INDEX IF NOT EXISTS ext_video_renderek_video ON ext_video_renderek (video_id, started_at);
CREATE TABLE IF NOT EXISTS ext_video_qa (
  id TEXT PRIMARY KEY, render_id TEXT NOT NULL, file_sha256 TEXT NOT NULL, szabalykeszlet INTEGER NOT NULL, ok INTEGER NOT NULL,
  meresek TEXT NOT NULL DEFAULT '{}', bukasok TEXT NOT NULL DEFAULT '[]', checked_at TEXT NOT NULL,
  UNIQUE (render_id, file_sha256, szabalykeszlet)
);
CREATE TABLE IF NOT EXISTS ext_video_visszajelzesek (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL, render_id TEXT, at_ms INTEGER, jelenet INTEGER,
  szoveg TEXT NOT NULL, forras TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_video_visszajelzesek_dedup ON ext_video_visszajelzesek (video_id, COALESCE(at_ms, -1), COALESCE(jelenet, -1), szoveg);
CREATE TABLE IF NOT EXISTS ext_video_megtartas (
  video_id TEXT NOT NULL, platform TEXT NOT NULL, t_s INTEGER NOT NULL, arany REAL NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY (video_id, platform, t_s)
);
CREATE TABLE IF NOT EXISTS ext_video_fordulok (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, forras TEXT NOT NULL,
  uzenet TEXT NOT NULL, valasz TEXT NOT NULL, toolok TEXT NOT NULL DEFAULT '[]', at TEXT NOT NULL,
  atnezve_at TEXT, atnezes_id TEXT
);
CREATE INDEX IF NOT EXISTS ext_video_fordulok_at ON ext_video_fordulok (at);
CREATE TABLE IF NOT EXISTS ext_video_javaslatok (
  id TEXT PRIMARY KEY, cel TEXT NOT NULL, fajta TEXT NOT NULL, cim TEXT NOT NULL, szoveg TEXT NOT NULL,
  bizonyitek TEXT NOT NULL, status TEXT NOT NULL, javasolta_agent_id TEXT NOT NULL DEFAULT '',
  futas_session_id TEXT NOT NULL DEFAULT '', dontes_megjegyzes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_video_tanulsagok (
  id TEXT PRIMARY KEY, javaslat_id TEXT NOT NULL, cel TEXT NOT NULL, szoveg TEXT NOT NULL,
  aktiv INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, visszavonva_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_video_ugynokok (
  agent_id TEXT PRIMARY KEY, szerep TEXT NOT NULL, first_seen_at TEXT NOT NULL
);
`,
}, {
  /*
   * The language the narration was made in, beside the voice and the model:
   * the third field of the tts cache key, missing from v1 (see the key list,
   * ext_video_narraciok). '' for a row written before this version; no such
   * row exists in practice, because the tool that writes this table arrived
   * with this migration, and a '' row would only ever read as "voice changed".
   *
   * ALTER TABLE ADD COLUMN is not idempotent, and it does not need to be: the
   * host applies a version once per extension id and never re-runs it
   * (extension-storage.ts, runExtensionMigrations). v1 is all IF NOT EXISTS
   * because it also has to survive a table left behind by an uninstall that
   * missed it; a leftover table already carries this column or has never seen
   * v2, and either way v2 runs against it exactly once.
   */
  version: 2,
  sql: `
ALTER TABLE ext_video_narraciok ADD COLUMN nyelv TEXT NOT NULL DEFAULT '';
`,
}])

export const VIDEO_STATUSOK = Object.freeze(['nyitott', 'terv', 'lektoralt', 'elbukott', 'narralt', 'renderel', 'render_hiba', 'qa_ok', 'qa_hiba', 'qa_meretlen', 'lezart'])
export const RENDER_STATUSOK = Object.freeze(['fut', 'kesz', 'hiba', 'elveszett'])
/** The two statuses `finishRender` will write. `fut` is the open state and `elveszett` is written by nothing (see the key list). */
const RENDER_ZARO_STATUSOK = Object.freeze(['kesz', 'hiba'])
export const JAVASLAT_CELOK = Object.freeze(['agent:gyarto', 'agent:lektor', 'skill:video-jelenetlista', 'skill:video-lektoralas', 'szabaly', 'sablon'])
export const JAVASLAT_FAJTAK = Object.freeze(['tanulsag', 'szabaly', 'sablon'])
export const JAVASLAT_STATUSOK = Object.freeze(['nyitott', 'elfogadva', 'elutasitva', 'kodolva'])
/** The two statuses an operator's decision writes. `kodolva` follows `elfogadva` through `markKodolva`; `nyitott` is never written back. */
const JAVASLAT_DONTESEK = Object.freeze(['elfogadva', 'elutasitva'])
/** Characters kept of a turn's message and of its response (spec 3.1). */
export const FORDULO_MAX = 4000

export const now = () => new Date().toISOString()
export const uid = () => crypto.randomBytes(8).toString('hex')
export const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex')

/**
 * JSON with object keys sorted at every depth; arrays keep their order.
 *
 * The value semantics are JSON.stringify's, so the output is always what
 * `JSON.stringify(JSON.parse(text))` would give for some `text` with its keys
 * sorted: a `toJSON` method is honoured, a key whose value is undefined, a
 * function or a symbol is dropped, such a value inside an array becomes null,
 * and a non-finite number becomes null. Most callers hand this a value that
 * came out of JSON.parse and none of that arises; `tervHashOf` is also called
 * on objects assembled in memory by the tools, and a hash that differed
 * between the in-memory object and its stored JSON would be a fingerprint of
 * nothing. The top-level result is undefined only for a value JSON.stringify
 * itself would not serialise.
 */
export function canonicalJson(value) {
  if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') return canonicalJson(value.toJSON())
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v) ?? 'null').join(',')}]`
  if (value !== null && typeof value === 'object') {
    const parts = []
    for (const k of Object.keys(value).sort()) {
      const v = canonicalJson(value[k])
      if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`)
    }
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The plan fingerprint every gate is keyed on. See `terv_hash` in the key list
 * for what is in it and what is deliberately not.
 */
export function tervHashOf({ jelenetek, narracio, assetUjjlenyomatok }) {
  return sha256(canonicalJson({ jelenetek, narracio, asset_ujjlenyomatok: assetUjjlenyomatok }))
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString()

/**
 * The first `max` characters of a text, never ending inside a surrogate pair.
 * `slice` counts UTF-16 units, so a cut that lands between the two halves of
 * an emoji or a supplementary character would store a lone surrogate, which
 * is not text and which JSON.stringify escapes into something the review
 * agent then reads as noise. Exported for the one other cut this module
 * makes, the title `videoOpen` derives from a source text (terv.mjs).
 */
export function head(text, max) {
  if (text.length <= max) return text
  const cut = text.charCodeAt(max - 1)
  return text.slice(0, cut >= 0xd800 && cut <= 0xdbff ? max - 1 : max)
}

/**
 * The repository over the host's `ExtensionStorage` handle: `exec` runs one
 * statement, `all`/`get` read, `transaction` rolls back and rethrows. Every
 * method is synchronous because the handle is. Nothing here throws a
 * VideoError: a repository does not refuse a caller, it either does the write
 * or reports (with a boolean or a null) that the row was not in the state the
 * write needs. The exceptions are the vocabulary checks, which throw a plain
 * Error because a status outside the closed list is a bug in the calling
 * code, not a caller's opinion to refuse.
 */
export function createRepo(storage) {
  const S = storage
  const count = (sql, params = []) => S.get(sql, params).c
  const repo = {
    /** The storage handle, for a caller that must group several writes in one transaction (the rpc's proposal decision). */
    storage: S,
    // --- videos ---
    openVideo({ cim, forrasTipus, forrasId, forrasSzoveg, nyitottaAgentId }) {
      const id = uid()
      const t = now()
      S.exec('INSERT INTO ext_video_videos (id, cim, forras_tipus, forras_id, forras_szoveg, status, nyitotta_agent_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, cim, forrasTipus, forrasId, forrasSzoveg, 'nyitott', nyitottaAgentId, t, t])
      return { id }
    },
    video(id) { return S.get('SELECT * FROM ext_video_videos WHERE id = ?', [id]) || null },
    videos() { return S.all('SELECT * FROM ext_video_videos ORDER BY created_at DESC, rowid DESC') },
    videosByStatus(status) { return S.all('SELECT * FROM ext_video_videos WHERE status = ? ORDER BY created_at ASC, rowid ASC', [status]) },
    /**
     * The video opened from an AI Signal card, or null. The tool refuses a
     * second video per card, so there is at most one in practice; if two ever
     * exist, the earliest is the one whose existence made the others a refusal.
     */
    videoForSignal(signalId) {
      return S.get("SELECT * FROM ext_video_videos WHERE forras_tipus = 'signal' AND forras_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1", [signalId]) || null
    },
    videosOpenedSince(iso) { return count('SELECT COUNT(*) AS c FROM ext_video_videos WHERE created_at >= ?', [iso]) },
    /**
     * One of the spec's 2.3 arrows. `lezart` is not written here: it carries
     * `lezarva_at` with it, and `lezarVideo` is the one writer of the pair.
     */
    setVideoStatus(id, status) {
      if (!VIDEO_STATUSOK.includes(status)) throw new Error('setVideoStatus: status outside VIDEO_STATUSOK')
      if (status === 'lezart') throw new Error('setVideoStatus: lezart is written by lezarVideo, which also stamps lezarva_at')
      S.exec('UPDATE ext_video_videos SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id])
    },
    lezarVideo(id) {
      const t = now()
      S.exec("UPDATE ext_video_videos SET status = 'lezart', lezarva_at = ?, updated_at = ? WHERE id = ?", [t, t, id])
    },
    // --- tervek ---
    /**
     * Stores a plan as the video's next version and returns its fingerprint.
     * The hash is computed here from what is stored, never taken from the
     * caller; the version is assigned inside the transaction and the UNIQUE
     * index is what makes two concurrent submissions two versions.
     */
    insertTerv({ videoId, jelenetek, narracio, assetUjjlenyomatok, katalogusHash, szerzoAgentId, szerzoSessionId, ellenorzes }) {
      return S.transaction(() => {
        const prev = S.get('SELECT MAX(verzio) AS v FROM ext_video_tervek WHERE video_id = ?', [videoId]).v
        const verzio = (prev || 0) + 1
        const id = uid()
        const tervHash = tervHashOf({ jelenetek, narracio, assetUjjlenyomatok })
        S.exec('INSERT INTO ext_video_tervek (id, video_id, verzio, jelenetek, narracio, asset_ujjlenyomatok, terv_hash, katalogus_hash, szerzo_agent_id, szerzo_session_id, ellenorzes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, videoId, verzio, JSON.stringify(jelenetek), JSON.stringify(narracio), JSON.stringify(assetUjjlenyomatok), tervHash, katalogusHash, szerzoAgentId, szerzoSessionId, JSON.stringify(ellenorzes), now()])
        return { id, verzio, tervHash }
      })
    },
    terv(id) { return S.get('SELECT * FROM ext_video_tervek WHERE id = ?', [id]) || null },
    latestTerv(videoId) { return S.get('SELECT * FROM ext_video_tervek WHERE video_id = ? ORDER BY verzio DESC LIMIT 1', [videoId]) || null },
    latestTervek() { return S.all('SELECT t.* FROM ext_video_tervek t WHERE t.verzio = (SELECT MAX(verzio) FROM ext_video_tervek WHERE video_id = t.video_id)') },
    tervekAll() { return S.all('SELECT * FROM ext_video_tervek') },
    tervekForVideo(videoId) { return S.all('SELECT * FROM ext_video_tervek WHERE video_id = ? ORDER BY verzio ASC', [videoId]) },
    // --- verdiktek ---
    /** `tervHash` is the plan's hash as the caller read it at judgement time; the tool passes the row's, never an argument. */
    insertVerdikt({ tervId, tervHash, lektorAgentId, lektorSessionId, verdikt, talalatok }) {
      const id = uid()
      S.exec('INSERT INTO ext_video_verdiktek (id, terv_id, terv_hash, lektor_agent_id, lektor_session_id, verdikt, talalatok, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, tervId, tervHash, lektorAgentId, lektorSessionId, verdikt, JSON.stringify(talalatok), now()])
      return { id }
    },
    /** The render gate's read: a pass on exactly this plan id and exactly this hash, or null. */
    passingVerdikt(tervId, tervHash) {
      return S.get("SELECT * FROM ext_video_verdiktek WHERE terv_id = ? AND terv_hash = ? AND verdikt = 'atmegy' ORDER BY created_at DESC, rowid DESC LIMIT 1", [tervId, tervHash]) || null
    },
    verdiktek(tervId) { return S.all('SELECT * FROM ext_video_verdiktek WHERE terv_id = ? ORDER BY created_at ASC, rowid ASC', [tervId]) },
    verdiktekAll() { return S.all('SELECT * FROM ext_video_verdiktek ORDER BY created_at ASC, rowid ASC') },
    verdiktekSince(iso) { return S.all('SELECT * FROM ext_video_verdiktek WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC', [iso]) },
    // --- narraciok ---
    /**
     * Replaces the plan's whole narration set in one transaction; a set is one
     * thing, and a partial one is not a set. Every row must carry the whole
     * voice triple (hang, modell, nyelv) as non-empty strings: a row missing
     * one would compare as "voice changed" forever, or, worse, a caller that
     * dropped `nyelv` would be storing two thirds of the fingerprint the key
     * list promises. That is a bug at the call site, so it throws rather than
     * refusing, and it throws before the DELETE, so the old set stays.
     */
    replaceNarraciok(tervId, rows) {
      for (const r of rows) {
        for (const mezo of ['hang', 'modell', 'nyelv']) {
          if (typeof r[mezo] !== 'string' || r[mezo] === '') throw new Error(`replaceNarraciok: jelenet ${r.jelenet} row needs a non-empty ${mezo}`)
        }
      }
      return S.transaction(() => {
        S.exec('DELETE FROM ext_video_narraciok WHERE terv_id = ?', [tervId])
        for (const r of rows) {
          S.exec('INSERT INTO ext_video_narraciok (terv_id, terv_hash, jelenet, szoveg_hash, hang, modell, nyelv, fajl, hossz_ms, tts_keres_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [tervId, r.tervHash, r.jelenet, r.szovegHash, r.hang, r.modell, r.nyelv, r.fajl, r.hosszMs, r.ttsKeresId, now()])
        }
        return rows.length
      })
    },
    narraciok(tervId) { return S.all('SELECT * FROM ext_video_narraciok WHERE terv_id = ? ORDER BY jelenet ASC', [tervId]) },
    narraciokAll() { return S.all('SELECT * FROM ext_video_narraciok') },
    // --- renderek ---
    /**
     * Opens a render row in the `fut` state, or names the render that is
     * already running. The partial unique index is the barrier: the INSERT
     * fails when a `fut` row exists, and the running row is read back so the
     * refusal names it. If the INSERT failed for any other reason while a
     * render is running, the answer is still `render_folyamatban` -- a render
     * IS running, and the claim would have failed on that alone. With no
     * running render the failure is not the barrier's and propagates as the
     * bug it is.
     */
    claimRender({ id, videoId, tervId, tervHash, verdiktId, hostBootAt, jelenetHatarok, propsPath, outPath, logPath, platform }) {
      try {
        S.exec('INSERT INTO ext_video_renderek (id, video_id, terv_id, terv_hash, verdikt_id, status, pid, host_boot_at, jelenet_hatarok, props_path, out_path, log_path, platform, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, videoId, tervId, tervHash, verdiktId, 'fut', null, hostBootAt, JSON.stringify(jelenetHatarok), propsPath, outPath, logPath, platform, now()])
        return { id }
      } catch (err) {
        const running = repo.runningRender()
        if (running) return { error: 'render_folyamatban', renderId: running.id }
        throw err
      }
    },
    runningRender() { return S.get("SELECT * FROM ext_video_renderek WHERE status = 'fut' LIMIT 1") || null },
    setRenderPid(id, pid) { S.exec("UPDATE ext_video_renderek SET pid = ? WHERE id = ? AND status = 'fut'", [pid, id]) },
    render(id) { return S.get('SELECT * FROM ext_video_renderek WHERE id = ?', [id]) || null },
    rendersForVideo(videoId) { return S.all('SELECT * FROM ext_video_renderek WHERE video_id = ? ORDER BY started_at DESC, rowid DESC', [videoId]) },
    rendersAll() { return S.all('SELECT * FROM ext_video_renderek ORDER BY started_at DESC, rowid DESC') },
    /**
     * Closes a running render; returns false when it was not running, so two
     * closers (the exit handler and a status check) cannot both win and a
     * closed row is never rewritten.
     *
     * Only `kesz` and `hiba` close a row. `kesz` needs the file's sha256,
     * because a finished render with no fingerprint could never be QA'd and
     * would sit as `kesz` forever; `hiba` needs a code, because a failure
     * with no name is the false report this module does not make. Both are
     * bugs at the call site, not refusals, and throw as such.
     */
    finishRender(id, { status, fileSha256 = null, hibaKod = '', hibaSzoveg = '' }) {
      if (!RENDER_ZARO_STATUSOK.includes(status)) throw new Error('finishRender: status must be kesz or hiba')
      if (status === 'kesz' && (typeof fileSha256 !== 'string' || fileSha256 === '')) throw new Error('finishRender: kesz needs the file sha256')
      if (status === 'hiba' && (typeof hibaKod !== 'string' || hibaKod === '')) throw new Error('finishRender: hiba needs a code')
      return S.transaction(() => {
        const running = S.get("SELECT id FROM ext_video_renderek WHERE id = ? AND status = 'fut'", [id])
        if (!running) return false
        S.exec("UPDATE ext_video_renderek SET status = ?, file_sha256 = ?, hiba_kod = ?, hiba_szoveg = ?, finished_at = ? WHERE id = ? AND status = 'fut'",
          [status, fileSha256, hibaKod, hibaSzoveg, now(), id])
        return true
      })
    },
    /** A note on a closed row (the QA could not measure it); does not change its status. */
    setRenderHiba(id, hibaKod, hibaSzoveg) { S.exec('UPDATE ext_video_renderek SET hiba_kod = ?, hiba_szoveg = ? WHERE id = ?', [hibaKod, hibaSzoveg, id]) },
    markRenderDeleted(id) { S.exec('UPDATE ext_video_renderek SET out_path = NULL, props_path = NULL, log_path = NULL, torolve_at = ? WHERE id = ?', [now(), id]) },
    // --- qa ---
    /**
     * Records one measurement of one file under one rule set, and returns the
     * row that stands for that key -- the one just written, or the earlier
     * one when the fingerprint was measured before. `ON CONFLICT` names the
     * three key columns rather than `INSERT OR IGNORE`, so only that conflict
     * is excused and any other failure surfaces.
     */
    insertQa({ renderId, fileSha256, szabalykeszlet, ok, meresek, bukasok }) {
      S.exec('INSERT INTO ext_video_qa (id, render_id, file_sha256, szabalykeszlet, ok, meresek, bukasok, checked_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (render_id, file_sha256, szabalykeszlet) DO NOTHING',
        [uid(), renderId, fileSha256, szabalykeszlet, ok ? 1 : 0, JSON.stringify(meresek), JSON.stringify(bukasok), now()])
      return repo.qaFor(renderId, fileSha256, szabalykeszlet)
    },
    /** The QA gate's read: the measurement of exactly this file under exactly this rule set, or null. */
    qaFor(renderId, fileSha256, szabalykeszlet) {
      return S.get('SELECT * FROM ext_video_qa WHERE render_id = ? AND file_sha256 = ? AND szabalykeszlet = ?', [renderId, fileSha256, szabalykeszlet]) || null
    },
    qaAll() { return S.all('SELECT * FROM ext_video_qa ORDER BY checked_at ASC, rowid ASC') },
    // --- visszajelzesek ---
    /**
     * Files a note and says whether it was new. The conflict target spells
     * the dedup index's expressions exactly, so the write uses that index and
     * excuses only that conflict; the read-back spells the same key.
     */
    insertFeedback({ videoId, renderId = null, atMs = null, jelenet = null, szoveg, forras }) {
      const id = uid()
      S.exec('INSERT INTO ext_video_visszajelzesek (id, video_id, render_id, at_ms, jelenet, szoveg, forras, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (video_id, COALESCE(at_ms, -1), COALESCE(jelenet, -1), szoveg) DO NOTHING',
        [id, videoId, renderId, atMs, jelenet, szoveg, forras, now()])
      const row = S.get('SELECT id FROM ext_video_visszajelzesek WHERE video_id = ? AND COALESCE(at_ms, -1) = COALESCE(?, -1) AND COALESCE(jelenet, -1) = COALESCE(?, -1) AND szoveg = ?',
        [videoId, atMs, jelenet, szoveg])
      return { id: row.id, uj: row.id === id }
    },
    feedbackFor(videoId) { return S.all('SELECT * FROM ext_video_visszajelzesek WHERE video_id = ? ORDER BY created_at ASC, rowid ASC', [videoId]) },
    feedbackSince(iso) { return S.all('SELECT * FROM ext_video_visszajelzesek WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC', [iso]) },
    feedbackAll() { return S.all('SELECT * FROM ext_video_visszajelzesek') },
    // --- megtartas ---
    upsertRetention(rows) {
      return S.transaction(() => {
        for (const r of rows) {
          S.exec('INSERT INTO ext_video_megtartas (video_id, platform, t_s, arany, imported_at) VALUES (?,?,?,?,?) ON CONFLICT (video_id, platform, t_s) DO UPDATE SET arany = excluded.arany, imported_at = excluded.imported_at',
            [r.videoId, r.platform, r.tS, r.arany, now()])
        }
        return rows.length
      })
    },
    retentionFor(videoId) { return S.all('SELECT * FROM ext_video_megtartas WHERE video_id = ? ORDER BY platform ASC, t_s ASC', [videoId]) },
    retentionVideoIds() { return S.all('SELECT DISTINCT video_id FROM ext_video_megtartas').map((r) => r.video_id) },
    // --- fordulok ---
    /** Message and response are kept to FORDULO_MAX characters each; `toolok` is stored whole. */
    insertFordulo({ sessionId, agentId, forras, uzenet, valasz, toolok }) {
      const id = uid()
      S.exec('INSERT INTO ext_video_fordulok (id, session_id, agent_id, forras, uzenet, valasz, toolok, at) VALUES (?,?,?,?,?,?,?,?)',
        [id, sessionId, agentId, forras, head(uzenet, FORDULO_MAX), head(valasz, FORDULO_MAX), JSON.stringify(toolok), now()])
      return { id }
    },
    unreviewedFordulok(limit) { return S.all('SELECT * FROM ext_video_fordulok WHERE atnezve_at IS NULL ORDER BY at ASC, rowid ASC LIMIT ?', [limit]) },
    latestFordulok(limit) { return S.all('SELECT * FROM ext_video_fordulok ORDER BY at DESC, rowid DESC LIMIT ?', [limit]) },
    countUnreviewedFordulok() { return count('SELECT COUNT(*) AS c FROM ext_video_fordulok WHERE atnezve_at IS NULL') },
    /**
     * Marks the turns a review run is about to read. A stamp is not a review:
     * `unreviewedFordulok` keeps returning stamped rows until `closeAtnezes`
     * sets `atnezve_at`, so a run that dies mid-review hands them back. One
     * transaction, so a run's stamp is on all of its turns or on none.
     */
    stampAtnezes(ids, atnezesId) {
      S.transaction(() => {
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500)
          S.exec(`UPDATE ext_video_fordulok SET atnezes_id = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, [atnezesId, ...chunk])
        }
      })
    },
    /** Closes a review run's stamped turns; returns how many it closed, so a second close of the same run reports 0. */
    closeAtnezes(atnezesId) {
      return S.transaction(() => {
        const c = count('SELECT COUNT(*) AS c FROM ext_video_fordulok WHERE atnezes_id = ? AND atnezve_at IS NULL', [atnezesId])
        S.exec('UPDATE ext_video_fordulok SET atnezve_at = ? WHERE atnezes_id = ? AND atnezve_at IS NULL', [now(), atnezesId])
        return c
      })
    },
    pruneFordulok(days) { S.exec('DELETE FROM ext_video_fordulok WHERE at < ?', [isoDaysAgo(days)]) },
    fordulo(id) { return S.get('SELECT * FROM ext_video_fordulok WHERE id = ?', [id]) || null },
    // --- javaslatok ---
    insertJavaslat({ cel, fajta, cim, szoveg, bizonyitek, javasoltaAgentId, futasSessionId }) {
      const id = uid()
      S.exec("INSERT INTO ext_video_javaslatok (id, cel, fajta, cim, szoveg, bizonyitek, status, javasolta_agent_id, futas_session_id, created_at) VALUES (?,?,?,?,?,?,'nyitott',?,?,?)",
        [id, cel, fajta, cim, szoveg, JSON.stringify(bizonyitek), javasoltaAgentId, futasSessionId, now()])
      return { id }
    },
    javaslat(id) { return S.get('SELECT * FROM ext_video_javaslatok WHERE id = ?', [id]) || null },
    javaslatokByStatus(status) { return S.all('SELECT * FROM ext_video_javaslatok WHERE status = ? ORDER BY created_at DESC, rowid DESC', [status]) },
    openJavaslatok() { return repo.javaslatokByStatus('nyitott') },
    rejectedSince(iso) { return S.all("SELECT * FROM ext_video_javaslatok WHERE status = 'elutasitva' AND decided_at >= ? ORDER BY decided_at DESC, rowid DESC", [iso]) },
    countOpen() { return count("SELECT COUNT(*) AS c FROM ext_video_javaslatok WHERE status = 'nyitott'") },
    countInSession(sessionId) { return count('SELECT COUNT(*) AS c FROM ext_video_javaslatok WHERE futas_session_id = ?', [sessionId]) },
    countByStatusFajta(status, fajta) { return count('SELECT COUNT(*) AS c FROM ext_video_javaslatok WHERE status = ? AND fajta = ?', [status, fajta]) },
    /**
     * The operator's decision, made once: false when the proposal was not
     * open, so a second decision cannot overwrite the first. Only the two
     * decision statuses are accepted; `kodolva` is reached through
     * `markKodolva` from `elfogadva`, and nothing reopens a proposal.
     */
    decideJavaslat(id, status, megjegyzes) {
      if (!JAVASLAT_DONTESEK.includes(status)) throw new Error('decideJavaslat: status must be elfogadva or elutasitva')
      return S.transaction(() => {
        const open = S.get("SELECT id FROM ext_video_javaslatok WHERE id = ? AND status = 'nyitott'", [id])
        if (!open) return false
        S.exec("UPDATE ext_video_javaslatok SET status = ?, dontes_megjegyzes = ?, decided_at = ? WHERE id = ? AND status = 'nyitott'", [status, megjegyzes, now(), id])
        return true
      })
    },
    markKodolva(id) { S.exec("UPDATE ext_video_javaslatok SET status = 'kodolva' WHERE id = ? AND status = 'elfogadva'", [id]) },
    // --- tanulsagok ---
    insertTanulsag({ javaslatId, cel, szoveg }) {
      const id = uid()
      S.exec('INSERT INTO ext_video_tanulsagok (id, javaslat_id, cel, szoveg, aktiv, created_at) VALUES (?,?,?,?,1,?)', [id, javaslatId, cel, szoveg, now()])
      return { id }
    },
    activeTanulsagok(cel) { return S.all('SELECT * FROM ext_video_tanulsagok WHERE cel = ? AND aktiv = 1 ORDER BY created_at DESC, rowid DESC', [cel]) },
    countActiveTanulsagok(cel) { return count('SELECT COUNT(*) AS c FROM ext_video_tanulsagok WHERE cel = ? AND aktiv = 1', [cel]) },
    tanulsagokAll() { return S.all('SELECT * FROM ext_video_tanulsagok ORDER BY cel ASC, created_at DESC, rowid DESC') },
    retireTanulsag(id) { S.exec('UPDATE ext_video_tanulsagok SET aktiv = 0, visszavonva_at = ? WHERE id = ? AND aktiv = 1', [now(), id]) },
    // --- ugynokok ---
    /** Records that an agent acted through the module; the first role seen stands. */
    rememberAgent(agentId, szerep) { S.exec('INSERT INTO ext_video_ugynokok (agent_id, szerep, first_seen_at) VALUES (?,?,?) ON CONFLICT (agent_id) DO NOTHING', [agentId, szerep, now()]) },
    knownAgentIds() { return new Set(S.all('SELECT agent_id FROM ext_video_ugynokok').map((r) => r.agent_id)) },
    // --- evidence ---
    /** True when the id names a row in any table a proposal may cite. The id is bound seven times, never spliced. */
    bizonyitekLetezik(id) {
      const row = S.get(
        'SELECT 1 AS ok FROM ext_video_fordulok WHERE id = ? UNION SELECT 1 FROM ext_video_videos WHERE id = ? UNION SELECT 1 FROM ext_video_tervek WHERE id = ? UNION SELECT 1 FROM ext_video_verdiktek WHERE id = ? UNION SELECT 1 FROM ext_video_renderek WHERE id = ? UNION SELECT 1 FROM ext_video_qa WHERE id = ? UNION SELECT 1 FROM ext_video_visszajelzesek WHERE id = ?',
        [id, id, id, id, id, id, id],
      )
      return Boolean(row)
    },
    counts() {
      return {
        videos: count('SELECT COUNT(*) AS c FROM ext_video_videos'),
        tervek: count('SELECT COUNT(*) AS c FROM ext_video_tervek'),
        renderek: count('SELECT COUNT(*) AS c FROM ext_video_renderek'),
        qaOk: count("SELECT COUNT(*) AS c FROM ext_video_videos WHERE status = 'qa_ok'"),
        nyitottJavaslatok: count("SELECT COUNT(*) AS c FROM ext_video_javaslatok WHERE status = 'nyitott'"),
        fordulok: count('SELECT COUNT(*) AS c FROM ext_video_fordulok'),
      }
    },
  }
  return repo
}
