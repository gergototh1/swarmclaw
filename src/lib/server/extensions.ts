import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import type {
  Extension,
  ExtensionHooks,
  ExtensionMeta,
  ExtensionToolDef,
  ExtensionUIDefinition,
  ExtensionPageDefinition,
  ExtensionProviderDefinition,
  ExtensionConnectorDefinition,
  ExtensionManagedResources,
  ExtensionMigration,
  ExtensionRpcHandler,
  ExtensionContractDeclarations,
  ExtensionContractConsumedMeta,
  ExtensionContractProvidedMeta,
  ExtensionContracts,
  Session,
  ExtensionPackageManager,
  ExtensionDependencyInstallStatus,
  ExtensionPromptBuildResult,
  ExtensionToolCallResult,
  ExtensionModelResolveResult,
  ExtensionBeforeMessageWriteResult,
  ExtensionSubagentSpawningResult,
  Message,
} from '@/types'
import {
  inferExtensionInstallSourceFromUrl,
  inferExtensionPublisherSourceFromUrl,
  isMarketplaceInstallSource,
  normalizeExtensionInstallSource,
  normalizeExtensionPublisherSource,
} from '@/lib/extension-sources'
import { DATA_DIR } from './data-dir'
import { canonicalizeExtensionId, expandExtensionIds, getExtensionAliases } from './tool-aliases'
import { log } from './logger'
import { createNotification } from './create-notification'
import { notify } from './ws-hub'
import { decryptKey, encryptKey, loadSettings, saveSettings } from './storage'
import { buildExtensionHooks } from './extensions-approval-guidance'
import { createExtensionBinaryResolver } from './extensions/extension-binaries'
import { validateExtensionPages } from './extensions/extension-pages'
import { createExtensionStorage, dropExtensionStorage, extensionTablePrefix, runExtensionMigrations } from './extensions/extension-storage'
import {
  createExtensionContracts,
  normalizeContractExtensionId,
  validateExtensionContracts,
  type ContractProviderEntry,
  type ExtensionContractRegistry,
} from './extensions/extension-contracts'
import {
  ensureExtensionResolveHooks,
  evictExtensionCommonJsCache,
  extensionModuleExport,
  importExtensionModule,
} from './extensions/extension-module-loader'
import {
  EXTENSION_WORKSPACE_ENTRY_FILENAME,
  EXTENSION_WORKSPACES_DIR,
  EXTENSIONS_DIR,
  extensionWorkspaceDir,
  extensionWorkspaceEntryPath,
  extensionSourceIsMissing,
  extensionWorkspaceEntrySpecifier,
  hasExtensionWorkspace,
  resolveExtensionSourcePath,
} from './extensions/extension-source-paths'
import {
  readShippedSkillNames,
  removeExtensionManagedResources,
  removeShippedSkillDirs,
} from './extensions/extension-managed-teardown'
import { getGoogleAccessToken, hasGoogleCredential } from './oauth/google'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'

const EXTENSIONS_CONFIG = path.join(DATA_DIR, 'extensions.json')
const EXTENSION_FAILURES = path.join(DATA_DIR, 'extension-failures.json')

// Backward-compat: migrate legacy paths on first access
const _migrateLegacyPaths = (() => {
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      const legacyDir = path.join(DATA_DIR, 'plugins')
      if (fs.existsSync(legacyDir) && !fs.existsSync(EXTENSIONS_DIR)) {
        fs.renameSync(legacyDir, EXTENSIONS_DIR)
      }
      const legacyConfig = path.join(DATA_DIR, 'plugins.json')
      if (fs.existsSync(legacyConfig) && !fs.existsSync(EXTENSIONS_CONFIG)) {
        fs.renameSync(legacyConfig, EXTENSIONS_CONFIG)
      }
      const legacyFailures = path.join(DATA_DIR, 'plugin-failures.json')
      if (fs.existsSync(legacyFailures) && !fs.existsSync(EXTENSION_FAILURES)) {
        fs.renameSync(legacyFailures, EXTENSION_FAILURES)
      }
    } catch { /* ignore migration errors */ }
  }
})()
/**
 * What `ExtensionManager.getActivationState` reports for one extension. See
 * that method for what each value means.
 */
export type ExtensionActivationState = 'active' | 'disabled' | 'not_loaded'

const MAX_EXTERNAL_EXTENSION_BYTES = 1024 * 1024
const SUPPORTED_EXTENSION_PACKAGE_MANAGERS: ExtensionPackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']
const EXTENSION_INSTALL_TIMEOUT_MS = 5 * 60 * 1000
/** How long the extensions directory watcher waits for writes to stop before reloading. */
const EXTENSION_WATCH_DEBOUNCE_MS = 250
const MAX_CONSECUTIVE_EXTENSION_FAILURES = (() => {
  const raw = Number.parseInt(process.env.SWARMCLAW_EXTENSION_FAILURE_THRESHOLD || '3', 10)
  if (!Number.isFinite(raw)) return 3
  return Math.max(2, Math.min(20, raw))
})()
/**
 * How long one extension's `import()` may take before the host gives up on it
 * for this load.
 *
 * `import()` has no timeout of its own, and the boot path awaits every
 * enabled extension's import in turn (see `acquireExternalModules` and
 * `src/instrumentation.ts`). An entry module with a top-level `await` that
 * never settles -- a `fetch` against a host that drops packets, a lock file
 * nobody releases, a promise nothing resolves -- therefore held `register()`
 * open forever: the HTTP listener never bound, `/api/healthz` never answered,
 * and the Extensions screen that could have disabled the extension was
 * unreachable because there was no server to serve it. This is the deadline
 * that turns that hang into an ordinary per-extension failure.
 *
 * Read per call rather than once, so a test can shorten it without a second
 * module instance. The floor keeps a typo from failing every extension on the
 * host; the default is generous because a workspace with real dependencies
 * evaluates them on first import.
 */
const DEFAULT_EXTENSION_IMPORT_TIMEOUT_MS = 30 * 1000
function extensionImportTimeoutMs(): number {
  const raw = Number.parseInt(process.env.SWARMCLAW_EXTENSION_IMPORT_TIMEOUT_MS || '', 10)
  if (!Number.isFinite(raw)) return DEFAULT_EXTENSION_IMPORT_TIMEOUT_MS
  return Math.max(100, raw)
}

/**
 * A fingerprint of the installed dependency tree, or null when the package
 * manager left no record of it.
 *
 * Each manager writes one file that changes whenever the installed tree does:
 * npm's hidden lockfile, pnpm's per-store lock, yarn classic's integrity file,
 * bun's binary lockfile. Hashing that file is what tells a no-op reinstall
 * from an upgrade without walking `node_modules`. A tree with none of them
 * (a manager this list does not know, or a tree copied in by hand) is null,
 * and the caller treats null as "cannot tell", which reports a restart.
 */
function installedTreeFingerprint(workspaceDir: string): string | null {
  const candidates = [
    path.join(workspaceDir, 'node_modules', '.package-lock.json'),
    path.join(workspaceDir, 'node_modules', '.pnpm', 'lock.yaml'),
    path.join(workspaceDir, 'node_modules', '.yarn-integrity'),
    path.join(workspaceDir, 'bun.lockb'),
    path.join(workspaceDir, 'bun.lock'),
  ]
  const hash = crypto.createHash('sha1')
  let found = false
  for (const candidate of candidates) {
    let contents: Buffer
    try {
      contents = fs.readFileSync(candidate)
    } catch {
      continue
    }
    found = true
    hash.update(candidate).update(contents)
  }
  return found ? hash.digest('hex') : null
}

/**
 * The import, or a rejection once the deadline passes.
 *
 * What this does not do is stop the import. There is no way to cancel a
 * module evaluation in Node: the promise stays pending, whatever the module
 * started keeps running, and if the module does settle later nothing is
 * listening. The `catch` on the original promise is what keeps a late
 * rejection from surfacing as an unhandled rejection after the host has
 * already recorded the timeout and moved on.
 */
