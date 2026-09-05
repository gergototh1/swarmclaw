import { AGENTS, SCHEDULES } from './src/agents.mjs'
import { VIDEOS_CONTRACT, createVideosContract } from './src/contract.mjs'
import { MIGRATIONS, createRepo } from './src/db.mjs'
import { setupChecks } from './src/health.mjs'
import { createCatalogTool } from './src/katalogus.mjs'
import { createNarrateTool } from './src/narracio.mjs'
import { createRenderOps, createRenderTools } from './src/render.mjs'
import { createRpc } from './src/rpc.mjs'
import { createAfterChatTurn, createTanulsagTools } from './src/tanulsag.mjs'
import { createTervTools } from './src/terv.mjs'

/**
 * Everything the host hands over in setup(), plus the seams a test injects.
 *
 * Tools and rpc handlers are declared at module scope and cannot close over a
 * ctx that only exists once setup() has run, so they read this instead. It is
 * repopulated on every load and every reload -- setup() runs again on any
 * write under data/extensions -- which is why nothing here is a timer, a
 * listener or a subscription (a reload would leak one per load) and nothing
 * here reads a file. Plain assignment is idempotent, so re-running setup() is
 * free.
 *
 * `resolveBinary` is the host's own, filled by setup() below.
 *
 * The seven seams after it are the keys the host never fills, listed here
 * so a reader of this file sees every key the shared state can carry:
 *
 *   spawnImpl, execFileImpl, killImpl  -- render.mjs's child process, ffprobe
 *                                         and signal calls, and health.mjs's
 *                                         version probe of ffmpeg, ffprobe and
 *                                         npx; default to node:child_process
 *                                         and process.kill
 *   probeImpl                          -- narracio.mjs's ffprobe of an mp3
 *   platform                           -- process.platform
 *   bootAt                             -- the host machine's boot time, by the
 *                                         os.uptime() rule in render.mjs
 *   now                                -- Date.now, for the watchdog's clock
 *
 * A test sets them so no render, no ffprobe and no signal happens on the
 * machine running the suite. They are null in production and every module
 * that reads one falls back to the real thing when it is null. `now` is the
 * watchdog's clock only: the repository stamps its rows from the wall clock
 * in db.mjs, and a test that needs a row to look old writes the timestamp it
 * needs rather than moving this seam.
 */
export const state = {
  storage: null,
  settings: () => ({}),
  log: console,
  contracts: null,
  repo: null,
  resolveBinary: null,
  spawnImpl: null,
  execFileImpl: null,
  killImpl: null,
  probeImpl: null,
  platform: null,
  bootAt: null,
  now: null,
}

/**
 * One instance at module scope, so that the rpc handlers arriving with the
 * page (`cancelRender`, `cleanup`, `health`) will call the same object the
 * two render tools call, and the page and the tools cannot drift apart in
 * what they mean by a cancel or a cleanup.
 *
 * `rpc` below now carries them: `cancelRender` calls `renderOps.cancel`,
 * `cleanup` calls `cleanupAll`, and `health` calls `orphanCount` and
 * `summary`. What still has no caller is the browser bundle -- `ui.pages`
 * points at a `dist/` that does not exist yet, so nothing in the product
 * calls these thirteen methods until the page task lands. They are reachable
 * over the rpc route today; they are not yet used.
 *
 * Sharing it is not what makes the render survive a reload. Every operation
 * here starts from the render row and writes through the same host storage, so
 * a second instance over this same `state` would answer identically; what a
 * reload would lose is the child process's `exit` handler, which belongs to
 * whichever instance called `start`. That handler closes through the row too,
 * which is why losing it costs nothing a `videoRenderStatus` call cannot
 * recover (render.mjs, `finalize`).
 */
export const renderOps = createRenderOps(state)

