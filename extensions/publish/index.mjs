import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createMcpBridge } from './src/mcp-bridge.mjs'

/**
 * Publikálás, ütemezés és naptár -- Task 1: the module's skeleton.
 *
 * This is the first of six tasks (doc/specs/2026-09-07-publikalas-design.md).
 * It builds the package, the entry, the database schema and the read side of
 * the `video.videos@1` contract -- nothing here sends anything to YouTube,
 * Facebook, Instagram or TikTok yet. The four adapters (spec 6), the
 * write/rpc/tool surface a page and an agent would call (spec 10's
 * `src/service.mjs`, `src/rpc.mjs`, `src/agents.mjs`), and the calendar page
 * itself are later tasks' work. `tools` is deliberately empty and `rpc` is
 * deliberately only the MCP bridge -- there is nothing yet for either surface
 * to call.
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
}

export default publish
