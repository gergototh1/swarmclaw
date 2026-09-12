import { createAgentContext } from './src/agent-context.mjs'
import { DOCS_CONTRACT, createDocsContract } from './src/contract.mjs'
import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createIndexWriter } from './src/index-writer.mjs'
import { LEGACY_SETTING_KEYS, LEGACY_SHARED_FOLDER } from './src/legacy-names.mjs'
import { createMcpBridge } from './src/mcp-bridge.mjs'
import { createRpc } from './src/rpc.mjs'
import { createService } from './src/service.mjs'
import { createTools } from './src/tools.mjs'
import { createVault } from './src/vault.mjs'
import { VIDEOS_CONTRACT_VERSION } from './src/video-script.mjs'
import { createWatcherControl } from './src/watcher.mjs'

/**
 * Everything the host hands over in setup(), plus what is derived from it.
 *
 * Tools, rpc handlers and contract methods are all built at module scope and
 * cannot close over a ctx that only exists once setup() has run, so they read
 * this instead. It is repopulated on every load and every reload -- setup()
 * runs again on any write under data/extensions -- which is why nothing here is
 * a timer, a listener or a subscription: a reload would leak one per load.
 * Plain assignment is idempotent, so re-running setup() costs nothing.
 *
 * The vault and the index writer are built lazily rather than in setup(),
 * because the root they are bound to comes from a setting the operator can
 * change without a restart. `vaultOf()` notices the change and rebuilds; when
 * the setting has not moved it hands back the same pair.
 */
export const state = {
  storage: null,
  settings: () => ({}),
  log: console,
  contracts: null,
  repo: null,
  _vault: null,
  _writer: null,
  _service: null,
  _root: null,
}