const video = {
  name: 'Videó',
  version: '0.1.0',
  description: 'Vezérlőréteg a Remotion-kit fölött: jelenetlista az ügynöktől, lektor a render előtt, mechanikus QA-kapu, napi javaslat.',
  migrations: MIGRATIONS,
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = ctx.settings
    state.log = ctx.log
    state.contracts = ctx.contracts
    // Where ffmpeg, ffprobe and npx actually live on this machine, which the
    // bare PATH of a packaged desktop app does not answer (src/binaries.mjs).
    // A host without the surface leaves this null and every call falls back
    // to the bare name, which is what the module did before.
    state.resolveBinary = typeof ctx.resolveBinary === 'function' ? ctx.resolveBinary : null
    state.repo = createRepo(ctx.storage)
  },
  // The catalogue read, the six tools of a plan's life before narration
  // (open, draft, verdict, lessons, queue, plan), the narration over the tts
  // contract, the render and its watchdog, and the three of the daily
  // review (material, close, propose).
  tools: [createCatalogTool(state), ...createTervTools(state), createNarrateTool(state), ...createRenderTools(state, renderOps), ...createTanulsagTools(state)],
  /**
   * The page's methods (src/rpc.mjs), built over the same `renderOps` the
   * render tools use. Declared at module scope like the tools, so they read
   * `state` on every call rather than closing over a ctx.
   *
   * Adding a method here adds nothing to the `videos` contract below: the two
   * are separate files with separate projections and neither imports the
   * other (src/contract.mjs says why at length).
   */
  rpc: createRpc(state, renderOps),
  // The turn recorder for the daily review (spec 6.5). The host spreads this
  // object into the extension's hook set, so the key is the host's hook name.
  hooks: { afterChatTurn: createAfterChatTurn(state) },
  /**
   * The two contracts this module reads through `ctx.contracts`.
   *
   * WHAT `reason` IS, AND WHAT IT IS NOT. It is a sentence written here for
   * whoever reads this declaration -- the operator on the extension card, and
   * the next person to edit this file -- saying why this module asks for the
   * other one. It is NOT a request that anybody approves. The host's check is
   * `resolveExtensionContract`
   * (src/lib/server/extensions/extension-contracts.ts): it looks for an entry
   * in this array naming that extension and that contract, and if there is
   * one, the call goes through. Nothing reads `reason`, nothing records a
   * decision about it, and there is no grant, approve or revoke anywhere in
   * the host. Declaring the consumption IS the access.
   *
   * So the only way to take this module's reach away is to remove the entry
   * from this array -- editing the consumer's own source -- or to disable or
   * uninstall the provider, which takes it away from every consumer at once.
   * An operator who wants one consumer stopped and the others left alone has
   * no button for it. Write these two entries as narrowly as they read.
   *
   * A provider that is not installed is not a load failure: the host answers a
   * missing one at call time, and the tool that asked names it
   * (`szerzodes_hianyzik`).
   */
  consumes: [
    { extension: 'aisignal', contract: 'signals', version: 1, reason: 'A mentett kártyákból választ videó-nyersanyagot; a kártya szövegét a videó forrásaként tárolja.' },
    { extension: 'tts', contract: 'narration', version: 1, reason: 'Jelenetenkénti narrációt kér a tervhez, és a kész mp3 útját és hosszát tárolja.' },
  ],
  /**
   * What another extension may read: `videos`, two reads over a fixed column
   * projection. The declaration and every word of the reasoning are in
   * src/contract.mjs. Nothing consumes it today; the mechanism's real test is
   * whether two providers and two consumers run together (spec 9.2).
   */
  provides: { [VIDEOS_CONTRACT]: createVideosContract(state) },
  ui: {
    pages: [{
      id: 'video',
      label: 'Videó',
      // One of EXTENSION_PAGE_ICON_NAMES (src/lib/extension-page-nav.ts);
      // anything outside that list silently renders the puzzle-piece fallback.
      // There is no clapperboard in the list, so the scene-list module wears
      // the layers icon.
      icon: 'Layers',
      path: '/x/video',
      // Workspace-relative and required to start with dist/: only
      // <workspace>/dist is ever served. The bundle arrives with the page task.
      entry: 'dist/index.js',
      css: 'dist/style.css',
      // 'tasks' is the one anchor the rail actually mounts a slot for.
      position: 'after:tasks',
    }],
    settingsFields: [
      { key: 'remotionDir', label: 'Remotion-projekt könyvtára', type: 'text', required: true, placeholder: '/Users/…/ai-use-cases/videos/_remotion', help: 'Benne package.json, src/index.ts, src/FosVideo.tsx és src/kit/katalogus.generated.json.' },
      // `defaultValue` is what a never-configured install gets. It does not
      // replace the fallback in the module that reads the setting: a field the
      // operator clears stores '' rather than undefined, so the host default
      // never fires again and the reader is the only thing that can turn a
      // blank setting back into a working value.
      { key: 'napiSapka', label: 'Új videó / nap', type: 'number', placeholder: '1', defaultValue: 1 },
      { key: 'renderMaxPerc', label: 'Render időkorlát (perc)', type: 'number', placeholder: '40', defaultValue: 40, help: 'Becslés, nem mérés: az első tíz éles render ideje a lapon látszik, ehhez igazítsd.' },
      { key: 'megtartottRenderek', label: 'Megtartott renderek / videó', type: 'number', placeholder: '3', defaultValue: 3 },
      { key: 'linuxRenderEngedely', label: 'Render nem-Mac hoston is', type: 'boolean', defaultValue: false, help: 'A tipográfia macOS rendszerbetű; Linuxon minden videó másképp néz ki, és a QA ezt nem méri.' },
      { key: 'forduloRogzites', label: 'Fordulók rögzítése', type: 'select', defaultValue: 'sajat', options: [{ value: 'sajat', label: 'csak a modul két ügynöke' }, { value: 'mind', label: 'minden csatolt ügynök (60 napig)' }] },
    ],
  },
  /**
   * The two agents and their three schedules (src/agents.mjs). Nothing here
   * exists on the operator's instance until they press Reconcile once on
   * the Extensions list -- the Reconcile button on this extension's own card,
   * or `swarmclaw extensions reconcile --extension-id video.mjs`. No host path
   * runs a reconcile on install, enable or upgrade.
   *
   * `setupChecks` is the install's conditions by name, from the same list
   * `health` answers (src/health.mjs). The host counts them for the card and
   * carries them in the managed-resources payload; it runs none of them, so
   * the answering is entirely the page's `health` call.
   */
  managedResources: { agents: AGENTS, schedules: SCHEDULES, setupChecks: setupChecks() },
}

export default video
