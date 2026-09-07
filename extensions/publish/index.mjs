import { ALAP_IDOZONA, MIGRATIONS, createRepo } from './src/db.mjs'
import { createMcpBridge } from './src/mcp-bridge.mjs'

/**
 * Publikálás, ütemezés és naptár -- Task 1 (the module's skeleton) plus
 * Task 3 (the clock).
 *
 * This is the first and third of six tasks
 * (doc/specs/2026-09-07-publikalas-design.md). Task 1 built the package, the
 * entry, the database schema and the read side of the `video.videos@1`
 * contract. Task 3 adds `SCHEDULES` below -- the one fixed-cadence run
 * design spec 7 asks for -- and nothing else here sends anything to
 * YouTube, Facebook, Instagram or TikTok yet. The four adapters (spec 6),
 * the write/rpc/tool surface an agent would call (spec 10's
 * `src/service.mjs`, `src/rpc.mjs`, `src/agents.mjs` -- including the
 * `publishDue` tool `SCHEDULES` below names), and the calendar page itself
 * are later tasks' work. `tools` is deliberately empty and `rpc` is
 * deliberately only the MCP bridge -- there is nothing yet for either
 * surface to call.
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
  repo: null,
}

/** 15 minutes, in milliseconds -- design spec 7's default cadence, and the module's own upper bound on how late a due release can go out. */
const ALAP_UTEMEZES_MS = 15 * 60 * 1000

/**
 * The one job the schedule below asks of the agent it wakes: call the tool
 * that sends what is due, and say what happened. Nothing else -- deciding
 * WHICH releases are due is `esedekes()`'s job (src/utemezes.mjs), and
 * DECIDING is not this prompt's to do again in prose.
 *
 * `publishDue` is Task 4's tool (task-4-brief.md's own interface list),
 * named here ahead of its own arrival for the same reason `taskPrompt` names
 * concrete tools everywhere else in this codebase (extensions/video/src/agents.mjs's
 * own docblock: a prompt that describes a tool wrongly produces a run that
 * calls a tool that does not exist). Naming it now, against the shared
 * brief, is the one way to keep the two tasks' independent work pointed at
 * the same word.
 */
const KIKULDES_PROMPT = 'Hívd meg a publishDue toolt argumentum nélkül. Az kiteszi mindazt, aminek eljött az ideje -- sávra állított és felülírt időpontú kiadást egyaránt -- és visszaadja, hány kiadás ment ki, ha bármelyik hibára futott, melyik és milyen kóddal, és külön azokat az ütemezett kiadásokat, amiknek nincs kiszámolt időpontjuk. Számolj be mindháromból: hány kiadás ment ki rendben; ha volt hiba, melyik kiadás melyik platformján; és ha van időpont nélküli ütemezett kiadás, sorold fel azokat is -- azok soha nem lesznek esedékesek, amíg valaki időpontot nem ad nekik.'

/**
 * The one fixed-cadence run design spec 7 asks for -- see `src/utemezes.mjs`'s
 * own docblock for the contradiction this resolves (a static declaration vs.
 * operator-edited slots) and the slip it buys (up to `ALAP_UTEMEZES_MS` late
 * on every due release, not only the manually overridden ones).
 *
 * `agentRef` NAMES AN AGENT THIS TASK DOES NOT DECLARE. `publish-kuldo` is
 * this schedule's own key for "whichever agent Task 4's `src/agents.mjs`
 * assigns to dispatch" -- Task 4 owns `publishDue` and the agent that calls
 * it (task-4-brief.md: "Create: extensions/publish/src/agents.mjs"), so
 * this task cannot declare that agent without guessing at Task 4's shape.
 * Until that agent exists, the host's own reconcile (`buildManagedSchedule`,
 * src/lib/server/extension-managed-resources.ts) resolves no agent id for
 * this key and skips creating the schedule with `missing_agent_ref` -- a
 * logged skip, not a crash, and not a schedule that runs with nobody to
 * wake. The two tasks stay independently testable because of that skip:
 * this one's tests do not need Task 4's agent to exist, and Task 4 landing
 * `agentKey: 'publish-kuldo'` in its own `AGENTS` is what turns the skip
 * into a live schedule on the next reconcile.
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
  description: 'A kész, QA-átment videókból kiadás YouTube-ra, Facebookra, Instagramra és TikTokra: szöveg, jóváhagyás, ütemezés, naptár. Ez a kiadás a modul váza -- még semmit nem tesz ki.',
  migrations: MIGRATIONS,
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = ctx.settings
    state.log = ctx.log
    state.contracts = ctx.contracts
    state.repo = createRepo(ctx.storage)
  },
  // Empty on purpose: no agent-facing capability exists yet. An empty array
  // is still declared, not omitted, so the import-time test -- and the host,
  // which reads `.tools.map(...)` unconditionally in several places -- see a
  // real array rather than `undefined`.
  tools: [],
  /**
   * Only the MCP shim's two methods (`src/mcp-bridge.mjs`, byte-identical to
   * every sibling module that fronts its tools over MCP --
   * `extensions/mcp-shim-parity.test.mjs` holds it that way). There is no
   * `src/rpc.mjs` yet: this task adds no page, so there is nothing a page
   * would call over `POST /api/extensions/publish.mjs/call/<method>` beyond
   * what the bridge already answers. `mcpTools()` truthfully reports an
   * empty tool list until a later task's tools land in `tools` above --
   * reflection, not a second table (see `src/mcp-bridge.mjs`'s own docblock
   * for why it is built this way rather than one rpc method per tool).
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
   * Task 3's own slice: the fixed-cadence dispatch run, and nothing else --
   * no `agents` here (see `SCHEDULES`'s own docblock for why), no
   * `projects`, no `setupChecks`.
   */
  managedResources: { schedules: SCHEDULES },
}

export default publish
