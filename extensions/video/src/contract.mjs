import { VIDEO_STATUSOK } from './db.mjs'
import { SZABALYKESZLET } from './qa.mjs'

/**
 * The one thing another extension may ask the video module for: its videos.
 *
 * This is the `provides` side of the host-mediated seam
 * (src/lib/server/extensions/extension-contracts.ts). Extension storage is
 * otherwise isolated per extension, and a consumer reaches these two methods
 * only after naming this extension, this contract and this version in its own
 * `consumes`, with a sentence the operator reads before granting it.
 *
 * WHY THESE TWO METHODS. A consumer of a video module wants the finished
 * videos and one of them again by id -- a publisher picking up a `qa_ok` file
 * needs the path, the fingerprint, the title and something to write in a
 * description. That is `list` and `get`, and nothing else is declared.
 *
 * The page's rpc has thirteen methods and none of them is here. Seven of
 * them write (`feedback`, `lezar`, `cancelRender`, `decideProposal`,
 * `retireLesson`, the two imports), and a write reached through a contract
 * whose summary says "read" is the mismatch the host cannot catch for an
 * operator: it mediates access, not meaning. `board`, `video`, `proposals`
 * and `templates` are the shape of one page load, not a data model; a
 * consumer given `board` is coupled to this module's UI and breaks when the
 * page changes. `health` reports on the operator's machine -- a Remotion
 * directory, binaries on the PATH -- which is not a fact about videos.
 *
 * WHY THE FIXED COLUMN LIST, AND WHAT IT IS NOT.
 * `VIDEO_CONTRACT_COLUMNS` is an allowlist, and the projection is narrowed
 * through it as its last act. The reason is not that a row is dangerous to
 * copy; it is that the alternative -- an object literal that happens to name
 * eleven fields today -- grows the moment somebody adds a twelfth for a
 * reason that has nothing to do with this boundary. With the allowlist, a
 * field added below and not added to the list does not cross, and the test
 * file fails rather than a consumer quietly gaining a column.
 *
 * The allowlist narrows *which* fields arrive. It does not clean the ones
 * that do, and nothing here pretends to: `cim` is what an agent wrote from
 * text a stranger wrote, and `narracio_szoveg` is the narration an agent
 * composed from the same material. The `summary` below says so in the
 * sentence the operator reads on the extension card, and it is the consumer
 * -- the layer that knows whether the text is going into a DOM node, a model
 * prompt or an outbound post -- that has to guard it there. The host does not
 * clean data crossing this boundary and does not claim to: `callContractMethod`
 * returns the provider's value as it is, with no clone, no freeze and no
 * inspection.
 *
 * DELIBERATELY OUTSIDE THE PROJECTION.
 *   - `forras_szoveg`. The whole raw card or note a video was opened from,
 *     stored unmodified on purpose (spec 9.1). A consumer that wants a
 *     signal's text should ask `aisignal.signals` for it, where it arrives
 *     with that contract's own warning attached; handing it out a second time
 *     through a video would launder its origin.
 *   - The scene list and the plan. A consumer holding scene types and props
 *     is coupled to the Remotion kit behind this module's back, which is the
 *     one boundary the module exists to hold (spec 1).
 *   - Verdicts, findings and QA measurements. The module's own judgement of
 *     its own work, and the daily review's raw material. A number a consumer
 *     could rank on would fossilise a rule set that is meant to change.
 *   - Feedback and retention rows. The operator's, and identifiable to
 *     whoever left them.
 *
 * WHAT THIS SIDE CANNOT DO, AND MUST NOT PRETEND TO. Nothing arrives here
 * saying who is calling. The handle the host mints is frozen and carries the
 * consumer id it was minted for, and that id is never re-checked against
 * whoever actually calls, so an extension that passes its handle on delegates
 * its grant with it. The audience of these two methods is therefore not the
 * consumer named on the operator's card but whoever that consumer hands the
 * handle -- or the returned rows -- to. A method that answered differently
 * "for the publisher module" would be trusting a name it cannot verify. The
 * only way to narrow what a consumer can reach is to declare less, and these
 * two reads, cut to eleven columns, are the whole of the limit.
 *
 * A method or a column may be added here later, with a version bump, and that
 * will be a decision somebody makes deliberately. What must not happen is
 * this contract growing because the page grew, which is why this file builds
 * its own projection over the repository instead of re-exporting a slice of
 * `rpc.mjs` -- the two share no builder and this file imports nothing from
 * that one.
 */

/** The contract name, as a consumer spells it in `consumes` and in `ctx.contracts.get`. */
export const VIDEOS_CONTRACT = 'videos'

/**
 * The contract version. A consumer pinning a different number gets
 * `version_mismatch` and no handle; bump this whenever a method or a column
 * is removed, renamed, or changed in a way an existing consumer would read
 * wrongly.
 */
export const VIDEOS_CONTRACT_VERSION = 1

