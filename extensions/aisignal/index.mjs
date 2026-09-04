import { AGENTS, SCHEDULES } from './src/agents.mjs'
import { SIGNALS_CONTRACT, createSignalsContract } from './src/contract.mjs'
import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createResearchTool } from './src/research.mjs'
import { createRpc } from './src/rpc.mjs'
import { createSweepTools } from './src/sweep.mjs'

/**
 * Everything the host hands over in setup(), in one place.
 *
 * Tools and rpc handlers are declared at module scope and cannot close over a
 * ctx that only exists once setup() has run, so they read this instead. It is
 * repopulated on every load and every reload -- setup() is called again on any
 * write under data/extensions -- which is why nothing here is a timer, a
 * listener or a subscription: a reload would leak one per load. Plain
 * assignment is idempotent, so re-running setup() is free.
 *
 * `gmailFactory` is the one key the host never fills, and it is listed here
 * precisely because it is not one of setup()'s: it is the seam sweep.mjs builds
 * its Gmail client through, so a test can inject a double and drive the whole
 * layer with no credential anywhere near it. Production leaves it null and the
 * client is built from the host's OAuth. Leaving it off the object made the
 * seam invisible to anyone reading this file, where every other key on the
 * shared state is declared.
 *
 * `fetchImpl`, `researchTimeoutMs` and `researchBudgetMs` are the same kind of
 * key for research.mjs, and are declared here for the same reason. `fetchImpl`
 * is what a test injects so no request leaves the machine; the two numbers are
 * the request deadline and the run's time budget, which a test shortens so it
 * can pin the timeout without waiting for one. All three are null in
 * production, where the global `fetch` and the module's own constants are used.
 */
export const state = {
  storage: null,
  settings: () => ({}),
  log: console,
  oauth: null,
  repo: null,
  gmailFactory: null,
  fetchImpl: null,
  researchTimeoutMs: null,
  researchBudgetMs: null,
}

const aisignal = {
  name: 'AI Signal',
  version: '0.1.0',
  description: 'AI-hírlevelek és nyílt webes források soronkénti signaljai: pakli a döntéshez, lista a visszakereséshez.',
  migrations: MIGRATIONS,
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = ctx.settings
    state.log = ctx.log
    state.oauth = ctx.oauth
    state.repo = createRepo(ctx.storage)
  },
  tools: [...createSweepTools(state), createResearchTool(state)],
  /**
   * What this extension's own page may call, over
   * `POST /api/extensions/aisignal/call/<method>`.
   *
   * `hasGoogleCredential` is passed as a closure over `state` rather than as
   * `state.oauth.hasGoogleCredential`: `state.oauth` is null until `setup()`
   * runs, and this map is built before it. Which purpose is asked about is
   * rpc.mjs's decision, not this file's -- it names `OAUTH_PURPOSE` from
   * sweep.mjs, so the page cannot report on a credential no sweep uses.
   */
  rpc: createRpc(state, { hasGoogleCredential: (purpose) => state.oauth.hasGoogleCredential(purpose) }),
  /**
   * What *another* extension may call, once it has named this contract in its
   * own `consumes` and an operator has left it installed.
   *
   * Strictly smaller than `rpc` and separately declared: see contract.mjs for
   * which methods are in it and why the others are not.
   */
  provides: { [SIGNALS_CONTRACT]: createSignalsContract(state) },
  ui: {
    pages: [{
      id: 'aisignal',
      label: 'AI Signal',
      // One of EXTENSION_PAGE_ICON_NAMES (src/lib/extension-page-nav.ts);
      // anything outside that list silently renders the puzzle-piece fallback.
      icon: 'Radar',
      path: '/x/aisignal',
      // Workspace-relative and required to start with dist/: only
      // <workspace>/dist is ever served.
      entry: 'dist/index.js',
      css: 'dist/style.css',
      // 'tasks' is the one anchor the rail actually mounts a slot for.
      position: 'after:tasks',
    }],
    settingsFields: [
      { key: 'label', label: 'Gmail címke', type: 'text', placeholder: 'AI hírlevél' },
      // `defaultValue` is what a never-configured install gets: the host writes
      // it into the stored settings when the key is undefined. It does not
      // replace `DEFAULT_MAX` in sweep.mjs -- a field the operator clears stores
      // '' rather than undefined, so the host default never fires again and the
      // sweep layer is the only thing that can turn a blank setting back into a
      // working run. The two numbers are the same on purpose.
      { key: 'maxMessages', label: 'Levél / futás', type: 'number', placeholder: '5', defaultValue: 5 },
    ],
  },
  /**
   * The two agents and the two schedules the host creates and keeps in step
   * with this declaration -- see src/agents.mjs for the prompts and for what
   * the host does with a run that fails or one that overruns its slot.
   *
   * The declarations are frozen there and handed over by reference. The host
   * only reads them (`buildManagedAgent` and `buildManagedSchedule` copy
   * fields out; `declarationHash` walks them), so a shared reference is safe,
   * and freezing is what keeps a later reader from treating this object as
   * somewhere to stash per-install state: `setup()` runs again on every reload
   * and would not undo a mutation made here.
   */
  managedResources: { agents: AGENTS, schedules: SCHEDULES },
}

export default aisignal
