import { MIGRATIONS, createRepo } from './src/db.mjs'

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
 * this file reads either yet.
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
  rpc: {},
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
      // <workspace>/dist is ever served. This checkout ships no ui/ yet, so
      // an install carries no dist/ and the asset route answers 404 for both
      // files: the rail lists the page and the page never registers.
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
