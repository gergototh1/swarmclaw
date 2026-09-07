import { AGENTS } from './src/agents.mjs'
import { ALAP_IDOZONA, MIGRATIONS, createRepo } from './src/db.mjs'
import { createMcpBridge } from './src/mcp-bridge.mjs'
import { createYoutubeAdapter } from './src/platform/youtube.mjs'
import { createSzovegTools } from './src/szoveg.mjs'

/**
 * Publikálás, ütemezés és naptár -- Task 1 (the module's skeleton), Task 3
 * (the clock) and Task 4 (the writer, the reviewer and the sender).
 *
 * This is the first, third, fourth and fifth of six tasks
 * (doc/specs/2026-09-07-publikalas-design.md). Task 1 built the package, the
 * entry, the database schema and the read side of the `video.videos@1`
 * contract. Task 3 added `SCHEDULES` below -- the one fixed-cadence run
 * design spec 7 asks for. Task 4 adds `AGENTS` (src/agents.mjs) and the five
 * tools (src/szoveg.mjs: `publishOpen`, `publishQueue`, `publishDraft`,
 * `publishVerdict`, `publishDue`) -- the whole `vazlat -> lektoralt ->
 * jovahagyva -> utemezve -> kesz|reszben|hiba|nincs_hova` chain design spec
 * 4 draws, except the operator's own approval click, which stays a later
 * task's rpc surface (src/szoveg.mjs's own docblock says why). Task 5 sends
 * to ONE of the four platforms: `state.adapterek.youtube`
 * (src/platform/youtube.mjs's `createYoutubeAdapter`), riding the host's
 * Google OAuth (`state.oauth`, the same seam `extensions/gmail/index.mjs`
 * uses) under the `publish` purpose
 * (`src/app/api/oauth/google/start/route.ts`'s Task 5 entry). Facebook,
 * Instagram and TikTok have no adapter yet -- design spec 6's other three --
 * and the calendar page (spec 8) is Task 6's work; `publishDue` still
 * dispatches every platform through `state.adapterek`, so registering the
 * next adapter is the whole cost of a later task's send path.
 *
 * Everything the host hands over in `setup()`, plus the test's own seam.
 *
 * Repopulated on every load and every reload -- `setup()` runs again on any
 * write under data/extensions -- which is why nothing here is a timer, a
 * listener or a subscription: a reload would leak one per load. Plain
 * assignment is idempotent, so re-running `setup()` is free.
 */
export const state = {
  storage: null,
  settings: () => ({}),
  log: console,
  contracts: null,
  /** The host's Google OAuth seam (`getGoogleAccessToken`, `hasGoogleCredential`), the same shape `extensions/gmail/index.mjs` stores -- Task 5's `createYoutubeAdapter` below reads it at CALL time, well after `setup()` has filled it in. */
  oauth: null,
  repo: null,
  /**
   * Platform -> `async ({ ag, kiadas, fiok, video }) => { url }` sender.
   * Task 5 registers `youtube` below, built once at module load from THIS
   * `state` object (not a snapshot of it) so `createYoutubeAdapter`'s closure
   * keeps seeing `state.oauth` as `setup()` fills and refills it. Facebook,
   * Instagram and TikTok (design spec 6) have no adapter yet: `publishDue`
   * (src/szoveg.mjs) treats a connected account with no registered adapter
   * as a named `hiba`, never a silent no-op.
   */
  adapterek: {},
}

/**
 * Registered once, at import time, on the module-scope `state` above -- not
 * inside `setup()`, because `setup()` only ever assigns the SAME `state`
 * object's fields, and `createYoutubeAdapter(state)` needs to close over
 * that object exactly once. Re-registering on every `setup()` re-run (a
 * write under data/extensions triggers one) would replace a working closure
 * with an identical one for no reason -- harmless here, but a needless
 * departure from "plain assignment is idempotent" above.
 */
state.adapterek.youtube = createYoutubeAdapter(state)

/** 15 minutes, in milliseconds -- design spec 7's default cadence, and the module's own upper bound on how late a due release can go out. */
const ALAP_UTEMEZES_MS = 15 * 60 * 1000