function importWithDeadline(
  pending: Promise<Record<string, unknown>>,
  file: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let timer: NodeJS.Timeout | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Extension "${file}" did not finish importing within ${timeoutMs} ms; its entry module is still evaluating and the host is continuing without it`))
    }, timeoutMs)
  })
  return Promise.race([pending, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
    pending.catch(() => undefined)
  })
}

interface ExtensionFailureRecord {
  count: number
  lastError: string
  lastStage: string
  lastFailedAt: number
}

interface ExtensionConfigEntry {
  enabled?: boolean
  createdByAgentId?: string
  source?: ExtensionMeta['source']
  sourceLabel?: ExtensionMeta['sourceLabel']
  installSource?: ExtensionMeta['installSource']
  sourceUrl?: string
  sourceHash?: string
  installedAt?: number
  updatedAt?: number
  packageManager?: ExtensionPackageManager
  dependencyInstallStatus?: ExtensionDependencyInstallStatus
  dependencyInstallError?: string
  dependencyInstalledAt?: number
}

interface InstalledExtensionSource {
  filename: string
  sourceUrl: string
  sourceHash: string
  contentType?: string
}

interface ExtensionSourceDownload {
  code: string
  contentType: string
  normalizedUrl: string
  hash: string
}

interface ExtensionDependencyInfo {
  hasManifest: boolean
  dependencyCount: number
  devDependencyCount: number
  packageManager?: ExtensionPackageManager
  installStatus: ExtensionDependencyInstallStatus
  installError?: string
  installedAt?: number
  /**
   * True when this install may have upgraded a package the running process has
   * already evaluated, so the reload that follows it cannot pick the new copy
   * up.
   *
   * The extension's own files re-execute on reload -- a generation stamp for
   * ESM, a targeted `require.cache` eviction for CommonJS -- but a package
   * under the workspace's `node_modules` is deliberately left evaluated once
   * per process, because re-running a package's import-time setup per reload
   * duplicates connection pools, process listeners and native bindings. An
   * install into a workspace that already had `node_modules` is therefore
   * reported as installed while the old copy of anything upgraded stays live
   * until the host restarts, and an operator who is not told that reads a
   * successful install as a change that took effect. Only the install path
   * sets it; a first install into an empty workspace has nothing loaded to go
   * stale.
   */
  restartRequiredForUpgrades: boolean
}

interface UpsertExtensionOptions {
  packageJson?: unknown
  packageManager?: string | null
  installDependencies?: boolean
  meta?: Record<string, unknown>
}

interface ExtensionSecretSettingValue {
  __extensionSecret: true
  encrypted: string
}

interface ExtensionLogger {
  info: (msg: string, m?: unknown) => void
  warn: (msg: string, m?: unknown) => void
  error: (msg: string, m?: unknown) => void
}

type HookRegistrar = {
  onAgentStart?: (fn: (...args: unknown[]) => unknown) => void
  onAgentComplete?: (fn: (...args: unknown[]) => unknown) => void
  onBeforeModelResolve?: (fn: (...args: unknown[]) => unknown) => void
  onBeforePromptBuild?: (fn: (...args: unknown[]) => unknown) => void
  onBeforeToolCall?: (fn: (...args: unknown[]) => unknown) => void
  onToolCall?: (fn: (...args: unknown[]) => unknown) => void
  onToolResult?: (fn: (...args: unknown[]) => unknown) => void
  onMessage?: (fn: (...args: unknown[]) => unknown) => void
}

type HookContext<K extends keyof ExtensionHooks> =
  ExtensionHooks[K] extends ((ctx: infer C) => unknown) | undefined ? C : never

/** Legacy OpenClaw format: activate(ctx)/deactivate() */
interface OpenClawLegacyExtension {
  name: string
  version?: string
  activate: (ctx: HookRegistrar & { registerTool: (def: ExtensionToolDef) => void; log: ExtensionLogger }) => void
  deactivate?: () => void
}

/**
 * Real OpenClaw extension format: function export `(api) => {}` or object with `register(api)`.
 * Supports api.registerHook(), api.registerTool(), api.registerCommand(), api.registerService().
 */
interface OpenClawExtensionApi {
  registerHook: (event: string, handler: (...args: unknown[]) => unknown, meta?: { name?: string; description?: string }) => void
  registerTool: (def: ExtensionToolDef | { name: string; description?: string; parameters?: Record<string, unknown>; planning?: ExtensionToolDef['planning']; execute: (...args: unknown[]) => unknown }) => void
  registerCommand: (def: { name: string; description?: string; handler: (...args: unknown[]) => unknown }) => void
  registerService: (def: { id: string; start: () => void; stop?: () => void }) => void
  registerProvider: (def: Record<string, unknown>) => void
  registerChannel: (def: Record<string, unknown>) => void
  registerGatewayMethod: (name: string, handler: (...args: unknown[]) => unknown) => void
  registerCli: (fn: (...args: unknown[]) => unknown, meta?: { commands?: string[] }) => void
  logger: ExtensionLogger
  log: ExtensionLogger
  config: Record<string, unknown>
  runtime: Record<string, unknown>
}

export interface HookExecutionOptions {
  enabledIds?: string[]
  includeAllWhenEmpty?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isExtensionSecretSettingValue(value: unknown): value is ExtensionSecretSettingValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  return rec.__extensionSecret === true && typeof rec.encrypted === 'string'
}

function concatOptionalTextSegments(...segments: Array<string | null | undefined>): string | undefined {
  const normalized = segments
    .map((segment) => (typeof segment === 'string' ? segment.trim() : ''))
    .filter(Boolean)
  return normalized.length > 0 ? normalized.join('\n\n') : undefined
}

function mergePromptBuildResults(
  current: ExtensionPromptBuildResult | undefined,
  next: ExtensionPromptBuildResult,
): ExtensionPromptBuildResult {
  return {
    systemPrompt: current?.systemPrompt ?? next.systemPrompt,
    prependContext: concatOptionalTextSegments(current?.prependContext, next.prependContext),
    prependSystemContext: concatOptionalTextSegments(current?.prependSystemContext, next.prependSystemContext),
    appendSystemContext: concatOptionalTextSegments(current?.appendSystemContext, next.appendSystemContext),
  }
}

function mergeModelResolveResults(
  current: ExtensionModelResolveResult | undefined,
  next: ExtensionModelResolveResult,
): ExtensionModelResolveResult {
  return {
    providerOverride: next.providerOverride ?? current?.providerOverride,
    modelOverride: next.modelOverride ?? current?.modelOverride,
    apiEndpointOverride: next.apiEndpointOverride ?? current?.apiEndpointOverride,
  }
}

function isToolCallControlResult(value: unknown): value is ExtensionToolCallResult {
  if (!isRecord(value)) return false
  return 'input' in value || 'params' in value || 'block' in value || 'blockReason' in value || 'warning' in value
}

function isMessageLike(value: unknown): value is Message {
  return isRecord(value)
    && (value.role === 'user' || value.role === 'assistant')
    && typeof value.text === 'string'
    && typeof value.time === 'number'
}

function isBeforeMessageWriteResult(value: unknown): value is ExtensionBeforeMessageWriteResult {
  if (!isRecord(value)) return false
  return 'message' in value || 'block' in value
}

function isSubagentSpawningResult(value: unknown): value is ExtensionSubagentSpawningResult {
  return isRecord(value) && (value.status === 'ok' || value.status === 'error')
}

function mergeToolCallInput(
  currentInput: Record<string, unknown> | null,
  nextInput: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (nextInput === undefined) return currentInput
  if (nextInput === null) return null
  if (currentInput && typeof currentInput === 'object') {
    return { ...currentInput, ...nextInput }
  }
  return nextInput
}

function hashExtensionSource(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function normalizeExtensionPackageManager(raw: unknown): ExtensionPackageManager | null {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!text) return null
  const normalized = text.split('@')[0] as ExtensionPackageManager
  return SUPPORTED_EXTENSION_PACKAGE_MANAGERS.includes(normalized) ? normalized : null
}

function trimProcessOutput(output: string): string {
  return output.trim().slice(-4000)
}

function normalizeExtensionManifest(
  rawManifest: unknown,
  filename: string,
  packageManager?: ExtensionPackageManager | null,
): Record<string, unknown> {
  const parsed = typeof rawManifest === 'string'
    ? JSON.parse(rawManifest) as unknown
    : rawManifest
  if (!isRecord(parsed)) throw new Error('Extension package.json must be a JSON object')

  const manifest = { ...parsed } as Record<string, unknown>
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    manifest.name = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9._-]/g, '-')
  }
  if (manifest.private === undefined) manifest.private = true
  if (packageManager && typeof manifest.packageManager !== 'string') {
    manifest.packageManager = packageManager
  }
  return manifest
}

function countManifestDependencies(manifest: Record<string, unknown> | null): {
  dependencyCount: number
  devDependencyCount: number
} {
  const dependencies = isRecord(manifest?.dependencies) ? Object.keys(manifest.dependencies).length : 0
  const devDependencies = isRecord(manifest?.devDependencies) ? Object.keys(manifest.devDependencies).length : 0
  return {
    dependencyCount: dependencies,
    devDependencyCount: devDependencies,
  }
}

function getInstallCommand(packageManager: ExtensionPackageManager): { command: string; args: string[] } {
  switch (packageManager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['install', '--ignore-scripts', '--config.ignore-workspace=true'] }
    case 'yarn':
      return { command: 'yarn', args: ['install', '--ignore-scripts'] }
    case 'bun':
      return { command: 'bun', args: ['install', '--ignore-scripts'] }
    case 'npm':
    default:
      return { command: 'npm', args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'] }
  }
}

function toRawExtensionUrl(url: string): string {
  if (url.includes('github.com') && url.includes('/blob/')) {
    return url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
  }
  if (url.includes('gist.github.com')) {
    return url.endsWith('/raw') ? url : `${url}/raw`
  }
  return url
}

function inferStoredExtensionSource(config: ExtensionConfigEntry | null | undefined): ExtensionMeta['source'] {
  if (config?.source === 'local' || config?.source === 'manual' || config?.source === 'marketplace') {
    return config.source
  }
  if (config?.sourceUrl) {
    const installSource = normalizeExtensionInstallSource(config?.installSource)
      || inferExtensionInstallSourceFromUrl(config.sourceUrl)
    return isMarketplaceInstallSource(installSource) ? 'marketplace' : 'manual'
  }
  return 'local'
}

function inferStoredPublisherSource(config: ExtensionConfigEntry | null | undefined): NonNullable<ExtensionMeta['sourceLabel']> {
  return normalizeExtensionPublisherSource(config?.sourceLabel)
    || inferExtensionPublisherSourceFromUrl(config?.sourceUrl)
    || (config?.sourceUrl ? 'manual' : 'local')
}

function inferStoredInstallSource(config: ExtensionConfigEntry | null | undefined): NonNullable<ExtensionMeta['installSource']> {
  return normalizeExtensionInstallSource(config?.installSource)
    || inferExtensionInstallSourceFromUrl(config?.sourceUrl)
    || (config?.sourceUrl ? 'manual' : 'local')
}

export function normalizeMarketplaceExtensionUrl(url: string): string {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (!trimmed) return trimmed

  const normalized = toRawExtensionUrl(trimmed)

  return normalized
    .replace('/swarmclawai/swarmforge/master/', '/swarmclawai/swarmforge/main/')
}

export function sanitizeExtensionFilename(filename: string): string {
  const trimmed = typeof filename === 'string' ? filename.trim() : ''
  if (!trimmed) throw new Error('Filename is required')
  if (!trimmed.endsWith('.js') && !trimmed.endsWith('.mjs')) {
    throw new Error('Filename must end in .js or .mjs')
  }
  const sanitized = path.basename(trimmed)
  if (sanitized !== trimmed || trimmed.includes('..')) {
    throw new Error('Invalid filename')
  }
  return sanitized
}

async function downloadExtensionSource(url: string): Promise<ExtensionSourceDownload> {
  const normalizedUrl = normalizeMarketplaceExtensionUrl(url)
  if (!normalizedUrl || !normalizedUrl.startsWith('https://')) {
    throw new Error('URL must be a valid HTTPS URL')
  }

  const res = await fetch(normalizedUrl, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}) from ${normalizedUrl}`)
  }

  const contentType = res.headers.get('content-type') || ''
  const lengthHeader = res.headers.get('content-length')
  const declaredSize = lengthHeader ? Number.parseInt(lengthHeader, 10) : Number.NaN
  if (Number.isFinite(declaredSize) && declaredSize > MAX_EXTERNAL_EXTENSION_BYTES) {
    throw new Error(`Extension file is too large (${declaredSize} bytes)`)
  }

  let code = await res.text()
  if (Buffer.byteLength(code, 'utf8') > MAX_EXTERNAL_EXTENSION_BYTES) {
    throw new Error(`Extension file exceeds ${MAX_EXTERNAL_EXTENSION_BYTES} bytes`)
  }

  if (contentType.includes('text/html') && code.includes('<!DOCTYPE')) {
    throw new Error('URL returned an HTML page instead of JavaScript. Use a raw/direct link to the extension file.')
  }

  // Compatibility: modern Node exposes global fetch.
  code = code.replace(/const\s+fetch\s*=\s*require\(['"]node-fetch['"]\);?/g, '// node-fetch stripped for compatibility')
  code = code.replace(/import\s+fetch\s+from\s+['"]node-fetch['"];?/g, '// node-fetch stripped for compatibility')

  return {
    code,
    contentType,
    normalizedUrl,
    hash: hashExtensionSource(code),
  }
}

function coerceTools(rawTools: unknown): ExtensionToolDef[] {
  if (Array.isArray(rawTools)) {
    const tools: ExtensionToolDef[] = []
    for (const rawTool of rawTools) {
      if (!isRecord(rawTool)) continue
      const name = typeof rawTool.name === 'string' ? rawTool.name.trim() : ''
      const execute = rawTool.execute
      if (!name || typeof execute !== 'function') continue
      tools.push({
        name,
        description: typeof rawTool.description === 'string' ? rawTool.description : `Extension tool: ${name}`,
        parameters: isRecord(rawTool.parameters) ? rawTool.parameters : { type: 'object', properties: {} },
        planning: isRecord(rawTool.planning) ? rawTool.planning as ExtensionToolDef['planning'] : undefined,
        execute: execute as ExtensionToolDef['execute'],
      })
    }
    return tools
  }

  // Compatibility: object-map format (e.g. { ping: () => 'pong' }).
  if (isRecord(rawTools)) {
    const tools: ExtensionToolDef[] = []
    for (const [name, rawTool] of Object.entries(rawTools)) {
      if (!name.trim()) continue
      if (typeof rawTool === 'function') {
        tools.push({
          name,
          description: `Extension tool: ${name}`,
          parameters: { type: 'object', properties: {} },
          execute: async (args) => rawTool(args),
        })
        continue
      }
      if (!isRecord(rawTool) || typeof rawTool.execute !== 'function') continue
      tools.push({
        name,
        description: typeof rawTool.description === 'string' ? rawTool.description : `Extension tool: ${name}`,
        parameters: isRecord(rawTool.parameters) ? rawTool.parameters : { type: 'object', properties: {} },
        planning: isRecord(rawTool.planning) ? rawTool.planning as ExtensionToolDef['planning'] : undefined,
        execute: rawTool.execute as ExtensionToolDef['execute'],
      })
    }
    return tools
  }

  return []
}

function coerceManagedResources(raw: Record<string, unknown>): ExtensionManagedResources | undefined {
  const explicit = isRecord(raw.managedResources)
    ? raw.managedResources as Record<string, unknown>
    : {}
  const agents = Array.isArray(explicit.agents)
    ? explicit.agents
    : Array.isArray(raw.agents)
      ? raw.agents
      : undefined
  const schedules = Array.isArray(explicit.schedules)
    ? explicit.schedules
    : Array.isArray(raw.schedules)
      ? raw.schedules
      : undefined
  const routines = Array.isArray(explicit.routines)
    ? explicit.routines
    : Array.isArray(raw.routines)
      ? raw.routines
      : undefined
  const localFolders = Array.isArray(explicit.localFolders)
    ? explicit.localFolders
    : Array.isArray(raw.localFolders)
      ? raw.localFolders
      : undefined
  const gatewayPlatforms = Array.isArray(explicit.gatewayPlatforms)
    ? explicit.gatewayPlatforms
    : Array.isArray(raw.gatewayPlatforms)
      ? raw.gatewayPlatforms
      : undefined
  const setupChecks = Array.isArray(explicit.setupChecks)
    ? explicit.setupChecks
    : Array.isArray(raw.setupChecks)
      ? raw.setupChecks
      : undefined

  const managedResources: ExtensionManagedResources = {
    agents: agents as ExtensionManagedResources['agents'],
    schedules: schedules as ExtensionManagedResources['schedules'],
    routines: routines as ExtensionManagedResources['routines'],
    localFolders: localFolders as ExtensionManagedResources['localFolders'],
    gatewayPlatforms: gatewayPlatforms as ExtensionManagedResources['gatewayPlatforms'],
    setupChecks: setupChecks as ExtensionManagedResources['setupChecks'],
  }

  return Object.values(managedResources).some((value) => Array.isArray(value) && value.length > 0)
    ? managedResources
    : undefined
}

function normalizeExtension(mod: unknown): Extension | null {
  const modObj = mod as Record<string, unknown>
  const raw: Record<string, unknown> = (modObj?.default as Record<string, unknown>) || modObj

  if (raw.name && (raw.hooks || raw.tools || raw.ui || raw.providers || raw.connectors || raw.managedResources || raw.agents || raw.schedules || raw.routines || raw.localFolders || raw.gatewayPlatforms || raw.setupChecks || raw.rpc || raw.migrations || raw.provides || raw.consumes)) {
    const hooks = isRecord(raw.hooks) ? (raw.hooks as ExtensionHooks) : {}
    return {
      name: raw.name as string,
      version: (raw.version as string) || '0.0.1',
      description: (raw.description as string) || '',
      author: typeof raw.author === 'string' ? raw.author : undefined,
      openclaw: raw.openclaw === true,
      hooks,
      tools: coerceTools(raw.tools),
      ui: isRecord(raw.ui) ? (raw.ui as ExtensionUIDefinition) : undefined,
      providers: Array.isArray(raw.providers) ? (raw.providers as ExtensionProviderDefinition[]) : undefined,
      connectors: Array.isArray(raw.connectors) ? (raw.connectors as ExtensionConnectorDefinition[]) : undefined,
      managedResources: coerceManagedResources(raw),
      setup: typeof raw.setup === 'function' ? (raw.setup as Extension['setup']) : undefined,
      migrations: Array.isArray(raw.migrations) ? (raw.migrations as ExtensionMigration[]) : undefined,
      rpc: isRecord(raw.rpc) ? (raw.rpc as Record<string, ExtensionRpcHandler>) : undefined,
      // Carried through exactly as declared, unlike the fields above, so that
      // validateExtensionContracts sees what the author actually wrote. A
      // shape check here would turn `provides: []` into "declares nothing" and
      // load the extension with its contracts silently missing; letting the
      // validator reject it fails the load with a message that names the
      // mistake.
      provides: raw.provides as Extension['provides'],
      consumes: raw.consumes as Extension['consumes'],
    } as Extension
  }

  // --- Real OpenClaw format: function export `(api) => {}` or object with `register(api)` ---
  const registerFn = typeof raw === 'function'
    ? raw as (api: OpenClawExtensionApi) => void
    : typeof raw.register === 'function'
      ? raw.register as (api: OpenClawExtensionApi) => void
      : typeof raw.default === 'function' && !raw.name && !raw.hooks
        ? raw.default as (api: OpenClawExtensionApi) => void
        : null

  if (registerFn) {
    const extensionName = (raw.id || raw.name || 'openclaw-extension') as string
    const extensionVersion = (raw.version || '1.0.0') as string
    const extensionDesc = (raw.description || '') as string
    const hooks: ExtensionHooks = {}
    const tools: ExtensionToolDef[] = []

    const hookEventMap: Record<string, keyof ExtensionHooks> = {
      'before_model_resolve': 'beforeModelResolve',
      'before_prompt_build': 'beforePromptBuild',
      'before_tool_call': 'beforeToolCall',
      'llm_input': 'llmInput',
      'llm_output': 'llmOutput',
      'tool_result_persist': 'toolResultPersist',
      'before_message_write': 'beforeMessageWrite',
      'session_start': 'sessionStart',
      'session_end': 'sessionEnd',
      'subagent_spawning': 'subagentSpawning',
      'subagent_spawned': 'subagentSpawned',
      'subagent_ended': 'subagentEnded',
      'agent:start': 'beforeAgentStart',
      'agent:complete': 'afterAgentComplete',
      'tool:call': 'beforeToolExec',
      'tool:result': 'afterToolExec',
      'message': 'onMessage',
      'message:inbound': 'transformInboundMessage',
      'message:outbound': 'transformOutboundMessage',
      'command:new': 'beforeAgentStart',
      'agent:context': 'getAgentContext',
    }

    const extensionLogger: ExtensionLogger = {
      info: (msg: string, m?: unknown) => log.info(`extension:${extensionName}`, msg, m),
      warn: (msg: string, m?: unknown) => log.warn(`extension:${extensionName}`, msg, m),
      error: (msg: string, m?: unknown) => log.error(`extension:${extensionName}`, msg, m),
    }

    const api: OpenClawExtensionApi = {
      registerHook: (event: string, handler: (...args: unknown[]) => unknown) => {
        const hookKey = hookEventMap[event]
        if (hookKey) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(hooks as Record<string, unknown>)[hookKey] = handler as any
        }
      },
      registerTool: (def) => {
        if (def?.name && typeof def.execute === 'function') {
          tools.push({
            name: def.name,
            description: def.description || `Extension tool: ${def.name}`,
            parameters: (def.parameters || { type: 'object', properties: {} }) as Record<string, unknown>,
            planning: isRecord((def as Record<string, unknown>).planning)
              ? (def as ExtensionToolDef).planning
              : undefined,
            execute: def.execute as ExtensionToolDef['execute'],
          })
        }
      },
      registerCommand: () => { /* Commands stored as tools */ },
      registerService: () => { /* Services not yet supported in SwarmClaw */ },
      registerProvider: () => { /* Providers not yet bridged */ },
      registerChannel: () => { /* Channels not yet bridged */ },
      registerGatewayMethod: () => { /* RPC not supported */ },
      registerCli: () => { /* CLI not supported */ },
      logger: extensionLogger,
      log: extensionLogger,
      config: {},
      runtime: {},
    }

    try {
      registerFn(api)
    } catch (err: unknown) {
      log.error('extensions', 'OpenClaw register() failed', {
        extensionName,
        error: errorMessage(err),
      })
      return null
    }

    return {
      name: extensionName,
      version: extensionVersion,
      description: extensionDesc || `OpenClaw extension (v${extensionVersion})`,
      author: typeof raw.author === 'string' ? raw.author : undefined,
      openclaw: true,
      hooks,
      tools,
    }
  }

  // --- Legacy OpenClaw format: activate(ctx)/deactivate() ---
  if (raw.name && typeof raw.activate === 'function') {
    const oc = raw as unknown as OpenClawLegacyExtension
    const hooks: ExtensionHooks = {}
    const tools: ExtensionToolDef[] = []

    const registrar = {
      onAgentStart: (fn: (...args: unknown[]) => unknown) => { hooks.beforeAgentStart = fn as ExtensionHooks['beforeAgentStart'] },
      onAgentComplete: (fn: (...args: unknown[]) => unknown) => { hooks.afterAgentComplete = fn as ExtensionHooks['afterAgentComplete'] },
      onBeforePromptBuild: (fn: (...args: unknown[]) => unknown) => { hooks.beforePromptBuild = fn as ExtensionHooks['beforePromptBuild'] },
      onBeforeToolCall: (fn: (...args: unknown[]) => unknown) => { hooks.beforeToolCall = fn as ExtensionHooks['beforeToolCall'] },
      onToolCall: (fn: (...args: unknown[]) => unknown) => { hooks.beforeToolExec = fn as ExtensionHooks['beforeToolExec'] },
      onToolResult: (fn: (...args: unknown[]) => unknown) => { hooks.afterToolExec = fn as ExtensionHooks['afterToolExec'] },
      onMessage: (fn: (...args: unknown[]) => unknown) => { hooks.onMessage = fn as ExtensionHooks['onMessage'] },
      registerTool: (def: ExtensionToolDef) => { if (def?.name) tools.push(def) },
      log: {
        info: (msg: string, m?: unknown) => log.info(`extension:${oc.name}`, msg, m),
        warn: (msg: string, m?: unknown) => log.warn(`extension:${oc.name}`, msg, m),
        error: (msg: string, m?: unknown) => log.error(`extension:${oc.name}`, msg, m),
      }
    }

    try {
      oc.activate(registrar)
    } catch (err: unknown) {
      log.error('extensions', 'OpenClaw activate() failed', {
        extensionName: oc.name,
        error: errorMessage(err),
      })
      return null
    }

    return {
      name: oc.name,
      version: oc.version,
      description: `OpenClaw extension (v${oc.version || '0.0.0'})`,
      openclaw: true,
      hooks,
      tools,
    }
  }
  return null
}

interface LoadedExtension {
  id: string
  meta: ExtensionMeta
  hooks: ExtensionHooks
  tools: ExtensionToolDef[]
  ui?: ExtensionUIDefinition
  providers?: ExtensionProviderDefinition[]
  connectors?: ExtensionConnectorDefinition[]
  managedResources?: ExtensionManagedResources
  rpc?: Record<string, ExtensionRpcHandler>
  /** Validated `provides`/`consumes`. Set for every loaded external extension, never for a builtin. */
  contracts?: ExtensionContractDeclarations
  isBuiltin?: boolean
}

/**
 * One enabled external extension's module, as of the generation it was acquired
 * in. `ok: false` records an acquisition that was attempted and failed, which is
 * what separates "this extension is broken" from "this extension has not been
 * acquired yet": the first is a load failure to report, the second means the
 * synchronous load path must not run at all. See `loadOnce`.
 */
type ExternalModuleRecord =
  | { ok: true; namespace: Record<string, unknown> }
  /**
   * `vanished` marks an import that failed because the file is no longer there,
   * which is a race with the operator rather than a broken extension. It leaves
   * the consecutive-failure counter alone entirely: suppressing only the
   * auto-disable action still advanced the count, so a vanished import followed
   * by genuine failures hit the threshold one failure early. It does not cover
   * a half-written file: that one still exists, still fails to parse, and is
   * held off only by the watcher debounce.
   */
  | { ok: false; error: unknown; vanished?: boolean }

/**
 * A `require` rooted at the host's package.json, for evicting a CommonJS
 * extension from `require.cache` before it is re-imported.
 *
 * Deliberately not written as `createRequire(<expression>)` with `createRequire`
 * imported from `module`. webpack recognises that exact call shape and, when the
 * argument is not a string literal, compiles the call to a bare `undefined`
 * behind a `createRequire()` marker comment, with no build warning and no
 * runtime throw. Under `next dev --webpack` (and a
 * `next build --webpack`) this function therefore returned `undefined`, the
 * caller took its "external extensions disabled" exit, and no external
 * extension loaded: listed as enabled, `hasUI: false`, nothing in the log,
 * because the catch below only speaks when something throws. Turbopack, which
 * every default build and the desktop and container images use, leaves the
 * call alone, so the defect was invisible everywhere except a developer's
 * `--webpack` run.
 *
 * `process.getBuiltinModule` (Node 20.16+, so Electron 33's embedded 20.18.3
 * included) hands back the real `node:module` at run time through a call no
 * bundler rewrites, and the resulting `require` is the same object either way.
 */
function createExtensionRequire(): NodeRequire | null {
  try {
    const nodeModule = process.getBuiltinModule('node:module')
    return nodeModule.createRequire(path.join(process.cwd(), 'package.json'))
  } catch (err: unknown) {
    log.warn('extensions', 'createRequire failed; external extensions disabled', {
      error: errorMessage(err),
    })
    return null
  }
}

export interface ExternalExtensionToolEntry {
  extensionId: string
  extensionName: string
  tool: ExtensionToolDef
}

class ExtensionManager {
  private extensions: Map<string, LoadedExtension> = new Map()
  private builtins: Map<string, Extension> = new Map()
  private loaded = false
  /**
   * True only while load() is running. Contract resolution reads it so that a
   * `ctx.contracts` call made from inside an extension's setup() does not
   * re-enter load(): setup() runs during load(), so re-entering would recurse
   * until the stack ran out, re-running every extension's migrations and
   * setup() on the way down. Same trap the `settings` closure in load()
   * documents, reached from a different direction.
   */
  private loading = false
  private watcher: fs.FSWatcher | null = null
  /**
   * The contract declarations each external extension had the last time it got
   * far enough through load() to have valid ones, kept across reloads on
   * purpose. `this.extensions` is cleared and rebuilt by every load and holds
   * only what is switched on, which used to mean an extension's declared data
   * access vanished from its card the moment an operator switched it off —
   * exactly when they most want to see what turning it back on would regain.
   *
   * This is the only place that survives, because there is nowhere else to
   * read it from: a switched-off extension is never required, and requiring it
   * to read its manifest would run the module the operator switched off. The
   * cost is that it is process-local, and that it is a snapshot of the last
   * load rather than of the file. A host that starts up with the extension
   * already disabled has never executed it, so its card shows no grants until
   * it is enabled once; and a file edited after it was switched off keeps
   * showing the declarations it had when it last ran, until it is switched on
   * again. Populated before setup() runs, so an extension that fails in setup()
   * still shows what it asked for.
   */
  private lastKnownContracts: Map<string, ExtensionContractDeclarations> = new Map()

  /**
   * The module object of every enabled external extension, acquired
   * asynchronously by `acquireExternalModules` and read synchronously by
   * `loadOnce`.
   *
   * This split is the whole shape change. An extension module can only be
   * obtained with `import()`, which is async, but the manager's read side
   * (`getTools`, `getProviders`, `listExtensions`, the prompt sections, the
   * provider list) is synchronous and reached from a long tail of synchronous
   * callers across the app. Making all of those async would rewrite prompt
   * building and the provider registry to fix an extension loader, so instead
   * the async step is confined to acquisition: the module objects are in hand
   * before any synchronous read can want them, and `loadOnce` never awaits.
   *
   * What has to hold for that to be honest is that `loaded` is never false at a
   * moment when this map is stale. Every path that invalidates re-acquires
   * first and swaps both in the same synchronous step -- see `reload`. The one
   * remaining cold moment is process start, before `ensureLoaded` has run;
   * `loadOnce` refuses to complete a load in that state rather than quietly
   * reporting a host with no external extensions.
   */
  private externalModules: Map<string, ExternalModuleRecord> = new Map()

  /**
   * Bumped once per reload. Stamped onto each extension's module URL so the
   * next `import()` evaluates the file again instead of returning the module
   * Node already has: the ESM registry is keyed by URL and cannot be evicted.
   * Starts at 1 so the first load is already stamped and the second load
   * differs from it.
   */
  private moduleGeneration = 1

  /** The debounced re-acquisition the extensions directory watcher schedules. */
  private watcherReloadTimer: NodeJS.Timeout | null = null

  /**
   * Tail of the reload chain. Every `reload()` runs after the one before it has
   * finished, so the last reload to start is the last to install. See `reload`.
   */
  private reloadQueue: Promise<void> = Promise.resolve()

  /** Open watchers on managed workspace directories, keyed by extension filename. */
  private workspaceWatchers: Map<string, fs.FSWatcher> = new Map()

  /**
   * Set once, the first time the synchronous load path is reached before any
   * module has been acquired. Keeps that warning to one line per process
   * instead of one per getter call.
   */
  private warnedAboutColdLoad = false

  /**
   * Registers a builtin extension and forces the next read to rebuild, because
   * builtins are imported and registered after the first load.
   *
   * That rebuild is not free and not confined to the builtin being registered:
   * the next `load()` re-runs `loadOnce`, which calls `setup()` again for
   * *every* enabled external extension, on the module instances it already
   * holds. So an unrelated extension's setup() runs an extra time per builtin
   * registered after the first load, on the same module object rather than a
   * fresh one -- a duplicated side effect, not a fresh generation. Pre-existing
   * and unchanged here; extensions are required to make setup() idempotent for
   * this reason among others.
   */
  registerBuiltin(id: string, extension: Extension) {
    const canonicalId = this.canonicalExtensionId(id)
    this.builtins.set(canonicalId, extension)
    this.loaded = false
  }

  private ensureExtensionWatcher(): void {
    if (this.watcher) return
    try {
      this.ensureExtensionDirs()
      const watcher = fs.watch(EXTENSIONS_DIR, (_eventType, filename) => {
        if (!filename || (!filename.endsWith('.js') && !filename.endsWith('.mjs'))) return
        this.scheduleWatcherReload()
      })
      watcher.on('error', (err: unknown) => {
        log.warn('extensions', 'Extension watcher disabled after runtime watch failure', {
          error: errorMessage(err),
        })
        if (this.watcher === watcher) {
          try { watcher.close() } catch { /* ignore */ }
          this.watcher = null
        }
      })
      watcher.unref?.()
      this.watcher = watcher
    } catch (err: unknown) {
      log.warn('extensions', 'Failed to watch extensions directory', {
        error: errorMessage(err),
      })
    }
  }

  /**
   * Re-acquires and reloads after a write under the extensions directory.
   *
   * The watcher used to only mark the manager dirty and let the next getter
   * reload synchronously. It cannot do that any more -- acquisition is async --
   * and the naive replacement, marking dirty and re-acquiring in the
   * background, would leave a window in which every getter reports a host with
   * no external extensions. So the reload happens here, ahead of any reader,
   * and `loaded` only goes false once the new modules are in hand.
   *
   * The debounce is not cosmetic. `fs.watch` fires while a file is still being
   * written, and importing a half-written extension is a syntax error that
   * `markExtensionFailure` counts; enough of them in a row and the extension is
   * auto-disabled. Waiting for the writes to stop is what keeps an ordinary
   * save from looking like a failing extension. A reload already in flight is
   * not interrupted: the timer is restarted, so the last write wins.
   *
   * The timer is `unref`'d, so it does not hold a process open. In the server
   * that is the point -- the process outlives every debounce anyway -- but it
   * does mean a short-lived process that exits inside the debounce window drops
   * the pending reload and its `notify('extensions')` entirely. A test or
   * script that writes an extension file and exits must reload explicitly
   * rather than wait for the watcher.
   */
  private scheduleWatcherReload(): void {
    if (this.watcherReloadTimer) clearTimeout(this.watcherReloadTimer)
    const timer = setTimeout(() => {
      this.watcherReloadTimer = null
      void this.reload()
        .catch((err: unknown) => {
          log.warn('extensions', 'Reload after extensions directory change failed', {
            error: errorMessage(err),
          })
        })
        .finally(() => { notify('extensions') })
    }, EXTENSION_WATCH_DEBOUNCE_MS)
    timer.unref?.()
    this.watcherReloadTimer = timer
  }

  /**
   * Opens and closes watchers on the managed workspace entries.
   *
   * The extensions-directory watcher above is non-recursive and filtered to
   * `.js`/`.mjs` basenames, so it never reports a write under
   * `extensions/.workspaces/<key>/` -- and that workspace entry is the file the
   * loader imports for a workspace-backed extension. Editing it on disk
   * therefore changed nothing until something else forced a reload.
   *
   * One non-recursive watcher per workspace rather than one recursive watcher
   * over the extensions directory: a recursive watch descends into every
   * workspace's `node_modules`, which costs a watch descriptor per directory on
   * Linux and floods the debounce during a dependency install. A non-recursive
   * watch on the workspace root reports its direct children only, and the
   * filter below keeps that to the entry file.
   *
   * What that leaves uncovered, stated plainly because the temptation is to
   * read the paragraph above as a fix for extension development in general: the
   * watch reaches exactly two files per extension, the extensions-dir file and
   * the workspace entry. It does not reach the source tree below that entry --
   * `src/*.mjs`, where an extension like AI Signal keeps almost all of its code
   * -- nor the workspace `package.json`, nor `node_modules`. Editing any of
   * those takes an explicit reload: save through the UI, toggle the extension
   * off and on, or touch the entry file. This is the same limit
   * `Extension.setup`'s contract states in `src/types/extension.ts`, and the
   * two must keep saying it the same way. Widening it means paying the
   * recursive-watch cost above on every host, dependency-install floods
   * included, for a loop that has a one-keystroke workaround.
   *
   * Re-synced from `loadOnce`, so a workspace that appeared gains a watcher and
   * one that was deleted loses it without any separate bookkeeping.
   */
  private syncWorkspaceWatchers(filenames: string[]): void {
    const wanted = new Set(filenames.filter((filename) => this.hasWorkspace(filename)))
    for (const [filename, watcher] of this.workspaceWatchers) {
      if (wanted.has(filename)) continue
      try { watcher.close() } catch { /* ignore */ }
      this.workspaceWatchers.delete(filename)
    }
    for (const filename of wanted) {
      if (this.workspaceWatchers.has(filename)) continue
      try {
        const watcher = fs.watch(this.getWorkspaceDir(filename), (_eventType, changed) => {
          if (changed !== EXTENSION_WORKSPACE_ENTRY_FILENAME) return
          this.scheduleWatcherReload()
        })
        watcher.on('error', (err: unknown) => {
          log.warn('extensions', 'Extension workspace watcher disabled after runtime watch failure', {
            extensionId: filename,
            error: errorMessage(err),
          })
          if (this.workspaceWatchers.get(filename) === watcher) {
            try { watcher.close() } catch { /* ignore */ }
            this.workspaceWatchers.delete(filename)
          }
        })
        watcher.unref?.()
        this.workspaceWatchers.set(filename, watcher)
      } catch (err: unknown) {
        log.warn('extensions', 'Failed to watch extension workspace', {
          extensionId: filename,
          error: errorMessage(err),
        })
      }
    }
  }

  private isExternalExtensionFilename(id: string): boolean {
    return id.endsWith('.js') || id.endsWith('.mjs')
  }

  private ensureExtensionDirs(): void {
    _migrateLegacyPaths()
    if (!fs.existsSync(EXTENSIONS_DIR)) fs.mkdirSync(EXTENSIONS_DIR, { recursive: true })
    if (!fs.existsSync(EXTENSION_WORKSPACES_DIR)) fs.mkdirSync(EXTENSION_WORKSPACES_DIR, { recursive: true })
  }

  /** Filenames of the external extension files currently on disk. Empty when the directory cannot be read. */
  private listExtensionFilenames(): string[] {
    try {
      this.ensureExtensionDirs()
      return fs.readdirSync(EXTENSIONS_DIR).filter((name) => name.endsWith('.js') || name.endsWith('.mjs'))
    } catch {
      return []
    }
  }

  private getWorkspaceDir(filename: string): string {
    return extensionWorkspaceDir(filename)
  }

  /** Absolute path of an extension's managed workspace directory. Returned even when it does not exist yet. */
  getWorkspaceDirFor(filename: string): string {
    return this.getWorkspaceDir(sanitizeExtensionFilename(filename))
  }

  private getWorkspaceEntryPath(filename: string): string {
    return extensionWorkspaceEntryPath(filename)
  }

  private getWorkspaceManifestPath(filename: string): string {
    return path.join(this.getWorkspaceDir(filename), 'package.json')
  }

  private hasWorkspace(filename: string): boolean {
    return hasExtensionWorkspace(filename)
  }

  private readWorkspaceManifest(filename: string): Record<string, unknown> | null {
    const manifestPath = this.getWorkspaceManifestPath(filename)
    try {
      if (!fs.existsSync(manifestPath)) return null
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private getDependencyInfo(filename: string, explicitConfig?: ExtensionConfigEntry | null): ExtensionDependencyInfo {
    const manifest = this.readWorkspaceManifest(filename)
    const counts = countManifestDependencies(manifest)
    return {
      hasManifest: !!manifest,
      dependencyCount: counts.dependencyCount,
      devDependencyCount: counts.devDependencyCount,
      packageManager:
        normalizeExtensionPackageManager(explicitConfig?.packageManager)
        || normalizeExtensionPackageManager(manifest?.packageManager)
        || undefined,
      installStatus: explicitConfig?.dependencyInstallStatus || (manifest ? 'ready' : 'none'),
      installError: explicitConfig?.dependencyInstallError,
      installedAt: explicitConfig?.dependencyInstalledAt,
      restartRequiredForUpgrades: false,
    }
  }

  /**
   * Writes the extensions-dir file that stands in for a workspace-backed
   * extension.
   *
   * The loader does not import this file -- it imports the workspace entry, see
   * `resolveExtensionSourcePath` -- so the shim is a marker rather than a load
   * path: it is what makes the extension appear in the directory listing that
   * `listExtensionFilenames` and `listExtensions` read, and what an operator
   * opening `data/extensions/<name>` finds.
   *
   * Two module formats have to line up here, and they are decided
   * independently. The shim's own format comes from its name and where it
   * sits: `.mjs` is ESM whatever surrounds it, and `.js` under
   * `data/extensions` is CommonJS because nothing above that directory
   * declares `"type": "module"`. The entry's format comes from the workspace
   * `package.json`. Three of the four combinations bridge:
   *
   *   `.mjs` shim, either entry     `export { default } from ...`
   *   `.js` shim, CommonJS entry    `module.exports = require(...)`
   *   `.js` shim, ESM entry         no bridge exists
   *
   * The last one is not hypothetical: `extension_creator` forces `.js`
   * filenames and passes `packageJson` straight through, so an agent that
   * scaffolds an ESM extension lands there. Writing the CommonJS `require()`
   * form for it produces a file that loads under a server's Node 22 and raises
   * ERR_REQUIRE_ESM under the desktop app's Electron 33 (Node 20.18), and a
   * shim that behaves differently in the two places the product ships is worse
   * than one that does not load anywhere. So that case gets a shim that fails
   * identically on both and says why: inert while nothing imports the shim,
   * honest the moment something does.
   *
   * The relative specifier is derived from the workspace constants rather than
   * spelled out, so moving the workspaces directory or the entry filename
   * cannot leave the shim pointing at nothing.
   */
  private writeWorkspaceShim(filename: string): void {
    const specifier = extensionWorkspaceEntrySpecifier(filename)
    const shimIsEsm = filename.endsWith('.mjs')
    const entryIsEsm = this.readWorkspaceManifest(filename)?.type === 'module'
    let body: string
    if (shimIsEsm) {
      body = `export { default } from ${JSON.stringify(specifier)}\n`
    } else if (!entryIsEsm) {
      body = `module.exports = require(${JSON.stringify(specifier)})\n`
    } else {
      const reason = `Extension shim ${filename} is CommonJS and its source ${specifier} is an ES module.`
      body = `// This file is CommonJS and ${specifier} is an ES module, so it cannot\n`
        + '// re-export it. The host imports the workspace entry directly and never this\n'
        + '// file; anything else must import the entry too.\n'
        + `throw new Error(${JSON.stringify(`${reason} Import the source directly.`)})\n`
    }
    const shim = `// Auto-generated extension workspace shim. Edit the managed source file instead.\n${body}`
    fs.writeFileSync(path.join(EXTENSIONS_DIR, filename), shim, 'utf8')
  }

  /**
   * Evicts a CommonJS extension, and the workspace files it loaded, from
   * `require.cache` so that the next load re-executes the file the operator
   * just edited. Its `node_modules` are left alone, so a dependency is
   * evaluated once per process in both module formats.
   *
   * Still required now that the loader uses `import()`. Importing a CommonJS
   * file runs Node's CommonJS loader underneath, and that loader has its own
   * realpath-keyed cache: the generation-stamped URL gives the ESM side a fresh
   * module record, but the CommonJS side fills it from the cached
   * `module.exports` unless the entry is evicted first. Measured under plain
   * Node and under Electron's embedded Node: with this eviction a CommonJS
   * extension and its own workspace files re-execute per generation, without it
   * neither does. ESM extensions do not need it and are not helped by it --
   * their re-execution comes entirely from the generation stamp, because an ESM
   * module lives in a registry with no eviction API.
   *
   * Both the file the operator sees in the extensions directory and the
   * workspace entry the loader actually imports are evicted, because either can
   * be the CommonJS module Node cached: an extension without a workspace is
   * loaded from the first path, one with a workspace from the second.
   *
   * The realpath and containment reasoning that this eviction depends on lives
   * with the eviction itself, in `evictExtensionCommonJsCache`.
   */
  private clearExtensionRequireCache(dynamicRequire: NodeRequire, filename: string): void {
    evictExtensionCommonJsCache(dynamicRequire.cache, {
      entryPaths: [path.join(EXTENSIONS_DIR, filename), this.getWorkspaceEntryPath(filename)],
      containerDir: this.getWorkspaceDir(filename),
      containerRoot: EXTENSION_WORKSPACES_DIR,
    })
  }

  private resolveExtensionSourcePath(filename: string): string {
    return resolveExtensionSourcePath(filename)
  }

  private async runDependencyInstall(packageManager: ExtensionPackageManager, cwd: string): Promise<void> {
    const { command, args } = getInstallCommand(packageManager)

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      let stdout = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`${command} install timed out after ${Math.round(EXTENSION_INSTALL_TIMEOUT_MS / 1000)}s`))
      }, EXTENSION_INSTALL_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = trimProcessOutput(`${stdout}${chunk.toString()}`)
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = trimProcessOutput(`${stderr}${chunk.toString()}`)
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`${command} is not installed on this machine`))
          return
        }
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(trimProcessOutput(`${stderr}\n${stdout}`) || `${command} install exited ${code}`))
      })
    })
  }

  private canonicalExtensionId(id: string): string {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    if (!trimmed) return ''
    if (this.isExternalExtensionFilename(trimmed)) return path.basename(trimmed)
    return canonicalizeExtensionId(trimmed)
  }

  private configIdsFor(id: string): string[] {
    const canonicalId = this.canonicalExtensionId(id)
    if (!canonicalId) return []
    if (this.isExternalExtensionFilename(canonicalId)) return [canonicalId]
    const aliases = getExtensionAliases(canonicalId)
    const ids = new Set<string>([canonicalId, ...aliases])
    return Array.from(ids)
  }

  private readConfigEntry(id: string, config?: Record<string, ExtensionConfigEntry>): ExtensionConfigEntry | null {
    const cfg = config || this.loadConfig()
    let merged: ExtensionConfigEntry | null = null
    for (const key of this.configIdsFor(id)) {
      const entry = cfg[key]
      if (!entry) continue
      merged = { ...(merged || {}), ...entry }
      if (key === this.canonicalExtensionId(id)) break
    }
    return merged
  }

  private writeConfig(config: Record<string, ExtensionConfigEntry>): void {
    fs.writeFileSync(EXTENSIONS_CONFIG, JSON.stringify(config, null, 2))
  }

  private updateConfigEntry(id: string, patch: ExtensionConfigEntry | null): void {
    const canonicalId = this.canonicalExtensionId(id)
    const config = this.loadConfig()
    for (const key of this.configIdsFor(canonicalId)) {
      if (key !== canonicalId) delete config[key]
    }
    if (patch) {
      config[canonicalId] = { ...(config[canonicalId] || {}), ...patch }
    } else {
      delete config[canonicalId]
    }
    this.writeConfig(config)
  }

  private resolveEnabledFilter(enabledIds?: string[], includeAllWhenEmpty = false): Set<string> | null {
    if (!Array.isArray(enabledIds) || enabledIds.length === 0) {
      return includeAllWhenEmpty ? null : new Set<string>()
    }
    return new Set(expandExtensionIds(enabledIds))
  }

  private readFailureState(): Record<string, ExtensionFailureRecord> {
    try {
      const parsed = JSON.parse(fs.readFileSync(EXTENSION_FAILURES, 'utf8')) as Record<string, ExtensionFailureRecord>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      // Prune records older than 7 days
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000
      const now = Date.now()
      let pruned = false
      for (const key of Object.keys(parsed)) {
        if (now - (parsed[key].lastFailedAt || 0) > maxAgeMs) {
          delete parsed[key]
          pruned = true
        }
      }
      if (pruned) this.writeFailureState(parsed)
      return parsed
    } catch {
      return {}
    }
  }

  private writeFailureState(state: Record<string, ExtensionFailureRecord>): void {
    try {
      fs.writeFileSync(EXTENSION_FAILURES, JSON.stringify(state, null, 2))
    } catch (err: unknown) {
      log.warn('extensions', 'Failed to persist extension failure state', { error: errorMessage(err) })
    }
  }

  private clearFailureState(id: string): void {
    const state = this.readFailureState()
    let changed = false
    for (const key of this.configIdsFor(id)) {
      if (!state[key]) continue
      delete state[key]
      changed = true
    }
    if (!changed) return
    this.writeFailureState(state)
  }

  private autoDisableExternalExtension(id: string, reason: string, failure: ExtensionFailureRecord): void {
    try {
      const current = this.readConfigEntry(id)
      if (current?.enabled === false) return
      this.updateConfigEntry(id, { ...(current || {}), enabled: false })
    } catch (err: unknown) {
      log.error('extensions', 'Failed to write extensions config while auto-disabling extension', {
        extensionId: id,
        error: errorMessage(err),
      })
      return
    }
    this.loaded = false

    log.error('extensions', 'Auto-disabled extension after repeated failures', {
      extensionId: id,
      failureCount: failure.count,
      threshold: MAX_CONSECUTIVE_EXTENSION_FAILURES,
      reason,
      lastError: failure.lastError,
      stage: failure.lastStage,
    })

    createNotification({
      type: 'warning',
      title: `Extension auto-disabled: ${id}`,
      message: `${reason}. It failed ${failure.count} times consecutively and was disabled for stability.`,
      actionLabel: 'Open Extensions',
      actionUrl: '/extensions',
      entityType: 'extension',
      entityId: id,
      dedupKey: `extension-auto-disabled:${id}`,
    })
    notify('extensions')
  }

  /**
   * Records a failure against an extension.
   *
   * `countsAsFailure` is false only for something that is not the extension's
   * fault -- today, an import of a file an operator removed mid-reload. Such an
   * event is still written down so the error is visible on the extension's
   * card, but it neither advances the consecutive-failure count nor can trip
   * the auto-disable threshold, and the next genuine failure counts from where
   * the run of real failures actually stood.
   */
  private markExtensionFailure(id: string, stage: string, err: unknown, countsAsFailure: boolean): void {
    const errorText = errorMessage(err)
    const state = this.readFailureState()
    const failureKey = this.canonicalExtensionId(id)
    const previousCount = state[failureKey]?.count || 0
    const nextCount = countsAsFailure ? previousCount + 1 : previousCount
    const record: ExtensionFailureRecord = {
      count: nextCount,
      lastError: errorText,
      lastStage: stage,
      lastFailedAt: Date.now(),
    }
    state[failureKey] = record
    this.writeFailureState(state)

    log.warn('extensions', 'Extension failure recorded', {
      extensionId: id,
      stage,
      failureCount: nextCount,
      threshold: MAX_CONSECUTIVE_EXTENSION_FAILURES,
      error: errorText,
    })

    if (
      countsAsFailure
      && nextCount >= MAX_CONSECUTIVE_EXTENSION_FAILURES
      && !this.builtins.has(failureKey)
    ) {
      this.autoDisableExternalExtension(failureKey, `Extension failure at ${stage}`, record)
    }
  }

  private markExtensionSuccess(id: string): void {
    try {
      this.clearFailureState(id)
    } catch (err: unknown) {
      log.warn('extensions', 'markExtensionSuccess failed', { error: errorMessage(err), extensionId: id })
    }
  }

  /** The enabled external extension filenames this host should have modules for. */
  private enabledExternalFilenames(config: Record<string, ExtensionConfigEntry>): string[] {
    return this.listExtensionFilenames().filter((file) => this.readConfigEntry(file, config)?.enabled !== false)
  }

  /**
   * Imports every enabled external extension for the given generation.
   *
   * Nothing here touches the manager's own state: it returns a map, which the
   * caller swaps in. That is what lets `reload` invalidate and rebuild without
   * ever awaiting in between, so no synchronous reader can observe a host with
   * its extensions momentarily missing.
   *
   * An extension whose import throws is recorded as a failure rather than
   * omitted. `loadOnce` needs to tell "this file was tried and is broken" from
   * "this file has not been tried yet"; only the second means the module map is
   * not usable yet.
   *
   * An extension whose import never settles is recorded the same way, once
   * `extensionImportTimeoutMs` has passed. The loop is serial and the boot
   * path awaits it, so without that deadline one hanging entry module was
   * enough to keep the HTTP listener from ever binding; see the constant.
   */
  private async acquireExternalModules(generation: number): Promise<Map<string, ExternalModuleRecord>> {
    const acquired = new Map<string, ExternalModuleRecord>()
    let config: Record<string, ExtensionConfigEntry>
    try {
      this.ensureExtensionDirs()
      config = this.loadConfig()
    } catch {
      return acquired
    }
    const dynamicRequire = createExtensionRequire()
    if (!dynamicRequire) return acquired

    if (!ensureExtensionResolveHooks()) {
      // Degraded, not broken: an edited extension's own entry file still
      // re-executes on reload, but the modules it imports keep the copies Node
      // already holds, so an edit confined to those does not take effect until
      // the process restarts. Worth a line in the log because the symptom
      // otherwise looks like a reload that silently did nothing.
      log.warn('extensions', 'Extension module resolve hooks unavailable; reload will not re-execute imported extension files')
    }

    for (const file of this.enabledExternalFilenames(config)) {
      // Evicted immediately before the import, and only for this file: a
      // CommonJS extension is served from require.cache underneath `import()`
      // unless its entry is gone from there first.
      this.clearExtensionRequireCache(dynamicRequire, file)
      // The workspace entry when there is a workspace, the file in the
      // extensions directory otherwise -- the same path `readExtensionSource`
      // shows the operator, rather than the generated shim that stands in for
      // it. The shim's own module format is then irrelevant to loading, which
      // matters because a `.js` shim over an ESM workspace entry has no valid
      // re-export form at all (see `writeWorkspaceShim`). Loading the entry
      // directly removes that, and removes a difference between the runtimes
      // the product ships on with it.
      //
      // Resolved once, so the path this import names is the path the failure
      // below reports.
      const sourcePath = this.resolveExtensionSourcePath(file)
      try {
        const namespace = await importWithDeadline(importExtensionModule(sourcePath, generation), file, extensionImportTimeoutMs())
        acquired.set(file, { ok: true, namespace })
      } catch (err: unknown) {
        // An extension whose file an operator removed while the host was
        // reading it fails here, and counting that as a failure of the
        // extension would push a perfectly healthy reinstall toward
        // auto-disable on nothing but timing.
        //
        // Asked through `extensionSourceIsMissing` rather than by testing
        // `sourcePath`, because for a workspace-backed extension mid-reinstall
        // those are two different files: the entry is the one that is gone, and
        // once it is gone `resolveExtensionSourcePath` falls back to the
        // extensions-dir shim, which is still present. Testing the resolved
        // path therefore reported "not vanished" in exactly the case this flag
        // exists for.
        const vanished = extensionSourceIsMissing(file)
        acquired.set(file, { ok: false, error: err, vanished })
      }
    }
    return acquired
  }

  /**
   * Synchronous load. Registers builtins always, and external extensions only
   * from modules already acquired.
   *
   * When an enabled external extension has no acquired module this returns
   * without marking the manager loaded, so the next call tries again once
   * acquisition has finished. It deliberately does not register the extensions
   * it *does* have: a partial load followed by a full one would call every
   * already-registered extension's `setup()` twice for a single boot, and
   * `setup()` is where extensions do their one-time work.
   */
  load() {
    if (this.loaded) return
    this.loading = true
    try {
      this.loadOnce()
    } finally {
      this.loading = false
    }
  }

  /**
   * Loads, acquiring external extension modules first.
   *
   * This is the entry point the server boot path awaits (see
   * `src/instrumentation.ts`). It exists because an extension module can only
   * be obtained with `import()`: `load()` alone cannot produce a host with
   * external extensions on a cold process, no matter how many times it is
   * called.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    const acquired = await this.acquireExternalModules(this.moduleGeneration)
    this.externalModules = acquired
    this.loading = true
    try {
      this.loadOnce()
    } finally {
      this.loading = false
    }
  }

  private loadOnce() {
    this.extensions.clear()
    this.ensureExtensionWatcher()

    const config = this.loadConfig()

    // 1. Load Built-ins
    for (const [id, p] of this.builtins.entries()) {
      const explicitConfig = this.readConfigEntry(id, config)
      const isEnabled = explicitConfig != null ? explicitConfig.enabled !== false : p.enabledByDefault !== false
      if (isEnabled) {
        // The builtin branch does not run migrations, does not call setup() and
        // does not register rpc handlers. Say so at load time rather than let a
        // builtin fail later with "no such table".
        const ignoredByBuiltinLoader: string[] = []
        if (typeof p.setup === 'function') ignoredByBuiltinLoader.push('setup')
        if (p.migrations && p.migrations.length > 0) ignoredByBuiltinLoader.push('migrations')
        if (p.rpc && Object.keys(p.rpc).length > 0) ignoredByBuiltinLoader.push('rpc')
        if (p.provides && Object.keys(p.provides).length > 0) ignoredByBuiltinLoader.push('provides')
        if (p.consumes && p.consumes.length > 0) ignoredByBuiltinLoader.push('consumes')
        if (ignoredByBuiltinLoader.length > 0) {
          log.warn('extensions', 'Builtin extension declares fields the builtin loader ignores', {
            extensionId: id,
            ignored: ignoredByBuiltinLoader.join(', '),
          })
        }

        this.extensions.set(id, {
          id,
          meta: {
            name: p.name,
            description: p.description || '',
            filename: id,
            enabled: true,
            author: p.author || 'SwarmClaw',
            version: p.version || '1.0.0',
            source: 'local',
            sourceLabel: 'builtin',
            installSource: 'builtin',
            openclaw: p.openclaw === true,
          },
          hooks: buildExtensionHooks(id, p.name, p.hooks, p.tools),
          tools: p.tools || [],
          ui: p.ui,
          providers: p.providers,
          connectors: p.connectors,
          managedResources: p.managedResources || coerceManagedResources(p as unknown as Record<string, unknown>),
          isBuiltin: true
        })
        this.markExtensionSuccess(id)
      }
    }

    // 2. Load External
    try {
      this.ensureExtensionDirs()
      const files = this.enabledExternalFilenames(config)
      this.syncWorkspaceWatchers(files)

      // Every enabled file must already have an acquisition result. One that
      // does not means acquisition has not run yet for this generation, and
      // there is no synchronous way to run it: `import()` is async. Bail
      // without marking the manager loaded rather than report a host that has
      // no external extensions, and rather than register half of them and call
      // the other half's setup() a second time on the next pass.
      const unacquired = files.filter((file) => !this.externalModules.has(file))
      if (unacquired.length > 0) {
        if (!this.warnedAboutColdLoad) {
          this.warnedAboutColdLoad = true
          log.warn('extensions', 'External extensions read before they were loaded; awaiting ensureLoaded()', {
            extensionIds: unacquired.join(', '),
          })
        }
        return
      }

      for (const file of files) {
        try {
          const explicitConfig = this.readConfigEntry(file, config)

          const record = this.externalModules.get(file)
          if (!record) continue
          if (!record.ok) {
            log.error('extensions', 'Failed to load external extension', {
              extensionId: file,
              error: errorMessage(record.error),
            })
            this.markExtensionFailure(file, 'load.require', record.error, !record.vanished)
            continue
          }
          const ext = normalizeExtension(extensionModuleExport(record.namespace))
          if (!ext) {
            this.markExtensionFailure(file, 'load.normalize', 'Extension format unsupported or activate() failed', true)
            continue
          }

          const takenPaths = new Set<string>()
          for (const other of this.extensions.values()) {
            for (const page of other.ui?.pages || []) takenPaths.add(page.path)
          }
          const pagesCheck = validateExtensionPages(ext.ui?.pages, takenPaths)
          if (!pagesCheck.ok) {
            this.markExtensionFailure(file, 'load.ui_pages', pagesCheck.error, true)
            continue
          }
          if (ext.ui) ext.ui.pages = pagesCheck.pages

          // Contract declarations are checked here, alongside the pages, and
          // for the same reason: a declaration the author got wrong should
          // fail the load rather than resolve to nothing at call time. A
          // consumption whose provider is absent is NOT checked here — that
          // is answered with null at call time, so an unmet dependency never
          // stops the consumer from loading.
          const contractsCheck = validateExtensionContracts(file, ext.provides, ext.consumes)
          if (!contractsCheck.ok) {
            this.markExtensionFailure(file, 'load.contracts', contractsCheck.error, true)
            continue
          }
          // Remembered before setup() and before the extension is registered:
          // the operator's audit surface should show what an extension asked
          // for even when it went on to fail, and should keep showing it once
          // the extension is switched off. See `lastKnownContracts`.
          this.lastKnownContracts.set(file, contractsCheck.declarations)

          // Storage and setup run before the extension is registered, so an
          // extension whose schema or setup fails never becomes reachable.
          try {
            runExtensionMigrations(file, ext.migrations)
            if (ext.setup) {
              ext.setup({
                extensionId: file,
                tablePrefix: extensionTablePrefix(file),
                storage: createExtensionStorage(file),
                // Not this.getExtensionSettings(file): setup() runs inside
                // load(), before this.loaded is set, so that path re-enters
                // load() through getSettingsFields and recurses until the
                // stack is exhausted, re-running every extension's setup and
                // migrations at each level. The fields are already in hand
                // here — they are this extension's own declarations, the same
                // list getSettingsFields would return once it is registered
                // — and the values are read fresh on every call, so a later
                // call still sees settings edited since load.
                settings: () => this.applyDeclaredSettingsDefaults(
                  this.readStoredExtensionSettings(file),
                  ext.ui?.settingsFields || [],
                ),
                log: {
                  info: (msg, meta) => log.info(`extension:${ext.name}`, msg, meta),
                  warn: (msg, meta) => log.warn(`extension:${ext.name}`, msg, meta),
                  error: (msg, meta) => log.error(`extension:${ext.name}`, msg, meta),
                },
                oauth: {
                  getGoogleAccessToken: (purpose) => getGoogleAccessToken(purpose),
                  hasGoogleCredential: (purpose) => hasGoogleCredential(purpose),
                },
                // Safe to capture in setup(): the lookup runs when it is
                // called, not now, so an extension that stores this and asks
                // later sees the machine as it is then. See
                // extensions/extension-binaries.ts for what it will and will
                // not answer.
                resolveBinary: createExtensionBinaryResolver(),
                // Two closures, nothing resolved yet. Safe to capture, and
                // safe to build here even though the extension is not
                // registered yet: the consumer's own declarations are read
                // live at call time, from the record set below.
                contracts: this.getExtensionContracts(file),
              })
            }
          } catch (err: unknown) {
            this.markExtensionFailure(file, 'load.setup', err, true)
            continue
          }

          this.extensions.set(file, {
            id: file,
            meta: {
              name: ext.name,
              description: ext.description || '',
              filename: file,
              enabled: true,
              author: ext.author,
              version: ext.version || '0.0.1',
              source: inferStoredExtensionSource(explicitConfig),
              sourceLabel: inferStoredPublisherSource(explicitConfig),
              installSource: inferStoredInstallSource(explicitConfig),
              sourceUrl: explicitConfig?.sourceUrl,
              openclaw: ext.openclaw === true,
            },
            hooks: buildExtensionHooks(file, ext.name, ext.hooks, ext.tools),
            tools: ext.tools || [],
            ui: ext.ui,
            providers: ext.providers,
            connectors: ext.connectors,
            managedResources: ext.managedResources,
            rpc: ext.rpc,
            contracts: contractsCheck.declarations,
          })
          this.markExtensionSuccess(file)
        } catch (err: unknown) {
          log.error('extensions', 'Failed to load external extension', {
            extensionId: file,
            error: errorMessage(err),
          })
          this.markExtensionFailure(file, 'load.require', err, true)
        }
      }
    } catch { /* ignore */ }

    this.loaded = true
    this.warnOnAmbiguousContractProviderIds()
  }

  /**
   * Contract ids drop the file extension, so 'notes.js' and 'notes.mjs' both
   * answer to 'notes'. `resolveExtensionContract` refuses to pick between them
   * and reports `provider_missing`, which is correct but says nothing about
   * why. This is the line that says why, and it is logged once per load rather
   * than once per call because the operator, not the consumer, is the one who
   * can fix it by renaming or removing a file.
   */
  private warnOnAmbiguousContractProviderIds(): void {
    const byNormalizedId = new Map<string, string[]>()
    for (const [id, entry] of this.extensions.entries()) {
      if (!entry.contracts || Object.keys(entry.contracts.provides).length === 0) continue
      const normalized = normalizeContractExtensionId(id)
      const ids = byNormalizedId.get(normalized) || []
      ids.push(id)
      byNormalizedId.set(normalized, ids)
    }
    for (const [normalized, ids] of byNormalizedId.entries()) {
      if (ids.length < 2) continue
      log.warn('extensions', 'Contract provider id is ambiguous; no contract from these extensions can be consumed', {
        contractExtensionId: normalized,
        extensionIds: ids.join(', '),
      })
    }
  }

  /**
   * Look up one server-side method an extension exposes to its own browser UI.
   *
   * Returns `null` for every reason a call cannot be served — the extension is
   * not installed, is disabled, declares no `rpc` map, or has no such method —
   * so a caller cannot tell an installed-but-disabled extension from one that
   * was never installed. That is deliberate: the caller has no business
   * probing which extensions exist on this host.
   *
   * `load()` already skips disabled extensions, so the `isExplicitlyDisabled`
   * check below is redundant today. It stays because it is the only line that
   * would still hold if the map ever kept disabled entries (for a settings
   * screen, say); it is cheap and reads off the config file, not the map.
   *
   * Only external extensions have handlers here: the builtin branch of `load()`
   * does not carry `rpc` onto the loaded record, and warns when a builtin
   * declares one.
   *
   * The own-property check is what makes the paragraph above true. `rpc` is an
   * ordinary object literal from the extension module, so a plain `rpc[method]`
   * walks `Object.prototype` and finds `constructor`, `toString`, `valueOf` and
   * `hasOwnProperty` — all functions, all callable, none of them a method the
   * extension declared. Beyond running code nobody exposed, that turned this
   * lookup into the very probe it promises not to be: `constructor` answered
   * for an installed extension and not for a missing one.
   */
  getRpcHandler(extensionId: string, method: string): ExtensionRpcHandler | null {
    this.load()
    const ext = this.extensions.get(extensionId)
    if (!ext || this.isExplicitlyDisabled(extensionId)) return null
    const rpc = ext.rpc
    if (!rpc || !Object.prototype.hasOwnProperty.call(rpc, method)) return null
    const handler = rpc[method]
    return typeof handler === 'function' ? handler : null
  }

  /**
   * The view of the loaded extension map that contract resolution needs.
   *
   * `ensureLoaded` deliberately does nothing while a load is in progress: the
   * only caller that can hit that case is an extension resolving a contract
   * from inside its own setup(), and re-entering load() there recurses (see the
   * `loading` field). The cost is that such a call sees only the extensions
   * loaded so far and can read `provider_missing` for one that is loaded a
   * moment later; resolving lazily instead of in setup() avoids it entirely,
   * which is what `createExtensionContracts` tells extension authors to do.
   */
  private contractRegistry(): ExtensionContractRegistry {
    return {
      ensureLoaded: () => {
        if (!this.loaded && !this.loading) this.load()
      },
      declarationsOf: (loadedId: string) => this.extensions.get(loadedId)?.contracts ?? null,
      providersFor: (normalizedId: string) => {
        const matches: ContractProviderEntry[] = []
        for (const [id, entry] of this.extensions.entries()) {
          if (!entry.contracts) continue
          if (normalizeContractExtensionId(id) !== normalizedId) continue
          matches.push({ id, declarations: entry.contracts })
        }
        return matches
      },
      // "Installed" is what separates provider_disabled from provider_missing,
      // so it must answer for extensions that are NOT in the loaded map: the
      // directory listing, not the map, is the source of truth for what exists
      // on this host.
      //
      // Builtins are deliberately not counted, even though an extension with
      // that id does exist. The builtin branch of load() carries no contracts
      // onto the record and warns when a builtin declares `provides`, so a
      // builtin can never answer a contract. Counting it would report
      // `provider_disabled` — "switch it on and this works" — for a
      // consumption that no operator action can ever satisfy, and it would go
      // on saying that with the builtin already enabled. `provider_missing` is
      // the truthful answer and the actionable one: nothing on this host
      // provides that contract, and the way to change it is to install an
      // external extension of that name, which this same listing then finds.
      isInstalled: (normalizedId: string) => {
        for (const file of this.listExtensionFilenames()) {
          if (normalizeContractExtensionId(file) === normalizedId) return true
        }
        return false
      },
    }
  }

  /**
   * The `ctx.contracts` for one extension. Resolution is lazy, so this is safe
   * to build during load() for an extension that is not registered yet, and
   * safe for the extension to capture: the extension map is read live on every
   * call, so disabling or deleting the provider takes effect through a handle
   * captured before it, regardless of module format.
   *
   * Editing a declaration takes effect on the next reload, in both module
   * formats: `reload()` re-imports the file under a new generation-stamped
   * module URL, which is what makes Node evaluate an ESM file again, and evicts
   * CommonJS entries from `require.cache` alongside it. So a `consumes` entry
   * removed on disk stops appearing on the operator's card and stops being
   * served after the reload, without a process restart. See
   * `callContractMethod` in ./extensions/extension-contracts.
   *
   * Private because it mints a contracts object for whatever consumer id it is
   * handed, with that id baked into every call it will ever make. Called from
   * outside it is a per-consumer impersonation factory, and this manager is
   * reachable from extension code through the HMR singleton in
   * `src/lib/shared-utils.ts`. TypeScript `private` is a compile-time boundary,
   * not a runtime one, and this process is not a sandbox — an extension can
   * still reach in, exactly as it can already reach the database. What the
   * keyword removes is the host offering it.
   */
  private getExtensionContracts(consumerId: string): ExtensionContracts {
    return createExtensionContracts(consumerId, this.contractRegistry())
  }

  getTools(enabledIds: string[]): Array<{ extensionId: string; tool: ExtensionToolDef }> {
    this.load()
    const all: Array<{ extensionId: string; tool: ExtensionToolDef }> = []
    const ids = new Set(expandExtensionIds(enabledIds))
    for (const [id, p] of this.extensions.entries()) {
      if (ids.has(id)) {
        const tools = Array.isArray(p.tools) ? p.tools : []
        for (const t of tools) {
          if (!t || typeof t.name !== 'string' || typeof t.execute !== 'function') continue
          all.push({ extensionId: id, tool: t })
        }
      }
    }
    return all
  }

  getExternalTools(): ExtensionToolDef[] {
    return this.getExternalToolEntries().map((entry) => entry.tool)
  }

  getExternalToolEntries(): ExternalExtensionToolEntry[] {
    this.load()
    const all: ExternalExtensionToolEntry[] = []
    for (const p of this.extensions.values()) {
      if (p.isBuiltin) continue
      const extensionTools = Array.isArray(p.tools) ? p.tools : []
      for (const tool of extensionTools) {
        if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') continue
        all.push({
          extensionId: p.id,
          extensionName: p.meta.name,
          tool,
        })
      }
    }
    return all
  }

  getProviders(): ExtensionProviderDefinition[] {
    this.load()
    const allProviders: ExtensionProviderDefinition[] = []
    for (const p of this.extensions.values()) {
      if (p.providers) allProviders.push(...p.providers)
    }
    return allProviders
  }

  getConnectors(): ExtensionConnectorDefinition[] {
    this.load()
    const allConnectors: ExtensionConnectorDefinition[] = []
    for (const p of this.extensions.values()) {
      if (p.connectors) allConnectors.push(...p.connectors)
    }
    return allConnectors
  }

  getUIExtensions(): ExtensionUIDefinition[] {
    this.load()
    const allUI: ExtensionUIDefinition[] = []
    for (const p of this.extensions.values()) {
      if (p.ui) allUI.push(p.ui)
    }
    return allUI
  }

  getPages(): Array<ExtensionPageDefinition & { extensionId: string }> {
    this.load()
    const out: Array<ExtensionPageDefinition & { extensionId: string }> = []
    for (const p of this.extensions.values()) {
      for (const page of p.ui?.pages || []) out.push({ ...page, extensionId: p.id })
    }
    return out
  }

  getManagedResourceExtensions(): Array<{
    extensionId: string
    extensionName: string
    enabled: boolean
    isBuiltin: boolean
    source?: ExtensionMeta['source']
    managedResources: ExtensionManagedResources
  }> {
    this.load()
    const result: Array<{
      extensionId: string
      extensionName: string
      enabled: boolean
      isBuiltin: boolean
      source?: ExtensionMeta['source']
      managedResources: ExtensionManagedResources
    }> = []

    for (const [id, entry] of this.extensions.entries()) {
      const managedResources = entry.managedResources
      if (!managedResources) continue
      if (!Object.values(managedResources).some((value) => Array.isArray(value) && value.length > 0)) continue
      result.push({
        extensionId: id,
        extensionName: entry.meta.name,
        enabled: entry.meta.enabled,
        isBuiltin: entry.isBuiltin === true,
        source: entry.meta.source,
        managedResources,
      })
    }

    return result
  }

  getManagedResources(extensionId: string): ExtensionManagedResources | null {
    this.load()
    const candidateIds = expandExtensionIds([extensionId])
    for (const id of candidateIds) {
      const loaded = this.extensions.get(id)
      if (loaded?.managedResources) return loaded.managedResources
      const builtin = this.builtins.get(id)
      if (builtin) {
        return builtin.managedResources || coerceManagedResources(builtin as unknown as Record<string, unknown>) || null
      }
    }
    return null
  }

  listExtensionIds(): string[] {
    this.load()
    return Array.from(this.extensions.keys())
  }

  async runHook<K extends keyof ExtensionHooks>(hookName: K, ctx: HookContext<K>, options?: HookExecutionOptions) {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks[hookName]
      if (hook) {
        try {
          await (hook as (hookCtx: HookContext<K>) => Promise<unknown> | unknown)(ctx)
          this.markExtensionSuccess(id)
        } catch (err: unknown) {
          log.error('extensions', 'Extension hook failed', {
            extensionId: id,
            extensionName: p.meta.name,
            hookName: String(hookName),
            error: errorMessage(err),
          })
          this.markExtensionFailure(id, `hook.${String(hookName)}`, err, true)
        }
      }
    }
  }

  async runBeforePromptBuild(
    params: {
      session: Session
      prompt: string
      message: string
      history: import('@/types').Message[]
      messages: import('@/types').Message[]
    },
    options?: HookExecutionOptions,
  ): Promise<ExtensionPromptBuildResult | null> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let result: ExtensionPromptBuildResult | undefined

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.beforePromptBuild
      if (!hook) continue
      try {
        const next = await hook(params)
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          result = mergePromptBuildResults(result, next as ExtensionPromptBuildResult)
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'beforePromptBuild hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.beforePromptBuild', err, true)
      }
    }

    return result || null
  }

  async runBeforeModelResolve(
    params: {
      session: Session
      prompt: string
      message: string
      provider: Session['provider']
      model: string
      apiEndpoint?: string | null
    },
    options?: HookExecutionOptions,
  ): Promise<ExtensionModelResolveResult | null> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let result: ExtensionModelResolveResult | undefined

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.beforeModelResolve
      if (!hook) continue
      try {
        const next = await hook(params)
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          result = mergeModelResolveResults(result, next as ExtensionModelResolveResult)
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'beforeModelResolve hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.beforeModelResolve', err, true)
      }
    }

    return result || null
  }

  async runBeforeToolCall(
    params: {
      session: Session
      toolName: string
      input: Record<string, unknown> | null
      runId?: string
      toolCallId?: string
    },
    options?: HookExecutionOptions,
  ): Promise<{ input: Record<string, unknown> | null; blockReason: string | null; warning: string | null }> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentInput = params.input
    let blockReason: string | null = null
    let warning: string | null = null

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue

      const beforeToolCall = p.hooks.beforeToolCall
      if (beforeToolCall) {
        try {
          const result = await beforeToolCall({
            session: params.session,
            toolName: params.toolName,
            input: currentInput,
            runId: params.runId,
            toolCallId: params.toolCallId,
          })

          if (isToolCallControlResult(result)) {
            if (result.block === true) {
              blockReason = typeof result.blockReason === 'string' && result.blockReason.trim()
                ? result.blockReason.trim()
                : 'Tool call blocked by extension hook'
            }
            if (typeof result.warning === 'string' && result.warning.trim()) {
              warning = result.warning.trim()
            }
            currentInput = mergeToolCallInput(
              currentInput,
              isRecord(result.params)
                ? result.params
                : isRecord(result.input)
                  ? result.input
                  : result.input === null
                    ? null
                    : undefined,
            )
          } else if (result && typeof result === 'object' && !Array.isArray(result)) {
            currentInput = result as Record<string, unknown>
          }
          this.markExtensionSuccess(id)
        } catch (err: unknown) {
          log.error('extensions', 'beforeToolCall hook failed', {
            extensionId: id,
            extensionName: p.meta.name,
            toolName: params.toolName,
            error: errorMessage(err),
          })
          this.markExtensionFailure(id, 'hook.beforeToolCall', err, true)
        }
      }

      const beforeToolExec = p.hooks.beforeToolExec
      if (blockReason) break
      if (!beforeToolExec) {
        continue
      }
      try {
        const legacyResult = await beforeToolExec({ toolName: params.toolName, input: currentInput })
        if (legacyResult && typeof legacyResult === 'object' && !Array.isArray(legacyResult)) {
          currentInput = legacyResult as Record<string, unknown>
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'beforeToolExec hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          toolName: params.toolName,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.beforeToolExec', err, true)
      }

      if (blockReason) break
    }

    return { input: currentInput, blockReason, warning }
  }

  async runToolResultPersist(
    params: {
      session: Session
      message: Message
      toolName?: string
      toolCallId?: string
      isSynthetic?: boolean
    },
    options?: HookExecutionOptions,
  ): Promise<Message> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentMessage = params.message

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.toolResultPersist
      if (!hook) continue
      try {
        const result = await hook({
          session: params.session,
          message: currentMessage,
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          isSynthetic: params.isSynthetic,
        })
        if (isMessageLike(result)) {
          currentMessage = result
        } else if (isRecord(result) && isMessageLike(result.message)) {
          currentMessage = result.message
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'toolResultPersist hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.toolResultPersist', err, true)
      }
    }

    return currentMessage
  }

  async runBeforeMessageWrite(
    params: {
      session: Session
      message: Message
      phase?: 'user' | 'system' | 'assistant_partial' | 'assistant_final' | 'heartbeat'
      runId?: string
    },
    options?: HookExecutionOptions,
  ): Promise<{ message: Message; block: boolean }> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentMessage = params.message
    let block = false

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.beforeMessageWrite
      if (!hook) continue
      try {
        const result = await hook({
          session: params.session,
          message: currentMessage,
          phase: params.phase,
          runId: params.runId,
        })
        if (isMessageLike(result)) {
          currentMessage = result
        } else if (isBeforeMessageWriteResult(result)) {
          if (isMessageLike(result.message)) currentMessage = result.message
          if (result.block === true) {
            block = true
            this.markExtensionSuccess(id)
            break
          }
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'beforeMessageWrite hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.beforeMessageWrite', err, true)
      }
    }

    return { message: currentMessage, block }
  }

  async runSubagentSpawning(
    params: {
      parentSessionId?: string | null
      agentId: string
      agentName: string
      message: string
      cwd: string
      mode: 'run' | 'session'
      threadRequested: boolean
    },
    options?: HookExecutionOptions,
  ): Promise<ExtensionSubagentSpawningResult> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.subagentSpawning
      if (!hook) continue
      try {
        const result = await hook(params)
        if (isSubagentSpawningResult(result) && result.status === 'error') {
          this.markExtensionSuccess(id)
          return {
            status: 'error',
            error: typeof result.error === 'string' && result.error.trim()
              ? result.error.trim()
              : 'Subagent spawn blocked by extension hook',
          }
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'subagentSpawning hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.subagentSpawning', err, true)
      }
    }

    return { status: 'ok' }
  }

  async runBeforeToolExec(
    params: { toolName: string; input: Record<string, unknown> | null },
    options?: HookExecutionOptions,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.runBeforeToolCall(
      {
        session: {
          id: 'extension-hook-session',
          name: 'Extension Hook Session',
          cwd: process.cwd(),
          user: 'system',
          // Synthetic fallback used only when no real session context is available.
          provider: 'openai',
          model: 'synthetic-hook-context',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        },
        toolName: params.toolName,
        input: params.input,
      },
      options,
    )
    return result.input
  }

  async transformText(
    hookName: 'transformInboundMessage' | 'transformOutboundMessage',
    params: { session: Session; text: string },
    options?: HookExecutionOptions,
  ): Promise<string> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentText = params.text

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks[hookName]
      if (hook) {
        try {
          const result = await (hook as (ctx: typeof params) => Promise<string> | string)({ ...params, text: currentText })
          if (typeof result === 'string') currentText = result
          this.markExtensionSuccess(id)
        } catch (err: unknown) {
          log.error('extensions', 'Extension transform hook failed', {
            extensionId: id,
            extensionName: p.meta.name,
            hookName,
            error: errorMessage(err),
          })
          this.markExtensionFailure(id, `hook.${String(hookName)}`, err, true)
        }
      }
    }
    return currentText
  }

  async collectAgentContext(session: import('@/types').Session, enabledExtensions: string[], message: string, history: import('@/types').Message[]): Promise<string[]> {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const parts: string[] = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getAgentContext
      if (!hook) continue
      try {
        const result = await hook({ session, enabledExtensions, message, history })
        if (typeof result === 'string' && result.trim()) {
          parts.push(result)
          this.markExtensionSuccess(id)
        }
      } catch (err: unknown) {
        log.error('extensions', 'getAgentContext hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.getAgentContext', err, true)
      }
    }

    return parts
  }

  /** Collect capability descriptions from all enabled extensions for system prompt */
  collectCapabilityDescriptions(enabledExtensions: string[]): string[] {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const lines: string[] = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getCapabilityDescription
      if (!hook) continue
      try {
        const result = hook()
        if (typeof result === 'string' && result.trim()) {
          lines.push(`- ${result}`)
        }
      } catch (err: unknown) {
        log.error('extensions', 'getCapabilityDescription hook failed', { extensionId: id, error: errorMessage(err) })
      }
    }

    return lines
  }

  /** Collect operating guidance from all enabled extensions */
  collectOperatingGuidance(enabledExtensions: string[]): string[] {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const lines: string[] = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getOperatingGuidance
      if (!hook) continue
      try {
        const result = hook()
        if (result === null || result === undefined) continue
        if (typeof result === 'string' && result.trim()) {
          lines.push(result)
        } else if (Array.isArray(result)) {
          for (const line of result) {
            if (typeof line === 'string' && line.trim()) lines.push(line)
          }
        }
      } catch (err: unknown) {
        log.error('extensions', 'getOperatingGuidance hook failed', { extensionId: id, error: errorMessage(err) })
      }
    }

    return lines
  }

  /** Collect approval guidance from all enabled extensions for a specific approval event */
  collectApprovalGuidance(
    enabledExtensions: string[],
    ctx: {
      approval: import('@/types').ApprovalRequest
      phase: 'request' | 'resume' | 'connector_reminder'
      approved?: boolean
    },
  ): string[] {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const lines: string[] = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getApprovalGuidance
      if (!hook) continue
      try {
        const result = hook(ctx)
        if (result === null || result === undefined) continue
        if (typeof result === 'string' && result.trim()) {
          lines.push(result)
        } else if (Array.isArray(result)) {
          for (const line of result) {
            if (typeof line === 'string' && line.trim()) lines.push(line)
          }
        }
      } catch (err: unknown) {
        log.error('extensions', 'getApprovalGuidance hook failed', {
          extensionId: id,
          error: errorMessage(err),
        })
      }
    }

    return lines
  }

  /** Collect all settings fields declared by enabled extensions */
  collectSettingsFields(enabledExtensions: string[]): Array<{ extensionId: string; extensionName: string; fields: import('@/types').ExtensionSettingsField[] }> {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const result: Array<{ extensionId: string; extensionName: string; fields: import('@/types').ExtensionSettingsField[] }> = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const fields = p.ui?.settingsFields
      if (fields?.length) {
        result.push({ extensionId: id, extensionName: p.meta.name, fields })
      }
    }

    return result
  }

  getSettingsFields(extensionId: string): import('@/types').ExtensionSettingsField[] {
    this.load()
    const candidateIds = expandExtensionIds([extensionId])
    for (const id of candidateIds) {
      const ext = this.extensions.get(id) || (this.builtins.has(id) ? {
        ui: this.builtins.get(id)?.ui,
      } as LoadedExtension : null)
      const fields = ext?.ui?.settingsFields
      if (fields?.length) return fields
    }
    return []
  }

  /**
   * The stored settings values of one extension, secrets decrypted, with no
   * declared-field defaults filled in and without touching this.load().
   *
   * Split out of getExtensionSettings so that setup(ctx) can be handed a
   * settings accessor that does not re-enter the loader. See the settings
   * accessor built in load().
   */
  private readStoredExtensionSettings(extensionId: string): Record<string, unknown> {
    const settings = loadSettings()
    const allSettings = (settings.extensionSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    const result: Record<string, unknown> = {}

    for (const key of this.configIdsFor(extensionId)) {
      const values = allSettings[key]
      if (!values || typeof values !== 'object') continue
      for (const [fieldKey, fieldValue] of Object.entries(values)) {
        if (isExtensionSecretSettingValue(fieldValue)) {
          try {
            result[fieldKey] = decryptKey(fieldValue.encrypted)
          } catch {
            result[fieldKey] = ''
          }
          continue
        }
        result[fieldKey] = fieldValue
      }
    }

    return result
  }

  /** Fills a stored-settings map with the defaults of the fields that declare one. */
  private applyDeclaredSettingsDefaults(
    values: Record<string, unknown>,
    fields: import('@/types').ExtensionSettingsField[],
  ): Record<string, unknown> {
    for (const field of fields) {
      if (values[field.key] === undefined && field.defaultValue !== undefined) {
        values[field.key] = field.defaultValue
      }
    }
    return values
  }

  getExtensionSettings(extensionId: string): Record<string, unknown> {
    return this.applyDeclaredSettingsDefaults(
      this.readStoredExtensionSettings(extensionId),
      this.getSettingsFields(extensionId),
    )
  }

  getPublicExtensionSettings(extensionId: string): { values: Record<string, unknown>; configuredSecretFields: string[] } {
    const values = this.getExtensionSettings(extensionId)
    const configuredSecretFields: string[] = []

    for (const field of this.getSettingsFields(extensionId)) {
      if (field.type !== 'secret') continue
      const current = values[field.key]
      if (typeof current === 'string' && current.trim()) {
        configuredSecretFields.push(field.key)
      }
      values[field.key] = ''
    }

    return { values, configuredSecretFields }
  }

  setExtensionSettings(extensionId: string, values: Record<string, unknown>): Record<string, unknown> {
    const fields = this.getSettingsFields(extensionId)
    if (fields.length === 0 && Object.keys(values || {}).length > 0) {
      throw new Error(`Extension "${extensionId}" does not declare configurable settings`)
    }
    const fieldMap = new Map(fields.map((field) => [field.key, field]))
    const nextValues: Record<string, unknown> = {}

    for (const [key, rawValue] of Object.entries(values || {})) {
      const field = fieldMap.get(key)
      if (!field) continue
      if (rawValue === undefined) continue
      if (field.type === 'boolean') {
        nextValues[key] = rawValue === true || rawValue === 'true' || rawValue === 1 || rawValue === '1'
        continue
      }
      if (field.type === 'number') {
        const parsed = typeof rawValue === 'number' ? rawValue : Number(rawValue)
        if (!Number.isFinite(parsed)) throw new Error(`Invalid number for setting "${key}"`)
        nextValues[key] = parsed
        continue
      }
      const text = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '')
      if (field.required && !text.trim()) throw new Error(`Setting "${key}" is required`)
      if (field.type === 'select' && field.options?.length) {
        const allowed = new Set(field.options.map((option) => option.value))
        if (!allowed.has(text)) throw new Error(`Invalid value for setting "${key}"`)
      }
      if (field.type === 'secret') {
        nextValues[key] = text.trim()
      } else {
        nextValues[key] = text
      }
    }

    const currentSettings = loadSettings()
    const settingsMap = (currentSettings.extensionSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    const canonicalId = this.canonicalExtensionId(extensionId)
    const existingStored: Record<string, unknown> = {}
    for (const alias of this.configIdsFor(canonicalId)) {
      const existing = settingsMap[alias]
      if (!existing || typeof existing !== 'object') continue
      Object.assign(existingStored, existing)
    }

    for (const field of fields) {
      if (!field.required) continue
      if (
        nextValues[field.key] === undefined
        && existingStored[field.key] === undefined
        && field.defaultValue === undefined
      ) {
        throw new Error(`Setting "${field.key}" is required`)
      }
    }

    const stored: Record<string, unknown> = {}

    for (const field of fields) {
      if (nextValues[field.key] === undefined) {
        if (existingStored[field.key] !== undefined) {
          stored[field.key] = existingStored[field.key]
        }
        continue
      }
      if (field.type === 'secret') {
        stored[field.key] = {
          __extensionSecret: true,
          encrypted: encryptKey(String(nextValues[field.key] ?? '')),
        } satisfies ExtensionSecretSettingValue
      } else {
        stored[field.key] = nextValues[field.key]
      }
    }

    for (const alias of this.configIdsFor(canonicalId)) {
      delete settingsMap[alias]
    }
    settingsMap[canonicalId] = stored
    currentSettings.extensionSettings = settingsMap
    saveSettings(currentSettings)

    return this.getPublicExtensionSettings(canonicalId).values
  }

  recordExternalToolFailure(extensionId: string, toolName: string, err: unknown): void {
    this.markExtensionFailure(extensionId, `tool.${toolName}`, err, true)
  }

  recordExternalToolSuccess(extensionId: string): void {
    this.markExtensionSuccess(extensionId)
  }

  isEnabled(filename: string): boolean {
    const explicit = this.readConfigEntry(filename)
    if (explicit != null) return explicit.enabled !== false
    const builtin = this.builtins.get(this.canonicalExtensionId(filename))
    if (builtin) return builtin.enabledByDefault !== false
    return true
  }

  isExplicitlyDisabled(filename: string): boolean {
    const explicit = this.readConfigEntry(filename)
    return explicit?.enabled === false
  }

  /**
   * 'active', or why the extension is not. There is no boolean form of this:
   * every caller so far (the scheduler tick and the manual Run now) has to
   * tell the operator which half failed, and `=== 'active'` at the call site
   * is the collapse when one does not.
   *
   * 'disabled' comes from the config entry: it is what the operator's toggle
   * (`setEnabled`) and the automatic disable after
   * MAX_CONSECUTIVE_EXTENSION_FAILURES (`autoDisableExternalExtension`) both
   * write, and for a builtin with no entry it is `enabledByDefault: false`.
   * 'not_loaded' is an enabled extension with no record in `this.extensions`:
   * its import threw or timed out, its setup() threw, its file is no longer on
   * disk, or nothing by that name was ever installed. The config is read
   * first because a disabled extension is absent from the map as well, and
   * 'disabled' is the answer an operator can act on with one switch.
   *
   * The map is read as it stands. On a cold process before `ensureLoaded` has
   * landed, no external extension is in it and each one answers 'not_loaded';
   * the server boot awaits `ensureLoaded` before it starts the daemon that
   * runs the scheduler (src/instrumentation.ts), so the scheduler does not
   * see that moment, but a caller that runs earlier would. Nothing here waits
   * for a reload in progress either: `reload()` swaps the map in without an
   * await in between, so a read lands on the old generation or the new one,
   * never on an empty map.
   */
  getActivationState(filename: string): ExtensionActivationState {
    if (!this.isEnabled(filename)) return 'disabled'
    this.load()
    return this.extensions.has(filename) ? 'active' : 'not_loaded'
  }

  listExtensions(): ExtensionMeta[] {
    try {
      this.load()
      const config = this.loadConfig()
      const failures = this.readFailureState()
      const metas: ExtensionMeta[] = []

      // A declared consumption is a data-access grant, so it is reported to the
      // operator whether or not it is being served today, together with the
      // reason the extension gave and — when it is not being served — the
      // reason code.
      //
      // A switched-off or load-failed extension is not in the map, and its card
      // used to show no grants at all. That is the wrong side of the trade for
      // an audit surface: switching a module off is exactly when an operator
      // wants to read what turning it back on would hand it. So the
      // declarations fall back to the last ones this process saw for that file
      // (see `lastKnownContracts`). The bound on that staleness is the last
      // load, not the file on disk: an extension switched off and then edited
      // shows the declarations it had when it was last loaded, so an operator
      // reading the card of a disabled extension to judge what switching it
      // back on would hand it can be reading a superseded manifest. Switching
      // it on is the action the operator was deciding about, and it also answers
      // the question: the reload that follows re-executes the file in either
      // module format — see `reload` — so the card then shows what the file
      // declares now, matching what the extension actually runs.
      //
      // `unavailable` is left off entirely for a not-loaded extension. It names
      // why a *provider* is not answering, and that question does not arise
      // while the consumer itself is off; asking anyway would answer
      // `not_declared`, because the resolver reads the loaded map and finds no
      // consumer there — a reason code that is simply false about the manifest
      // shown next to it.
      const describeContracts = (filename: string, loaded?: LoadedExtension): Pick<ExtensionMeta, 'contractsProvided' | 'contractsConsumed'> => {
        const declarations = loaded?.contracts ?? this.lastKnownContracts.get(filename)
        if (!declarations) return {}
        const provided: ExtensionContractProvidedMeta[] = Object.entries(declarations.provides)
          .map(([contract, definition]) => ({ contract, version: definition.version, summary: definition.summary }))
        const contracts = loaded?.contracts ? this.getExtensionContracts(loaded.id) : null
        const consumed: ExtensionContractConsumedMeta[] = declarations.consumes.map((entry) => {
          const unavailable = contracts?.why(entry.extension, entry.contract)
          return unavailable ? { ...entry, unavailable } : { ...entry }
        })
        return {
          contractsProvided: provided.length > 0 ? provided : undefined,
          contractsConsumed: consumed.length > 0 ? consumed : undefined,
        }
      }

      const describeCapabilities = (loaded?: LoadedExtension, fallback?: Extension): Pick<ExtensionMeta, 'toolCount' | 'hookCount' | 'hasUI' | 'providerCount' | 'connectorCount' | 'settingsFields' | 'managedAgentCount' | 'managedScheduleCount' | 'localFolderCount' | 'gatewayPlatformCount' | 'setupCheckCount'> => {
        const tools = loaded?.tools || fallback?.tools || []
        const hooks = loaded?.hooks || fallback?.hooks || {}
        const providers = loaded?.providers || fallback?.providers || []
        const connectors = loaded?.connectors || fallback?.connectors || []
        const managedResources = loaded?.managedResources
          || fallback?.managedResources
          || (fallback ? coerceManagedResources(fallback as unknown as Record<string, unknown>) : undefined)
        const hasUi = !!(loaded?.ui || fallback?.ui)
        const settingsFields = loaded?.ui?.settingsFields || fallback?.ui?.settingsFields
        return {
          toolCount: Array.isArray(tools) ? tools.length : 0,
          hookCount: Object.values(hooks || {}).filter((fn) => typeof fn === 'function').length,
          hasUI: hasUi,
          providerCount: Array.isArray(providers) ? providers.length : 0,
          connectorCount: Array.isArray(connectors) ? connectors.length : 0,
          managedAgentCount: managedResources?.agents?.length || 0,
          managedScheduleCount: (managedResources?.schedules?.length || 0) + (managedResources?.routines?.length || 0),
          localFolderCount: managedResources?.localFolders?.length || 0,
          gatewayPlatformCount: managedResources?.gatewayPlatforms?.length || 0,
          setupCheckCount: managedResources?.setupChecks?.length || 0,
          settingsFields: settingsFields?.length ? settingsFields : undefined,
        }
      }

      // Add all builtins
      for (const [id, p] of this.builtins.entries()) {
        const loaded = this.extensions.get(id)
        const explicitCfg = this.readConfigEntry(id, config)
        const enabled = explicitCfg != null ? explicitCfg.enabled !== false : p.enabledByDefault !== false
        const failure = failures[this.canonicalExtensionId(id)]
        const caps = describeCapabilities(loaded, p)
        metas.push({
          name: p.name,
          description: p.description || '',
          filename: id,
          enabled,
          isBuiltin: true,
          author: p.author || 'SwarmClaw',
          version: (p as { version?: string }).version || loaded?.meta.version || '1.0.0',
          source: loaded?.meta.source || 'local',
          sourceLabel: 'builtin',
          installSource: 'builtin',
          sourceUrl: loaded?.meta.sourceUrl,
          openclaw: p.openclaw === true,
          failureCount: failure?.count,
          lastFailureAt: failure?.lastFailedAt,
          lastFailureStage: failure?.lastStage,
          lastFailureError: failure?.lastError,
          autoDisabled: !enabled && !!failure && failure.count >= MAX_CONSECUTIVE_EXTENSION_FAILURES,
          ...caps,
        })
      }

      // Add external files
      try {
        const files = fs.readdirSync(EXTENSIONS_DIR).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
        for (const f of files) {
          if (!metas.find(m => m.filename === f)) {
            const loaded = this.extensions.get(f)
            const explicitCfg = this.readConfigEntry(f, config)
            const enabled = explicitCfg?.enabled !== false
            const failure = failures[f]
            const caps = describeCapabilities(loaded)
            const dependencyInfo = this.getDependencyInfo(f, explicitCfg)
            metas.push({
              name: loaded?.meta.name || f.replace(/\.(js|mjs)$/, ''),
              filename: f,
              enabled,
              isBuiltin: false,
              author: loaded?.meta.author,
              version: loaded?.meta.version || '0.0.1',
              source: loaded?.meta.source || inferStoredExtensionSource(explicitCfg),
              sourceLabel: loaded?.meta.sourceLabel || inferStoredPublisherSource(explicitCfg),
              installSource: loaded?.meta.installSource || inferStoredInstallSource(explicitCfg),
              sourceUrl: loaded?.meta.sourceUrl || explicitCfg?.sourceUrl,
              openclaw: loaded?.meta.openclaw,
              createdByAgentId: explicitCfg?.createdByAgentId || null,
              failureCount: failure?.count,
              lastFailureAt: failure?.lastFailedAt,
              lastFailureStage: failure?.lastStage,
              lastFailureError: failure?.lastError,
              autoDisabled: !enabled && !!failure && failure.count >= MAX_CONSECUTIVE_EXTENSION_FAILURES,
              hasDependencyManifest: dependencyInfo.hasManifest,
              dependencyCount: dependencyInfo.dependencyCount,
              devDependencyCount: dependencyInfo.devDependencyCount,
              packageManager: dependencyInfo.packageManager,
              dependencyInstallStatus: dependencyInfo.installStatus,
              dependencyInstallError: dependencyInfo.installError,
              dependencyInstalledAt: dependencyInfo.installedAt,
              ...caps,
              ...describeContracts(f, loaded),
            })
          }
        }
      } catch { /* ignore */ }

      return metas
    } catch (err: unknown) {
      log.error('extensions', 'listExtensions failed', { error: errorMessage(err) })
      return []
    }
  }

  readExtensionSource(filename: string): string {
    const fullPath = this.resolveExtensionSourcePath(filename)
    if (!fs.existsSync(fullPath)) throw new Error(`Extension not found: ${filename}`)
    return fs.readFileSync(fullPath, 'utf8')
  }

  async saveExtensionSource(filename: string, code: string, options?: UpsertExtensionOptions): Promise<void> {
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    this.ensureExtensionDirs()

    const shouldUseWorkspace = this.hasWorkspace(sanitizedFilename) || options?.packageJson !== undefined
    const sourcePath = shouldUseWorkspace
      ? this.getWorkspaceEntryPath(sanitizedFilename)
      : path.join(EXTENSIONS_DIR, sanitizedFilename)

    if (shouldUseWorkspace) fs.mkdirSync(this.getWorkspaceDir(sanitizedFilename), { recursive: true })
    fs.writeFileSync(sourcePath, code, 'utf8')

    const normalizedPackageManager = normalizeExtensionPackageManager(options?.packageManager)

    if (options?.packageJson !== undefined) {
      if (!shouldUseWorkspace) {
        throw new Error('Extension workspace is required for package.json support')
      }
      const manifest = normalizeExtensionManifest(options.packageJson, sanitizedFilename, normalizedPackageManager)
      fs.writeFileSync(this.getWorkspaceManifestPath(sanitizedFilename), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      this.setMeta(sanitizedFilename, {
        ...(options?.meta || {}),
        packageManager: normalizedPackageManager || normalizeExtensionPackageManager(manifest.packageManager) || undefined,
        dependencyInstallStatus: 'ready',
        dependencyInstallError: undefined,
        dependencyInstalledAt: undefined,
      })
    } else if (options?.meta && Object.keys(options.meta).length > 0) {
      this.setMeta(sanitizedFilename, options.meta)
    }

    // After the manifest, not before it: the shim's re-export form depends on
    // whether the workspace `package.json` declares `"type": "module"`, and on
    // a first scaffold that file does not exist yet when the code is written.
    if (shouldUseWorkspace) this.writeWorkspaceShim(sanitizedFilename)

    if (options?.installDependencies) {
      await this.installExtensionDependencies(sanitizedFilename, {
        packageManager: normalizedPackageManager || undefined,
      })
    }

    await this.reload()
  }

  async installExtensionDependencies(filename: string, options?: { packageManager?: ExtensionPackageManager }): Promise<ExtensionDependencyInfo> {
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    const fullPath = path.join(EXTENSIONS_DIR, sanitizedFilename)
    if (!fs.existsSync(fullPath) && !this.hasWorkspace(sanitizedFilename)) {
      throw new Error(`Extension not found: ${sanitizedFilename}`)
    }

    this.ensureExtensionDirs()
    const workspaceDir = this.getWorkspaceDir(sanitizedFilename)
    // Read before the install. A package this process has already evaluated
    // is not re-evaluated on reload (`node_modules` is excluded from both the
    // ESM generation stamp and the CommonJS eviction), so an install that
    // CHANGED the installed tree needs a restart to take effect, and one that
    // did not -- a reinstall that resolved to the same versions -- does not.
    // `hadInstalledPackages` alone told the operator to restart after every
    // no-op reinstall; the fingerprint is what tells the two apart. It stays
    // conservative where it cannot tell: a tree that existed but left no
    // manager-written record still reports a restart. See
    // `restartRequiredForUpgrades`.
    const hadInstalledPackages = fs.existsSync(path.join(workspaceDir, 'node_modules'))
    const treeBefore = installedTreeFingerprint(workspaceDir)
    const sourcePath = this.resolveExtensionSourcePath(sanitizedFilename)
    const currentCode = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : ''

    if (!this.hasWorkspace(sanitizedFilename)) {
      fs.mkdirSync(workspaceDir, { recursive: true })
      fs.writeFileSync(this.getWorkspaceEntryPath(sanitizedFilename), currentCode, 'utf8')
      this.writeWorkspaceShim(sanitizedFilename)
    }

    const manifest = this.readWorkspaceManifest(sanitizedFilename)
    if (!manifest) throw new Error(`Extension "${sanitizedFilename}" does not have a package.json manifest`)

    const packageManager = options?.packageManager
      || normalizeExtensionPackageManager(this.readConfigEntry(sanitizedFilename)?.packageManager)
      || normalizeExtensionPackageManager(manifest.packageManager)
      || 'npm'

    this.setMeta(sanitizedFilename, {
      packageManager,
      dependencyInstallStatus: 'installing',
      dependencyInstallError: undefined,
    })

    try {
      await this.runDependencyInstall(packageManager, workspaceDir)
      this.setMeta(sanitizedFilename, {
        packageManager,
        dependencyInstallStatus: 'installed',
        dependencyInstallError: undefined,
        dependencyInstalledAt: Date.now(),
      })
    } catch (err: unknown) {
      const message = errorMessage(err)
      this.setMeta(sanitizedFilename, {
        packageManager,
        dependencyInstallStatus: 'error',
        dependencyInstallError: message,
      })
      throw new Error(message)
    } finally {
      await this.reload()
    }

    const treeAfter = installedTreeFingerprint(workspaceDir)
    return {
      ...this.getDependencyInfo(sanitizedFilename, this.readConfigEntry(sanitizedFilename)),
      restartRequiredForUpgrades: hadInstalledPackages && (treeBefore === null || treeAfter === null || treeBefore !== treeAfter),
    }
  }

  async setEnabled(filename: string, enabled: boolean): Promise<void> {
    const current = this.readConfigEntry(filename)
    this.updateConfigEntry(filename, { ...(current || {}), enabled })
    if (enabled) this.clearFailureState(filename)
    await this.reload()
  }

  async deleteExtension(filename: string): Promise<boolean> {
    // Only allow deleting external extensions, not builtins
    if (this.builtins.has(this.canonicalExtensionId(filename))) return false
    // Sanitised before anything touches the filesystem: an unsanitised
    // './x.mjs' still resolves to the file and unlinks it, but derives the
    // prefix 'ext___x_', so the schema drop below matches nothing and leaves
    // exactly the orphan schema it exists to prevent.
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    const fullPath = path.join(EXTENSIONS_DIR, sanitizedFilename)
    if (!fs.existsSync(fullPath)) return false
    // Read before the unlink: the surviving extension files decide which
    // prefixed tables the drop below must leave alone.
    const otherExtensionIds = this.listExtensionFilenames().filter((name) => name !== sanitizedFilename)
    fs.unlinkSync(fullPath)
    const workspaceDir = this.getWorkspaceDir(sanitizedFilename)
    // Read before the workspace goes: the manifest of skill directories the
    // installer shipped lives in it, and it is the only record of which
    // directories under the workspace skills layer are this extension's to
    // remove. See extension-managed-teardown.ts.
    const shippedSkills = readShippedSkillNames(workspaceDir)
    if (fs.existsSync(workspaceDir)) fs.rmSync(workspaceDir, { recursive: true, force: true })
    // The agents and schedules a reconcile created for this extension, and the
    // skill files its installer shipped. Without this the schedules stayed
    // active on their cron, pointing at agents whose tools had just been
    // removed, and the scheduler dispatched runs that could only fail. The
    // files are already gone by here, so a failure is logged rather than
    // thrown, for the same reason the storage drop below is.
    try {
      const removed = removeExtensionManagedResources(sanitizedFilename)
      const removedSkillDirs = removeShippedSkillDirs(shippedSkills)
      if (removed.deletedSchedules.length > 0 || removed.trashedAgents.length > 0 || removedSkillDirs.length > 0) {
        log.info('extensions', 'Removed extension-managed resources on delete', {
          extensionId: sanitizedFilename,
          deletedSchedules: removed.deletedSchedules.join(', '),
          trashedAgents: removed.trashedAgents.join(', '),
          removedSkillDirs: removedSkillDirs.join(', '),
        })
      }
    } catch (err: unknown) {
      log.warn('extensions', 'Failed to remove extension-managed resources on delete', {
        extensionId: sanitizedFilename,
        error: errorMessage(err),
      })
    }
    this.updateConfigEntry(sanitizedFilename, null)
    const settings = loadSettings()
    const settingsMap = (settings.extensionSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    for (const key of this.configIdsFor(sanitizedFilename)) delete settingsMap[key]
    settings.extensionSettings = settingsMap
    saveSettings(settings)
    this.clearFailureState(sanitizedFilename)
    // The remembered declarations are per-file and the file is gone, so a
    // reinstall under the same name must not inherit the old grants on its card
    // before it has loaded once.
    this.lastKnownContracts.delete(sanitizedFilename)
    // Last piece of extension state, and the only one that outlives the files:
    // its ext_migrations rows and its ext_<id>_ tables, views and triggers.
    // Leaving them makes a later reinstall skip its own migrations against a
    // stale schema, or fail outright on an object that still exists. The files
    // are already gone by here, so a database error is logged rather than
    // thrown — failing the call now would report an uninstall that did happen.
    try {
      const dropped = dropExtensionStorage(sanitizedFilename, otherExtensionIds)
      if (dropped.droppedObjects.length > 0 || dropped.droppedMigrationRows > 0) {
        log.info('extensions', 'Dropped extension storage on delete', {
          extensionId: sanitizedFilename,
          objects: dropped.droppedObjects.join(', '),
          migrationRows: dropped.droppedMigrationRows,
        })
      }
    } catch (err: unknown) {
      log.warn('extensions', 'Failed to drop extension storage on delete', {
        extensionId: sanitizedFilename,
        error: errorMessage(err),
      })
    }
    await this.reload()
    return true
  }

  async installExtensionFromUrl(url: string, filename: string, meta?: Record<string, unknown>): Promise<InstalledExtensionSource> {
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    const download = await downloadExtensionSource(url)
    await this.saveExtensionSource(sanitizedFilename, download.code, {
      meta: {
        ...(meta || {}),
        sourceUrl: download.normalizedUrl,
        sourceHash: download.hash,
        installedAt: Date.now(),
        updatedAt: Date.now(),
      },
    })

    return {
      filename: sanitizedFilename,
      sourceUrl: download.normalizedUrl,
      sourceHash: download.hash,
      contentType: download.contentType,
    }
  }

  async updateExtension(id: string) {
    this.load()
    const p = this.extensions.get(id)
    if (!p) throw new Error('Extension not found')
    if (p.isBuiltin) throw new Error('Built-in extensions are updated via application releases')

    log.info('extensions', 'Updating extension', { extensionId: id, extensionName: p.meta.name })
    const current = this.readConfigEntry(id)
    const sourceUrl = current?.sourceUrl?.trim()
    if (!sourceUrl) throw new Error(`Extension "${id}" has no recorded source URL and cannot be updated automatically`)

    const download = await downloadExtensionSource(sourceUrl)
    // Routed through saveExtensionSource rather than written straight into the
    // extensions directory. For a workspace-backed extension -- anything that
    // has been through installExtensionDependencies or was saved with a
    // package.json, plus anything that ships its own installer -- the
    // extensions-dir file is a generated shim and the loader imports the
    // workspace entry instead. Writing the download there left the old code
    // running while setMeta recorded the new hash and the route reported `ok`,
    // so a marketplace security fix could never land and nothing said so.
    // saveExtensionSource picks the right file for either layout, refreshes the
    // shim, and reloads on the way out, which is why there is no reload here.
    await this.saveExtensionSource(id, download.code, {
      meta: {
        sourceUrl: download.normalizedUrl,
        sourceHash: download.hash,
        updatedAt: Date.now(),
      },
    })
    return true
  }

  async updateAllExtensions() {
    this.load()
    const ids = Array.from(this.extensions.entries())
      .filter(([, entry]) => !entry.isBuiltin)
      .map(([id]) => id)
    for (const id of ids) {
      try {
        await this.updateExtension(id)
      } catch { /* ignore individual failures */ }
    }
    return true
  }

  setMeta(filename: string, meta: Record<string, unknown>) {
    const current = this.readConfigEntry(filename)
    this.updateConfigEntry(filename, { ...(current || {}), ...(meta as ExtensionConfigEntry) })
  }

  private loadConfig(): Record<string, ExtensionConfigEntry> {
    try { return JSON.parse(fs.readFileSync(EXTENSIONS_CONFIG, 'utf8')) } catch { return {} }
  }

  /**
   * Re-acquires every enabled external extension and rebuilds the manager.
   *
   * Asynchronous because acquiring an extension module is: `import()` is the
   * only call that loads ESM on Electron's Node, and the only one that can
   * produce a *second* evaluation of a file Node has already loaded. Callers
   * that do not await it get a manager that is still serving the previous
   * generation, which is the same thing they got before this became async, so
   * the failure mode of a missed `await` is a stale read rather than a crash.
   *
   * The generation bump is what makes the reload real. Node's ESM registry is
   * keyed by module URL and has no eviction API, so re-importing the same URL
   * returns the same module object however many times the file changed on
   * disk; stamping a new generation onto the URL is the only supported way to
   * get the edited file evaluated. The cost is a leak, measured rather than
   * estimated: one retained module instance per file in the extension's own
   * module graph per reload, roughly 5-8 KB each, held by that registry for the
   * life of the process. Bumped per reload rather than per load, so the count
   * tracks operator actions -- install, edit, enable, disable, delete, or a
   * write the directory watcher sees -- and not request traffic.
   *
   * That is per reload, and one operator action is rarely one reload: a save
   * costs two generations, the explicit reload plus the watcher's debounced
   * one, and each generation re-imports *every* enabled extension rather than
   * the one that changed. So the retained-module count for a single save scales
   * with the number of installed extensions, and `updateAllExtensions()` pays
   * that pair once per extension it updates.
   *
   * Acquisition finishes before anything is invalidated, and the swap and the
   * rebuild share one synchronous step, so there is no moment at which a
   * synchronous reader sees a host whose external extensions have vanished.
   */
  async reload(): Promise<void> {
    // Serialised, not just queued. Two overlapping reloads used to bump the
    // generation up front and then install by *completion* order, so the older
    // generation could land last and serve stale code with no signal, and the
    // generation that lost the race had already run every extension's setup()
    // -- registering timers, listeners and subscriptions on a module instance
    // that was then dropped, with no teardown hook to undo them. Running one
    // reload at a time removes both: the generation is bumped inside the
    // serialised section, so the reload that starts last reads the newest file
    // and installs last, and no generation is ever acquired by *this method*
    // only to be thrown away.
    //
    // That last clause is about `reload()`, not about the manager. `ensureLoaded`
    // acquires outside this queue, so a reload that overlapped it could still
    // install the older of the two acquisitions. Reaching that needs something
    // to call `reload()` before `instrumentation.register()`'s await returns,
    // which nothing does; it is recorded here rather than fixed so the sentence
    // above cannot be read as a property of the whole class.
    //
    // The discard-on-stale alternative -- acquire concurrently, drop a result
    // once a newer generation has landed -- would also keep the newest
    // generation, but it still evaluates the losing module (top-level code
    // runs at import) and it mutates require.cache from two overlapping
    // acquisitions, which is the one piece of shared state the CommonJS path
    // depends on. Serialising costs a second acquisition only when reloads
    // actually overlap, which operator-driven reloads rarely do.
    //
    // A caller's promise therefore resolves once *its* reload has landed, which
    // may be after a later reload that was queued behind it; what it never
    // resolves to is a host serving an older generation than the one its own
    // call asked for.
    const run = this.reloadQueue.then(() => this.runReload(), () => this.runReload())
    // The queue itself must never reject, or every later reload chained onto it
    // would inherit that rejection; the failure is delivered to `run`'s caller.
    this.reloadQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private async runReload(): Promise<void> {
    this.moduleGeneration += 1
    const acquired = await this.acquireExternalModules(this.moduleGeneration)
    this.externalModules = acquired
    this.loaded = false
    this.loading = true
    try {
      this.loadOnce()
    } finally {
      this.loading = false
    }
  }
}

const _managerHolder = hmrSingleton<{ instance: ExtensionManager | null }>('__swarmclaw_extension_manager__', () => ({ instance: null }))
export function getExtensionManager(): ExtensionManager {
  try {
    if (!_managerHolder.instance) {
      _managerHolder.instance = new ExtensionManager()
    }
    return _managerHolder.instance
  } catch (err: unknown) {
    log.error('extensions', 'getExtensionManager critical failure', { error: errorMessage(err) })
    throw err
  }
}
