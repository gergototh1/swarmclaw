import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { NARRATION_CONTRACT, createNarrationContract } from './src/contract.mjs'
import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createRpc } from './src/rpc.mjs'
import { createSynthesizer } from './src/synthesize.mjs'

/**
 * Everything the host hands over in setup(), plus the two seams a test injects.
 *
 * Repopulated on every load and every reload -- setup() is called again on any
 * write under data/extensions -- which is why nothing here is a timer, a
 * listener or a subscription: a reload would leak one per load. Plain
 * assignment is idempotent, so re-running setup() is free.
 *
 * `fetchImpl` and `execFileImpl` are the two keys the host never fills. They
 * are declared here, beside setup()'s own, so the seams are visible where every
 * other key on the shared state is: the synthesis layer will build its Soniox
 * request through `fetchImpl` and its duration probe through `execFileImpl`,
 * falling back to the global `fetch` and the module's own promisified
 * `execFile` when they are null. A test sets both to doubles, so no request
 * leaves the machine and no ffprobe is needed to run the suite. Nothing in
 * this file reads either; the synthesizer built below does.
 */
export const state = {
  storage: null,
  settings: () => ({}),
  log: console,
  contracts: null,
  repo: null,
  fetchImpl: null,
  execFileImpl: null,
}

/**
 * The workspace this file runs from. The MCP shim lives beside it under
 * `mcp/`, and the rpc's `mcpConfig` reports that path for the operator's
 * Settings > MCP Servers entry.
 */
const workspaceDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Where the host writes `run/port.json`, by the host's own rule in
 * `src/lib/server/data-dir.ts` (`resolveRunDir`), repeated here because an
 * extension may not import that file: when SWARMCLAW_HOME is set, `run/`
 * sits beside `data/` under that home, not inside it; otherwise it is `run/`
 * under DATA_DIR, which is the DATA_DIR variable when set and `<cwd>/data`
 * when not. The host's build-time branch is left out because the port file is
 * written only by a running server.
 *
 * Two copies of one rule, read from the same environment. Nothing here can
 * check that the host wrote where this says; the page shows the path so the
 * operator can, and the shim reports a missing file by name rather than
 * guessing a port.
 */
function resolvePortFile() {
  const home = process.env.SWARMCLAW_HOME?.trim()
  if (home) return path.join(path.resolve(home), 'run', 'port.json')
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dataDir, 'run', 'port.json')
}

/**
 * The one synthesizer both surfaces share. Built at module scope over
 * `state`, which setup() fills later: it closes over the object and reads
 * `state.repo`, `state.settings` and the two seams on every call, so a reload
 * that re-runs setup() is seen by the next call without rebuilding anything.
 */
const synth = createSynthesizer(state)

const tts = {
  name: 'Narráció (TTS)',
  version: '0.1.0',
  description: 'Soniox szöveg-hang: szerződés a kódnak, MCP-szerver az ügynököknek; cache és napi keret a hostban.',
  migrations: MIGRATIONS,
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = ctx.settings
    state.log = ctx.log
    state.contracts = ctx.contracts
    state.repo = createRepo(ctx.storage)
  },
  tools: [],
  /**
   * What this extension's own page and its MCP shim may call, over
   * `POST /api/extensions/tts/call/<method>`. See rpc.mjs for which methods
   * are in it and why `synthesize` answers a refusal as a value there.
   */
  rpc: createRpc(state, synth, { workspaceDir, portFile: resolvePortFile() }),
  /**
   * What *another* extension may call, once it has named this contract in its
   * own `consumes` and an operator has left it installed.
   *
   * Strictly smaller than `rpc` and separately declared, with its answers cut
   * to its own field lists: see contract.mjs for which methods are in it and
   * why the others are not.
   */
  provides: { [NARRATION_CONTRACT]: createNarrationContract(synth) },
  ui: {
    pages: [{
      id: 'tts',
      label: 'Narráció',
      // One of EXTENSION_PAGE_ICON_NAMES (src/lib/extension-page-nav.ts);
      // anything outside that list silently renders the puzzle-piece fallback.
      // There is no microphone in the list, so the speech bubble stands in.
      icon: 'MessageSquare',
      path: '/x/tts',
      // Workspace-relative and required to start with dist/: only
      // <workspace>/dist is ever served. scripts/build.mjs writes dist/ from
      // ui/ and scripts/install.mjs copies it into the workspace; an install
      // made without a build carries no dist/, the asset route answers 404 for
      // both files, and the rail lists a page that never registers.
      entry: 'dist/index.js',
      css: 'dist/style.css',
      position: 'end',
    }],
    settingsFields: [
      // The host blanks a secret before it reaches the page and rejects a
      // save that leaves a required field empty. Neither is this file's
      // doing; both are the host's.
      { key: 'apiKey', label: 'Soniox API-kulcs', type: 'secret', required: true },
      // No default URL on purpose. A wrong one that was typed here would turn a
      // good key's refusal into a transport failure, and the two must not look
      // the same. The field is required, and health will say when it is empty.
      { key: 'endpoint', label: 'TTS végpont (URL)', type: 'text', required: true, placeholder: 'https://…/v1/text-to-speech', help: 'A Soniox dokumentációjából, az EU-régió URL-je. A kód nem hordoz alapértelmezést, mert egy rossz URL rosszabb, mint egy üres.' },
      // `defaultValue` is what a never-configured install gets: the host writes
      // it into the stored settings when the key is undefined. A field the
      // operator clears stores '' rather than undefined, so the host default
      // never fires again; whatever reads these has to treat '' as its own case.
      { key: 'modell', label: 'Modell', type: 'text', placeholder: 'tts-rt-v1', defaultValue: 'tts-rt-v1' },
      { key: 'hang', label: 'Hang', type: 'text', placeholder: 'Kenji', defaultValue: 'Kenji' },
      { key: 'nyelv', label: 'Nyelv', type: 'text', placeholder: 'hu', defaultValue: 'hu' },
      { key: 'napiKeretMp', label: 'Napi keret (másodperc)', type: 'number', placeholder: '900', defaultValue: 900 },
    ],
  },
}

export default tts