/**
 * The one job the schedule below asks of the agent it wakes: call the tool
 * that sends what is due, and say what happened. Nothing else -- deciding
 * WHICH releases are due is `esedekes()`'s job (src/utemezes.mjs), and
 * DECIDING is not this prompt's to do again in prose.
 *
 * `publishDue` is Task 4's tool (src/szoveg.mjs), named here from before its
 * own arrival for the same reason `taskPrompt` names concrete tools
 * everywhere else in this codebase (extensions/video/src/agents.mjs's own
 * docblock: a prompt that describes a tool wrongly produces a run that
 * calls a tool that does not exist) -- and it landed under the same name,
 * so this prompt did not need to change once Task 4's tools existed.
 */
const KIKULDES_PROMPT = 'Hívd meg a publishDue toolt argumentum nélkül. Az kiteszi mindazt, aminek eljött az ideje -- sávra állított és felülírt időpontú kiadást egyaránt -- és visszaadja, hány kiadás ment ki, ha bármelyik hibára futott, melyik és milyen kóddal, és külön azokat az ütemezett kiadásokat, amiknek nincs kiszámolt időpontjuk. Számolj be mindháromból: hány kiadás ment ki rendben; ha volt hiba, melyik kiadás melyik platformján; és ha van időpont nélküli ütemezett kiadás, sorold fel azokat is -- azok soha nem lesznek esedékesek, amíg valaki időpontot nem ad nekik.'

/**
 * The one fixed-cadence run design spec 7 asks for -- see `src/utemezes.mjs`'s
 * own docblock for the contradiction this resolves (a static declaration vs.
 * operator-edited slots) and the slip it buys (up to `ALAP_UTEMEZES_MS` late
 * on every due release, not only the manually overridden ones).
 *
 * `agentRef` NAMES `publish-kuldo` -- Task 4's `src/agents.mjs` now declares
 * exactly that `agentKey` (its own docblock calls this the KÖTÖTT NÉV and
 * `test/agents.test.mjs` pins the two spellings against each other), so this
 * schedule is live from Task 4 onward. Before Task 4 landed, the host's own
 * reconcile (`buildManagedSchedule`, src/lib/server/extension-managed-resources.ts)
 * resolved no agent id for this key and skipped creating the schedule with
 * `missing_agent_ref` -- a logged skip, not a crash, and not a schedule that
 * ran with nobody to wake. That graceful-skip behaviour is what let the two
 * tasks stay independently testable while only one of them existed.
 */
export const SCHEDULES = Object.freeze([
  Object.freeze({
    scheduleKey: 'publish-kikuldes',
    displayName: 'Publikálás: kiküldés (15 percenként)',
    description: 'Kiteszi mindazt, aminek eljött az ideje -- sávra állított és felülírt időpontú kiadást egyaránt.',
    taskPrompt: KIKULDES_PROMPT,
    taskMode: 'task',
    agentRef: Object.freeze({ resourceKind: 'agent', resourceKey: 'publish-kuldo' }),
    scheduleType: 'interval',
    intervalMs: ALAP_UTEMEZES_MS,
    // Inert TODAY -- the host's `scheduleTiming` (src/lib/server/extension-managed-resources.ts)
    // carries `timezone` onto an interval schedule but nothing reads it back
    // for a fixed cadence, which is a cadence and not a wall-clock time. It is
    // declared anyway, and it is the same zone as `ALAP_IDOZONA`: this is the
    // ONE place the operator's publishing zone is written down where the host
    // can see it, next to the run that does the dispatching. The sibling
    // module states it on all three of its declarations for the same reason
    // (extensions/video/src/agents.mjs). The day this schedule becomes a cron
    // -- "send at 07:00, not every 15 minutes" -- the zone is already right
    // rather than silently UTC.
    timezone: ALAP_IDOZONA,
    status: 'active',
  }),
])

