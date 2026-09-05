import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createIndexWriter } from './src/index-writer.mjs'
import { createVault } from './src/vault.mjs'

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
  _root: null,
}

/** The configured root, with the fallback a never-configured install gets. */
export function rootSetting() {
  const raw = state.settings()?.gyoker
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '~/SwarmClaw/docs'
}

/** The shared folder's name, which the operator may rename. */
export function sharedFolder() {
  const raw = state.settings()?.kozosMappaNev
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'kozos'
}

/** How many versions a document keeps. */
export function versionsKept() {
  const raw = Number(state.settings()?.verzioMegtartas)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50
}

/** Whether the operator wants outside edits noticed. */
export function watchEnabled() {
  const raw = state.settings()?.figyelesBe
  return raw === undefined || raw === null ? true : Boolean(raw)
}

function rebuildIfNeeded() {
  const root = rootSetting()
  if (state._vault && state._root === root) return
  state._vault = createVault({ root })
  state._writer = createIndexWriter({ vault: state._vault, repo: state.repo })
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

const docs = {
  name: 'Doksik',
  version: '0.1.0',
  description: 'Markdown-doksik egy mappában: grafikus szerkesztő az operátornak, hat tool az ügynököknek, ügynökönként saját mappa.',
  migrations: MIGRATIONS,
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
    state._root = null
  },
  ui: {
    pages: [{
      id: 'docs',
      label: 'Doksik',
      icon: 'FileText',
      path: '/x/docs',
      entry: 'dist/index.js',
      css: 'dist/style.css',
      position: 'after:tasks',
    }],
    settingsFields: [
      {
        key: 'gyoker',
        label: 'Doksik gyökérmappája',
        type: 'text',
        required: true,
        placeholder: '~/SwarmClaw/docs',
        help: 'Ide kerül minden .md fájl. Finderben és Obsidianban is megnyitható.',
      },
      {
        key: 'figyelesBe',
        label: 'Külső szerkesztés figyelése',
        type: 'boolean',
        defaultValue: true,
        help: 'Ha kívülről (Obsidian, Finder) módosul egy doksi, a kereső is frissül.',
      },
      {
        key: 'verzioMegtartas',
        label: 'Megtartott verziók / doksi',
        type: 'number',
        defaultValue: 50,
      },
      {
        key: 'kozosMappaNev',
        label: 'Közös mappa neve',
        type: 'text',
        defaultValue: 'kozos',
        help: 'Ebbe a mappába minden ügynök írhat.',
      },
    ],
  },
  managedResources: {
    localFolders: [{
      folderKey: 'docs-root',
      displayName: 'Doksik gyökérmappája',
      description: 'A markdown-doksik mappafája.',
      access: 'readWrite',
    }],
    setupChecks: [{
      checkKey: 'docs_root_writable',
      displayName: 'A doksi-gyökér létezik és írható',
      kind: 'manual',
      required: true,
    }],
  },
}

export default docs
