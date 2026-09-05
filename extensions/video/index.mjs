import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createAfterChatTurn, createTanulsagTools } from './src/tanulsag.mjs'

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
 * The seven seams after `repo` are the keys the host never fills, listed here
 * so a reader of this file sees every key the shared state can carry:
 *
 *   spawnImpl, execFileImpl, killImpl  -- render.mjs's child process, ffprobe
 *                                         and signal calls; default to
 *                                         node:child_process and process.kill
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
  spawnImpl: null,
  execFileImpl: null,
  killImpl: null,
  probeImpl: null,
  platform: null,
  bootAt: null,
  now: null,
}

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
    state.repo = createRepo(ctx.storage)
  },
  // The three tools of the daily review (material, close, propose). The
  // catalogue, plan, narration and render tools, the rpc map and the two
  // managed agents arrive in other tasks; an empty rpc declaration is what
  // the host accepts for an extension that has none yet.
  tools: [...createTanulsagTools(state)],
  rpc: {},
  // The turn recorder for the daily review (spec 6.5). The host spreads this
  // object into the extension's hook set, so the key is the host's hook name.
  hooks: { afterChatTurn: createAfterChatTurn(state) },
  /**
   * The two contracts this module reads through `ctx.contracts`. Each `reason`
   * is the sentence the operator reads on the extension card before granting
   * access. A provider that is not installed is not a load failure: the host
   * answers a missing one at call time, and the tool that asked names it
   * (`szerzodes_hianyzik`).
   */
  consumes: [
    { extension: 'aisignal', contract: 'signals', version: 1, reason: 'A mentett kártyákból választ videó-nyersanyagot; a kártya szövegét a videó forrásaként tárolja.' },
    { extension: 'tts', contract: 'narration', version: 1, reason: 'Jelenetenkénti narrációt kér a tervhez, és a kész mp3 útját és hosszát tárolja.' },
  ],
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
  managedResources: { agents: [], schedules: [] },
}

export default video