const publish = {
  name: 'Publikálás',
  version: '0.1.0',
  description: 'A kész, QA-átment videókból kiadás YouTube-ra, Facebookra, Instagramra és TikTokra: szöveg, lektorálás, jóváhagyás, ütemezés, naptár. Ez a kiadás megírja és lektorálja a szöveget, és kiküldi, ami esedékes -- a négy platform-adapter és a naptár lapja még nem ebben a kiadásban jön.',
  migrations: MIGRATIONS,
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = ctx.settings
    state.log = ctx.log
    state.contracts = ctx.contracts
    state.oauth = ctx.oauth
    state.repo = createRepo(ctx.storage)
  },
  /**
   * Task 4's five tools (src/szoveg.mjs), in the order that module declares
   * them: `publishOpen`, `publishQueue`, `publishDraft`, `publishVerdict`,
   * `publishDue`. Built from `state` directly rather than from `ctx` --
   * `createSzovegTools` closes over `state`, which `setup()` above keeps
   * current, the same pattern `extensions/video/index.mjs` uses for its own
   * tool builders.
   */
  tools: createSzovegTools(state),
  /**
   * The MCP shim's two methods (`src/mcp-bridge.mjs`, byte-identical to
   * every sibling module that fronts its tools over MCP --
   * `extensions/mcp-shim-parity.test.mjs` holds it that way), reflecting
   * over `publish.tools` above -- so the five tools Task 4 added are reachable
   * over MCP with no further work here (see `src/mcp-bridge.mjs`'s own
   * docblock for why it is built this way rather than one rpc method per
   * tool). There is still no `src/rpc.mjs`: this task adds no page, so
   * there is nothing a page would call over
   * `POST /api/extensions/publish.mjs/call/<method>` beyond what the bridge
   * already answers.
   */
  rpc: { ...createMcpBridge(() => publish.tools) },
  /**
   * The one contract this module reads through `ctx.contracts` in Task 1.
   *
   * `reason` is not a request that gets approved -- see `extensions/video/index.mjs`'s
   * own comment on this same array for what the host's check actually does
   * and does not do. It is written here as narrowly as it reads: this module
   * asks for exactly the eleven columns `video.videos@1` projects (path,
   * fingerprint, length, title, narration text, per spec 2's second reason),
   * and for nothing else the video module holds.
   *
   * The receiver is `videosHandle` (src/video-szerzodes.mjs), modelled on
   * `extensions/docs/src/video-forgatokonyv.mjs`'s `videosHandle` per the
   * brief: four named reasons for a null handle, and a refusal that never
   * echoes a caller's value, only the host's own closed set of reason words.
   */
  consumes: [
    { extension: 'video', contract: 'videos', version: 1, reason: 'A kész, QA-átment videókból csinál kiadást: a fájl útját, az ujjlenyomatát, a hosszát és a narráció szövegét olvassa.' },
  ],
  /**
   * No `pages` yet (design spec 10 lists `ui/` as a later task's file) -- one
   * settings field, and it is the module's publishing zone.
   *
   * It is a FIELD and not a buried constant because a slot means a WALL CLOCK
   * (src/utemezes.mjs's file docblock): `{ nap: 1, ora: 9, perc: 0 }` is
   * "Monday 09:00" in the zone named here, all year, DST included. An
   * operator who never opens this page still gets `Europe/Budapest` --
   * `defaultValue` here, `ALAP_IDOZONA` in src/db.mjs, and the reader's own
   * fallback in `idozonaOf` (src/utemezes.mjs) for the case the field is
   * cleared to `''`, where the host's default never fires again.
   */
  ui: {
    settingsFields: [
      { key: 'idozona', label: 'Publikálási időzóna', type: 'text', defaultValue: ALAP_IDOZONA, placeholder: ALAP_IDOZONA,
        help: 'IANA-zónanév. A publikálási sávok "hétfő 9:00"-ja ennek a zónának a fali óráján értendő, nyári időszámítással együtt -- nem UTC-ben.' },
    ],
  },
  /**
   * The fixed-cadence dispatch run (Task 3) and the three managed agents
   * (Task 4, src/agents.mjs) it wakes one of. No `projects`, no
   * `setupChecks` -- neither task has been asked to add either.
   */
  managedResources: { schedules: SCHEDULES, agents: AGENTS },
}

export default publish