/** The fixed projection (spec 9.2). Not in it, on purpose: forras_szoveg, the scene list, verdicts, QA measurements. */
export const VIDEO_CONTRACT_COLUMNS = Object.freeze(['id', 'cim', 'status', 'forras_tipus', 'forras_id', 'out_path', 'file_sha256', 'hossz_ms', 'narracio_szoveg', 'created_at', 'qa_ok_at'])

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Keeps only the allowlisted keys. The last step of every projection, so a field added above and not to the list does not cross. */
function narrow(row) {
  const out = {}
  for (const col of VIDEO_CONTRACT_COLUMNS) out[col] = row[col] ?? null
  return out
}

/**
 * One video as the contract shows it, built from the repository's rows and
 * then narrowed. A fresh object every call over freshly read rows, so a
 * consumer that mutates what it got -- and it may, the host freezes nothing
 * on the way out -- reaches no state this module keeps.
 *
 * `out_path`, `file_sha256` and `hossz_ms` describe the video's newest
 * FINISHED render, and are null together when there is none. `hossz_ms` is
 * the QA gate's measured duration of exactly that file, so a video whose
 * render finished but whose QA has not run reports a path and no length --
 * which is the truth, and better than a length copied from the plan's
 * estimate. `qa_ok_at` is set only by a QA row that passed; a failed or
 * unmeasured render leaves it null.
 *
 * `narracio_szoveg` joins the latest plan's sentences in scene order, so a
 * publisher has something to write a description from. Only string sentences
 * are joined: a malformed row contributes nothing rather than the word
 * "undefined".
 */
export function projectVideo(repo, row) {
  const terv = repo.latestTerv(row.id)
  const render = repo.rendersForVideo(row.id).find((r) => r.status === 'kesz') || null
  const qa = render && render.file_sha256 ? repo.qaFor(render.id, render.file_sha256, SZABALYKESZLET) : null
  const narracio = terv
    ? JSON.parse(terv.narracio).slice().sort((a, b) => a.jelenet - b.jelenet).map((n) => n.szoveg).filter((sz) => typeof sz === 'string').join(' ')
    : ''
  let hosszMs = null
  if (qa) {
    const meresek = JSON.parse(qa.meresek)
    if (typeof meresek.duration_s === 'number') hosszMs = Math.round(meresek.duration_s * 1000)
  }
  return narrow({
    id: row.id,
    cim: row.cim,
    status: row.status,
    forras_tipus: row.forras_tipus,
    forras_id: row.forras_id,
    out_path: render ? render.out_path : null,
    file_sha256: render ? render.file_sha256 : null,
    hossz_ms: hosszMs,
    narracio_szoveg: narracio,
    created_at: row.created_at,
    qa_ok_at: qa && qa.ok === 1 ? qa.checked_at : null,
  })
}

/**
 * A whole number between 1 and MAX_LIMIT, or the default when the consumer
 * named none. Absent, null and '' mean no opinion; anything present that
 * cannot be honoured is refused by name rather than widened or clamped -- a
 * `limit: 500` answered with 200 rows is a caller that cannot tell it was
 * cut. The message never repeats the value it refused (args.mjs).
 */
function readLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT
  const n = Number(raw)
  if ((typeof raw !== 'number' && typeof raw !== 'string') || !Number.isSafeInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new Error(`limit must be a whole number between 1 and ${MAX_LIMIT}`)
  }
  return n
}

/**
 * Builds the `provides.videos` declaration index.mjs hands the host.
 *
 * Built at module scope, before `setup()` has run, so it cannot capture a
 * repository; the methods reach `state` on every call, the way the tools and
 * the rpc handlers do.
 *
 * Both methods are `async` even though the repository is synchronous: the
 * handle the host mints returns a promise whatever they do, so a caller
 * always awaits, and a refusal arrives as a rejection on both.
 */
export function createVideosContract(state) {
  return {
    version: VIDEOS_CONTRACT_VERSION,
    summary: 'Kész és készülő videók: lista és egy videó id szerint. A cím, a narráció és a forrás szövege ügynök és idegen szöveg; kimenő csatorna elé csak ellenőrizve.',
    methods: {
      /**
       * A page of videos: `{ total, count, items }`, all of them or one
       * status, newest first, cut to `limit`. `total` is the size of the
       * whole match, so a capped page is never mistaken for the end of the
       * list. A `status` outside the module's vocabulary is refused, not
       * answered with every video in the table.
       */
      list: async (args = {}) => {
        const status = args.status === undefined || args.status === null || args.status === '' ? null : args.status
        if (status !== null && !VIDEO_STATUSOK.includes(status)) throw new Error(`status must be one of ${VIDEO_STATUSOK.join(', ')}`)
        const limit = readLimit(args.limit)
        const rows = status === null ? state.repo.videos() : state.repo.videosByStatus(status)
        const items = rows.slice(0, limit).map((r) => projectVideo(state.repo, r))
        return { total: rows.length, count: items.length, items }
      },
      /**
       * One video by `id`, or `null` when nothing carries that id --
       * including the case a consumer will actually hit, an id it read a
       * moment ago whose row is gone by the time it asks again.
       */
      get: async (args = {}) => {
        if (typeof args.id !== 'string' || args.id === '') throw new Error('id must be a non-empty string')
        const row = state.repo.video(args.id)
        return row ? projectVideo(state.repo, row) : null
      },
    },
  }
}