/** A setting under its English key, else under the key it was stored as before the rename. */
function setting(key) {
  const all = state.settings() ?? {}
  const fresh = all[key]
  if (fresh !== undefined && fresh !== null && fresh !== '') return fresh
  return all[LEGACY_SETTING_KEYS[key]]
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** The configured root, with the fallback a never-configured install gets. */
export function rootSetting() {
  return trimmed(setting('root')) || '~/SwarmClaw/docs'
}

/**
 * The shared folder's name, which the operator may rename.
 *
 * A stored "kozos" is ignored rather than honoured: it is the old default the
 * settings form wrote, not a choice, and honouring it would keep the
 * kozos -> shared migration from ever running.
 */
export function sharedFolder() {
  const fresh = trimmed(state.settings()?.sharedFolderName)
  if (fresh) return fresh
  const legacy = trimmed(state.settings()?.[LEGACY_SETTING_KEYS.sharedFolderName])
  if (legacy && legacy !== LEGACY_SHARED_FOLDER) return legacy
  return 'shared'
}

/** How many versions a document keeps. */
export function versionsKept() {
  const raw = Number(setting('versionsKept'))
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50
}

/** Whether the operator wants outside edits noticed. */
export function watchEnabled() {
  const raw = setting('watchEnabled')
  return raw === undefined || raw === null ? true : Boolean(raw)
}

function rebuildIfNeeded() {
  const root = rootSetting()
  if (state._vault && state._root === root) return
  state._vault = createVault({ root })
  state._writer = createIndexWriter({ vault: state._vault, repo: state.repo })
  state._service = createService({
    vault: state._vault,
    writer: state._writer,
    repo: state.repo,
    sharedFolder,
    versionsKept,
  })
  state._root = root
}

export function vaultOf() {
  rebuildIfNeeded()
  return state._vault
}

export function writerOf() {
  rebuildIfNeeded()
  return state._writer
}

export function serviceOf() {
  rebuildIfNeeded()
  return state._service
}

const logOf = () => state.log
const repoOf = () => state.repo

const agentContext = createAgentContext(state, { serviceOf, sharedFolder, logOf })

/**
 * The module's single watcher, held at module scope so that a reload finds the
 * one it already started rather than opening another beside it.
 */
export const watcherControl = createWatcherControl()

/**
 * Brings the watcher in line with the settings. Idempotent in both directions,
 * which is what makes it safe to call from setup() -- and setup() runs again on
 * every write under data/extensions.
 */
export function syncWatcher() {
  try {
    // The root has to exist before anything can watch it. setup() runs before
    // any tool or page call has had a reason to create it, so on a fresh
    // install the watch would otherwise fail with ENOENT and stay down until
    // the operator pressed the restart button -- which is a bad first
    // impression of a feature that is supposed to be automatic.
    vaultOf().ensureRoot()
    return watcherControl.ensureWatcher({
      root: vaultOf().root,
      enabled: watchEnabled(),
      writer: writerOf(),
      vault: vaultOf(),
      log: state.log,
    })
  } catch (err) {
    // An unreachable root is a state the page reports, not a reason to fail
    // loading the extension.
    state.log?.warn?.('docs watcher not started', { error: err?.message })
    return watcherControl.status()
  }
}

const docs = {
  name: 'Docs',
  version: '0.1.0',
  description: 'Markdown docs in one folder: a graphical editor for the operator, seven tools for agents, a folder of its own for every agent.',
  migrations: MIGRATIONS,
  tools: createTools(state, { serviceOf, logOf }),
  rpc: { ...createRpc({
    serviceOf,
    vaultOf,
    writerOf,
    repoOf,
    watcherStatus: () => watcherControl.status(),
    restartWatcher: () => { watcherControl.stop(); return syncWatcher() },
    sharedFolder,
    rootSetting,
    logOf,
  }), ...createMcpBridge(() => docs.tools) },
  /**
   * The one contract this module reaches for, and the sentence the operator
   * reads beside it on the extension card.
   *
   * The declaration IS the access: the host's `resolveExtensionContract`
   * (src/lib/server/extensions/extension-contracts.ts) looks for an entry here
   * naming that extension, that contract and that version, and if there is one
   * the call goes through. Nothing reads `reason`, nothing records a decision
   * about it, and there is no grant, approve or revoke anywhere. So the only
   * way to take this module's reach away is to delete this entry or to disable
   * the Video extension, which takes it from every consumer at once.
   *
   * A provider that is not installed is not a load failure: the host answers a
   * missing one at call time, and `docs_video_script` names it
   * (`contract_missing`) rather than skipping quietly.
   */
  consumes: [
    { extension: 'video', contract: 'videos', version: VIDEOS_CONTRACT_VERSION, reason: "docs_video_script asks it for a finished video's data (title, narration, file details) and puts it as a doc into the asking agent's own folder. This module's only reach outside itself." },
  ],
  provides: {
    [DOCS_CONTRACT]: createDocsContract({
      serviceOf,
      extensionNameOf: (args) => (typeof args?.caller === 'string' && args.caller.trim() !== '' ? args.caller.trim() : 'ext'),
    }),
  },
  hooks: {
    getAgentContext: agentContext.getAgentContext,
    getCapabilityDescription: agentContext.getCapabilityDescription,
    getOperatingGuidance: agentContext.getOperatingGuidance,
  },
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = typeof ctx.settings === 'function' ? ctx.settings : () => ({})
    state.log = ctx.log ?? console
    state.contracts = ctx.contracts ?? null
    state.repo = createRepo(ctx.storage)
    // Dropped rather than kept: the settings may name a different root than the
    // previous load did, and a stale vault would write into the old one.
    state._vault = null
    state._writer = null
    state._service = null
    state._root = null
    syncWatcher()
  },
  ui: {
    pages: [{
      id: 'docs',
      label: 'Docs',
      icon: 'FileText',
      path: '/x/docs',
      entry: 'dist/index.js',
      css: 'dist/style.css',
      position: 'after:tasks',
    }],
    settingsFields: [
      { key: 'root', label: 'Docs root folder', type: 'text', required: true, placeholder: '~/SwarmClaw/docs', help: 'Every .md file goes here. It opens in Finder and Obsidian too.' },
      { key: 'watchEnabled', label: 'Watch for outside edits', type: 'boolean', defaultValue: true, help: 'When a doc changes outside (Obsidian, Finder), search picks it up too.' },
      { key: 'versionsKept', label: 'Versions kept per doc', type: 'number', defaultValue: 50 },
      { key: 'sharedFolderName', label: 'Shared folder name', type: 'text', defaultValue: 'shared', help: 'Every agent can write into this folder.' },
    ],
  },
  managedResources: {
    localFolders: [{
      folderKey: 'docs-root',
      displayName: 'Docs root folder',
      description: 'The markdown docs folder tree.',
      access: 'readWrite',
    }],
    setupChecks: [{
      checkKey: 'docs_root_writable',
      displayName: 'The docs root exists and is writable',
      kind: 'manual',
      required: true,
    }],
  },
}

export default docs
