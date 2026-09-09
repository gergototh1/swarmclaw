import { AGENTS, SCHEDULES } from './src/agents.mjs'
import { SIGNALS_CONTRACT, createSignalsContract } from './src/contract.mjs'
import { MIGRATIONS, createRepo } from './src/db.mjs'
import { MAILBOX_CONTRACT, MAILBOX_PROVIDER, MAILBOX_VERSION } from './src/mailbox.mjs'
import { createResearchTool } from './src/research.mjs'
import { createMcpBridge } from './src/mcp-bridge.mjs'
import { createRpc } from './src/rpc.mjs'
import { DEFAULT_MAX, createSweepTools } from './src/sweep.mjs'

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
 * precisely because it is not one of setup()'s: it is the seam sweep.mjs
 * reaches its mailbox through, so a test can inject a double and drive the
 * whole layer with no credential anywhere near it. What that double stands in
 * for is the `mailbox` CONTRACT HANDLE, not a Gmail client -- this extension no
 * longer has one. Production leaves it null and the handle comes from
 * `contracts` below. Leaving it off the object made the seam invisible to
 * anyone reading this file, where every other key on the shared state is
 * declared.
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
  contracts: null,
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
    // Stored, never resolved here. `ctx.contracts.get` called from inside
    // `setup()` resolves against a half-built extension map -- `setup()` runs
    // during the host's `load()` -- so a provider later in the directory
    // listing would read as missing at this moment and correctly at every
    // other. The seam is captured; the lookup happens per call, in
    // `mailboxFor`.
    state.contracts = ctx.contracts
    state.repo = createRepo(ctx.storage)
  },
  tools: [...createSweepTools(state), createResearchTool(state)],
  /**
   * The one thing this extension asks another for: the mailbox behind the
   * newsletter label.
   *
   * The `reason` is the sentence an operator reads on this extension's card
   * before leaving the grant in place, so it says what is taken and what
   * happens to it rather than naming a method list. It is plain ASCII on
   * purpose: the host caps this field at 200 characters and the card renders it
   * as text.
   *
   * The version is pinned. A `gmail` extension serving a different one is
   * refused by the host with `version_mismatch` and no handle at all, which is
   * what this extension wants: a mailbox read under a contract this code was
   * not written against is exactly the silent wrong answer the whole frontier
   * design exists to avoid.
   */
  consumes: [
    {
      extension: MAILBOX_PROVIDER,
      contract: MAILBOX_CONTRACT,
      version: MAILBOX_VERSION,
      reason: 'A hirlevel-cimke uzeneteit listazza es olvassa be; a levelek szoveget sajat kartyakent tarolja.',
    },
  ],
  /**
   * What this extension's own page may call, over
   * `POST /api/extensions/aisignal/call/<method>`.
   *
   * There is no credential dependency to inject any more. The page's Gmail line
   * used to be "is a Google credential stored under this extension's purpose?",
   * which this extension can no longer answer and has no business answering:
   * the credential is the `gmail` extension's, and its own page is where an
   * operator connects it. What rpc.mjs reports instead is whether the contract
   * resolves, which is a question about this install's wiring and one this
   * extension really can answer -- see `mailboxHealth` there.
   */
  rpc: { ...createRpc(state), ...createMcpBridge(() => aisignal.tools) },
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
      // Legacy. The rail mounts no anchors any more -- it places a page by
      // `section` (one of NAV_SECTION_IDS) and orders it by `order`, and every
      // old `position` value resolves to Work (src/lib/extension-page-nav.ts).
      position: 'after:tasks',
    }],
    settingsFields: [
      { key: 'label', label: 'Gmail címke', type: 'text', placeholder: 'AI hírlevél' },
      // `defaultValue` is what a never-configured install gets: the host writes
      // it into the stored settings when the key is undefined. It does not
      // replace `DEFAULT_MAX` in sweep.mjs -- a field the operator clears stores
      // '' rather than undefined, so the host default never fires again and the
      // sweep layer is the only thing that can turn a blank setting back into a
      // working run. Both are that one constant now, rather than two literals
      // that agreed by comment.
      { key: 'maxMessages', label: 'Levél / futás', type: 'number', placeholder: String(DEFAULT_MAX), defaultValue: DEFAULT_MAX },
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
