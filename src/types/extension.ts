import type { ProviderId } from './provider'
import type { Session } from './session'
import type { Message } from './message'
import type { ApprovalRequest } from './approval'
import type { MessageToolEvent } from './message'
import type { InboundMessage, OutboundSendOptions } from './connector'

export interface ExtensionPromptBuildResult {
  systemPrompt?: string
  prependContext?: string
  prependSystemContext?: string
  appendSystemContext?: string
}

export interface ExtensionModelResolveResult {
  providerOverride?: ProviderId
  modelOverride?: string
  apiEndpointOverride?: string | null
}

export interface ExtensionToolCallResult {
  input?: Record<string, unknown> | null
  params?: Record<string, unknown>
  block?: boolean
  blockReason?: string
  warning?: string
}

export interface ExtensionMessagePersistResult {
  message?: Message
}

export interface ExtensionBeforeMessageWriteResult extends ExtensionMessagePersistResult {
  block?: boolean
}

export interface ExtensionSubagentSpawningResult {
  status: 'ok' | 'error'
  error?: string
}

export interface ExtensionHooks {
  beforeAgentStart?: (ctx: { session: Session; message: string }) => Promise<void> | void
  afterAgentComplete?: (ctx: { session: Session; response: string }) => Promise<void> | void
  beforeModelResolve?: (ctx: {
    session: Session
    prompt: string
    message: string
    provider: ProviderId
    model: string
    apiEndpoint?: string | null
  }) => Promise<ExtensionModelResolveResult | void> | ExtensionModelResolveResult | void
  beforeToolExec?: (ctx: { toolName: string; input: Record<string, unknown> | null }) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  beforePromptBuild?: (ctx: {
    session: Session
    prompt: string
    message: string
    history: Message[]
    messages: Message[]
  }) => Promise<ExtensionPromptBuildResult | void> | ExtensionPromptBuildResult | void
  beforeToolCall?: (ctx: {
    session: Session
    toolName: string
    input: Record<string, unknown> | null
    runId?: string
    toolCallId?: string
  }) => Promise<ExtensionToolCallResult | Record<string, unknown> | void> | ExtensionToolCallResult | Record<string, unknown> | void
  llmInput?: (ctx: {
    session: Session
    runId: string
    provider: ProviderId
    model: string
    systemPrompt?: string
    prompt: string
    historyMessages: Message[]
    imagesCount: number
  }) => Promise<void> | void
  llmOutput?: (ctx: {
    session: Session
    runId: string
    provider: ProviderId
    model: string
    assistantTexts: string[]
    response: string
    usage?: {
      input?: number
      output?: number
      total?: number
      estimatedCost?: number
    }
  }) => Promise<void> | void
  toolResultPersist?: (ctx: {
    session: Session
    message: Message
    toolName?: string
    toolCallId?: string
    isSynthetic?: boolean
  }) => Promise<ExtensionMessagePersistResult | Message | void> | ExtensionMessagePersistResult | Message | void
  beforeMessageWrite?: (ctx: {
    session: Session
    message: Message
    phase?: 'user' | 'system' | 'assistant_partial' | 'assistant_final' | 'heartbeat'
    runId?: string
  }) => Promise<ExtensionBeforeMessageWriteResult | Message | void> | ExtensionBeforeMessageWriteResult | Message | void
  afterToolExec?: (ctx: { session: Session; toolName: string; input: Record<string, unknown> | null; output: string }) => Promise<void> | void
  onMessage?: (ctx: { session: Session; message: Message }) => Promise<void> | void
  sessionStart?: (ctx: {
    session: Session
    resumedFrom?: string | null
  }) => Promise<void> | void
  sessionEnd?: (ctx: {
    sessionId: string
    session?: Session | null
    messageCount: number
    durationMs?: number
    reason?: string | null
  }) => Promise<void> | void
  subagentSpawning?: (ctx: {
    parentSessionId?: string | null
    agentId: string
    agentName: string
    message: string
    cwd: string
    mode: 'run' | 'session'
    threadRequested: boolean
  }) => Promise<ExtensionSubagentSpawningResult | void> | ExtensionSubagentSpawningResult | void
  subagentSpawned?: (ctx: {
    parentSessionId?: string | null
    childSessionId: string
    agentId: string
    agentName: string
    runId: string
    mode: 'run' | 'session'
    threadRequested: boolean
  }) => Promise<void> | void
  subagentEnded?: (ctx: {
    parentSessionId?: string | null
    childSessionId: string
    agentId: string
    agentName: string
    status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
    response?: string | null
    error?: string | null
    durationMs?: number
  }) => Promise<void> | void

  // Post-turn hook — fires after a full chat exchange (user message → agent response)
  afterChatTurn?: (ctx: {
    session: Session
    message: string
    response: string
    source: string
    internal: boolean
    toolEvents?: MessageToolEvent[]
  }) => Promise<void> | void

  // Orchestration & Swarm Hooks
  onTaskComplete?: (ctx: { taskId: string; result: unknown }) => Promise<void> | void
  onAgentDelegation?: (ctx: { sourceAgentId: string; targetAgentId: string; task: string }) => Promise<void> | void

  // Chat Middleware (Transform messages)
  transformInboundMessage?: (ctx: { session: Session; text: string }) => Promise<string> | string
  transformOutboundMessage?: (ctx: { session: Session; text: string }) => Promise<string> | string

  // Context injection — return a markdown string to inject into the agent's state modifier, or null/undefined to skip
  getAgentContext?: (ctx: { session: Session; enabledExtensions: string[]; message: string; history: Message[] }) => Promise<string | null | undefined> | string | null | undefined

  // Self-description — returns a capability line for the system prompt (e.g., "I can remember things across conversations")
  getCapabilityDescription?: () => string | null | undefined

  // Operating guidance — returns operational hints for the agent when this extension is active
  getOperatingGuidance?: () => string | string[] | null | undefined

  // Approval guidance — returns approval-scoped instructions when this extension is active
  getApprovalGuidance?: (ctx: {
    approval: ApprovalRequest
    phase: 'request' | 'resume' | 'connector_reminder'
    approved?: boolean
  }) => string | string[] | null | undefined
}

export interface ExtensionToolPlanning {
  /**
   * Capability tags that the harness can use for prompt guidance and tool routing.
   * Examples: research.search, research.fetch, browser.capture, artifact.pdf,
   * delivery.media, delivery.voice_note.
   */
  capabilities?: string[]
  /**
   * Concrete usage guidance that should be injected into the system prompt when
   * this tool is enabled.
   */
  disciplineGuidance?: string[]
}

export interface ExtensionToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  planning?: ExtensionToolPlanning
  execute: (args: Record<string, unknown>, ctx: { session: Session; message: string }) => Promise<string | object> | string | object
}

export interface ExtensionSettingsField {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'secret'
  placeholder?: string
  help?: string
  options?: Array<{ value: string; label: string }>
  defaultValue?: string | number | boolean
  required?: boolean
}

export interface ExtensionPageDefinition {
  id: string
  label: string
  /** One of `EXTENSION_PAGE_ICON_NAMES` (`src/lib/extension-page-nav.ts`); anything else renders the default icon. */
  icon?: string
  /** Must start with '/x/'; unique across installed extensions. */
  path: string
  /**
   * Built browser entry, relative to the extension workspace and required to
   * start with `dist/` (e.g. 'dist/index.js'). Only `<workspace>/dist` is
   * served, and `/api/extensions/<id>/assets/<...>` takes dist-relative
   * segments, so 'dist/index.js' is fetched as
   * `/api/extensions/<id>/assets/index.js`.
   */
  entry: string
  /** Optional stylesheet, same rule as `entry`: workspace-relative under `dist/`, e.g. 'dist/index.css'. */
  css?: string
  /**
   * The rail section this page appears in: one of NAV_SECTION_IDS
   * (`src/lib/app/nav-sections.ts`). Defaults to 'work', and an unknown value
   * falls back to 'work' rather than dropping the page.
   */
  section?: string
  /**
   * Sort key among the extension pages of the same section. Lower comes first;
   * ties break on label. Defaults to 100.
   */
  order?: number
  /**
   * @deprecated Superseded by `section`. Old values ('end', 'after:<view>') are
   * accepted and resolve to 'work'; nothing reads this field for placement.
   */
  position?: string
}

export interface ExtensionUIDefinition {
  sidebarItems?: Array<{
    id: string
    label: string
    icon?: string
    href: string
    position?: 'top' | 'bottom'
  }>
  headerWidgets?: Array<{
    id: string
    label: string
    icon?: string
  }>
  chatInputActions?: Array<{
    id: string
    label: string
    icon?: string
    tooltip?: string
    action: 'message' | 'link' | 'tool'
    value: string
  }>
  /** Settings fields declared by the extension, rendered in the extension settings panel */
  settingsFields?: ExtensionSettingsField[]
  /** Chat panels the extension provides (e.g., browser view, terminal) */
  chatPanels?: Array<{
    id: string
    label: string
    icon?: string
    /** WS topic to subscribe to for updates (e.g., 'browser:{sessionId}') */
    wsTopic?: string
  }>
  /** Badges to show on agent cards when this extension is enabled */
  agentBadges?: Array<{
    id: string
    label: string
    icon?: string
  }>
  /** Full pages the extension renders from its own bundle under the /x/ namespace. */
  pages?: ExtensionPageDefinition[]
}

export type ExtensionManagedResourceKind = 'agent' | 'schedule' | 'local_folder' | 'project'

export interface ExtensionManagedResourceRef {
  extensionId?: string
  resourceKind: 'agent' | 'schedule'
  resourceKey: string
}

export interface ExtensionManagedResourceMarker {
  extensionId: string
  extensionName?: string | null
  resourceKind: ExtensionManagedResourceKind
  resourceKey: string
  declarationHash?: string | null
  reconciledAt: number
  /**
   * Agents only: the skill pins (`skillIds` plus `skills`) the declaration
   * named at this reconcile. The next reconcile subtracts from the stored
   * agent's `skillIds` every name here that the new declaration no longer
   * names, which is how a renamed skill's old pin leaves the agent. Absent on
   * an agent last reconciled before this field existed, in which case there
   * is nothing to subtract.
   */
  declaredSkillIds?: string[]
}

export interface ExtensionManagedAgentDeclaration {
  agentKey: string
  displayName: string
  description?: string | null
  systemPrompt?: string | null
  instructions?: {
    content?: string | null
    entryFile?: string | null
    assetPath?: string | null
  } | null
  provider?: ProviderId | string | null
  model?: string | null
  apiEndpoint?: string | null
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  gatewayProfileId?: string | null
  preferredGatewayTags?: string[]
  preferredGatewayUseCase?: string | null
  capabilities?: string[] | string | null
  tools?: string[]
  extensions?: string[]
  skills?: string[]
  skillIds?: string[]
  mcpServerIds?: string[]
  monthlyBudget?: number | null
  dailyBudget?: number | null
  hourlyBudget?: number | null
  disabled?: boolean
  heartbeatEnabled?: boolean
  planningMode?: 'off' | 'strict' | null
}

export interface ExtensionManagedScheduleTrigger {
  kind?: 'schedule' | 'api' | 'webhook'
  label?: string | null
  enabled?: boolean
  cronExpression?: string | null
  timezone?: string | null
}

export interface ExtensionManagedScheduleDeclaration {
  scheduleKey?: string
  routineKey?: string
  displayName?: string
  title?: string
  description?: string | null
  taskPrompt?: string | null
  message?: string | null
  taskMode?: 'task' | 'wake_only' | 'protocol'
  agentId?: string | null
  agentRef?: ExtensionManagedResourceRef | null
  assigneeRef?: ExtensionManagedResourceRef | null
  scheduleType?: 'cron' | 'interval' | 'once'
  cron?: string | null
  intervalMs?: number | null
  runAt?: number | null
  timezone?: string | null
  status?: 'active' | 'paused' | 'completed' | 'failed' | 'archived'
  priority?: string | null
  triggers?: ExtensionManagedScheduleTrigger[]
}

export interface ExtensionManagedLocalFolderDeclaration {
  folderKey: string
  displayName: string
  description?: string | null
  access?: 'read' | 'readWrite'
  requiredDirectories?: string[]
  requiredFiles?: string[]
}

export interface ExtensionGatewayPlatformDeclaration {
  platformKey: string
  displayName: string
  description?: string | null
  transport?: 'http' | 'ws' | 'stdio' | 'cli' | 'gateway' | 'custom'
  endpoint?: string | null
  authMode?: 'none' | 'bearer' | 'api_key' | 'oauth' | 'custom'
  setupCheckKey?: string | null
  capabilities?: string[]
}

export interface ExtensionSetupCheckDeclaration {
  checkKey: string
  displayName: string
  description?: string | null
  kind: 'env' | 'command' | 'url' | 'manual'
  target?: string | null
  required?: boolean
}

/**
 * Egy projekt, amit az extension telepítése hoz létre és a törlése visz el.
 *
 * A `Project` heartbeat-mezőit szándékosan nem vesszük fel: azok az operátor
 * beállításai, és egy reconcile felülírná őket minden mentésnél.
 */
export interface ExtensionManagedProjectDeclaration {
  projectKey: string
  displayName: string
  description?: string | null
  objective?: string | null
  priorities?: string[]
  successMetrics?: string[]
  capabilityHints?: string[]
}

export interface ExtensionManagedResources {
  projects?: ExtensionManagedProjectDeclaration[]
  agents?: ExtensionManagedAgentDeclaration[]
  schedules?: ExtensionManagedScheduleDeclaration[]
  /** Routine alias. SwarmClaw reconciles routines as managed schedules. */
  routines?: ExtensionManagedScheduleDeclaration[]
  localFolders?: ExtensionManagedLocalFolderDeclaration[]
  /** Gateway/platform declaration metadata for setup and diagnostics surfaces. */
  gatewayPlatforms?: ExtensionGatewayPlatformDeclaration[]
  setupChecks?: ExtensionSetupCheckDeclaration[]
}

export interface ExtensionProviderDefinition {
  id: string
  name: string
  models: string[]
  requiresApiKey: boolean
  requiresEndpoint: boolean
  defaultEndpoint?: string
  streamChat: (opts: {
    session: { id: string } & Record<string, unknown>
    message: string
    imagePath?: string
    imageUrl?: string
    apiKey?: string | null
    systemPrompt?: string
    write: (data: string) => void
    active: Map<string, unknown>
    loadHistory: (sessionId: string) => unknown[]
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
    signal?: AbortSignal
  }) => Promise<string>
}

export interface ExtensionConnectorDefinition {
  id: string
  name: string
  description: string
  supportsBinaryMedia?: boolean
  // For sending outbound
  sendMessage?: (
    channelId: string,
    text: string,
    options?: OutboundSendOptions,
  ) => Promise<{ messageId?: string } | void>
  // For polling/listening
  startListener?: (onMessage: (msg: InboundMessage) => void) => Promise<() => void>
}

export interface Extension {
  name: string
  version?: string
  description?: string
  author?: string
  openclaw?: boolean
  enabledByDefault?: boolean
  hooks?: ExtensionHooks
  tools?: ExtensionToolDef[]
  ui?: ExtensionUIDefinition
  providers?: ExtensionProviderDefinition[]
  connectors?: ExtensionConnectorDefinition[]
  managedResources?: ExtensionManagedResources
  /** Top-level managed-resource aliases. Prefer managedResources for new SwarmClaw extensions. */
  projects?: ExtensionManagedProjectDeclaration[]
  agents?: ExtensionManagedAgentDeclaration[]
  schedules?: ExtensionManagedScheduleDeclaration[]
  routines?: ExtensionManagedScheduleDeclaration[]
  localFolders?: ExtensionManagedLocalFolderDeclaration[]
  gatewayPlatforms?: ExtensionGatewayPlatformDeclaration[]
  setupChecks?: ExtensionSetupCheckDeclaration[]
  /**
   * Runs on every load and every reload, after the migrations, and must be
   * idempotent. Reloads are frequent: saveExtensionSource, setEnabled,
   * deleteExtension and updateExtension each reload explicitly, and the host
   * watches both files that can hold an extension's source -- the top-level
   * `data/extensions/<name>` file and, for a workspace-backed extension, the
   * `data/extensions/.workspaces/<key>/index.js` the loader actually imports.
   * Anything else under `data/extensions`, a workspace `package.json` or its
   * `node_modules` included, does not trip a watcher. So in development setup()
   * runs again on every source save, twice per save in fact: once for the
   * explicit reload and once for the watcher's debounced one.
   * Capturing `ctx.storage` is fine; starting a timer, a listener or a
   * subscription here leaks one per reload unless setup() clears the previous
   * one itself.
   *
   * A reload re-executes the extension's file in both module formats, so its
   * module-level variables start again from their initial values and the new
   * setup() sees nothing the previous one left in them. What survives a reload
   * is `globalThis`, which no reload touches, and anything the extension pulled
   * from `node_modules`, which is imported once per process rather than once
   * per reload. So park state that must be reliably cleared on the next reload
   * on `globalThis` and clear it yourself there; a module-level variable is
   * cleared for you, but only because the module is thrown away and a new one
   * evaluated in its place. Synchronous, because load() is: the host awaits the
   * extension's module before setup() runs, never during it.
   */
  setup?: (ctx: ExtensionContext) => void
  migrations?: ExtensionMigration[]
  /** Called by the extension's own UI: POST /api/extensions/<id>/call/<method>. */
  rpc?: Record<string, ExtensionRpcHandler>
  /**
   * Contracts this extension offers to other extensions, keyed by contract
   * name. Validated at load: a contract with no callable method, no summary or
   * a bad version fails the load rather than resolving to nothing later.
   *
   * Only external extensions can provide. The builtin branch of load() does not
   * carry these onto the loaded record, for the same reason it does not carry
   * `rpc`; it warns when a builtin declares them.
   */
  provides?: Record<string, ExtensionContractDefinition>
  /**
   * Contracts this extension asks for. Declaring one is the *only* way to reach
   * another extension's data through `ctx.contracts`; an undeclared call gets
   * null with `not_declared` even when the provider is right there and enabled.
   *
   * An entry whose provider is missing, disabled or on another version is not a
   * load error — the extension loads and `ctx.contracts.get` returns null. An
   * operator is far better served by "the newsletter module is limited because
   * AI Signal is switched off" than by a module that silently never starts.
   */
  consumes?: ExtensionContractConsumption[]
}

export interface ExtensionMeta {
  name: string
  description?: string
  filename: string
  enabled: boolean
  isBuiltin?: boolean
  author?: string
  version?: string
  source?: 'local' | 'manual' | 'marketplace'
  sourceLabel?: ExtensionPublisherSource
  installSource?: ExtensionInstallSource
  sourceUrl?: string
  openclaw?: boolean
  failureCount?: number
  lastFailureAt?: number
  lastFailureStage?: string
  lastFailureError?: string
  autoDisabled?: boolean
  toolCount?: number
  hookCount?: number
  hasUI?: boolean
  providerCount?: number
  connectorCount?: number
  managedAgentCount?: number
  managedScheduleCount?: number
  localFolderCount?: number
  gatewayPlatformCount?: number
  setupCheckCount?: number
  createdByAgentId?: string | null
  settingsFields?: ExtensionSettingsField[]
  hasDependencyManifest?: boolean
  dependencyCount?: number
  devDependencyCount?: number
  packageManager?: ExtensionPackageManager
  dependencyInstallStatus?: ExtensionDependencyInstallStatus
  dependencyInstallError?: string
  dependencyInstalledAt?: number
  /** Contracts this extension offers. Omitted when it offers none. */
  contractsProvided?: ExtensionContractProvidedMeta[]
  /**
   * Contracts this extension asks for, each with the reason it gave and, when
   * the contract does not resolve today, why not. Omitted when it asks for
   * none. This is a data-access grant, so it is shown to the operator whether
   * or not it is currently being served.
   */
  contractsConsumed?: ExtensionContractConsumedMeta[]
}

export type ExtensionPublisherSource =
  | 'builtin'
  | 'local'
  | 'manual'
  | 'swarmclaw'
  | 'swarmforge'
  | 'clawhub'

export type ExtensionCatalogSource =
  | 'swarmclaw'
  | 'swarmclaw-site'
  | 'swarmforge'
  | 'clawhub'

export type ExtensionInstallSource =
  | 'builtin'
  | 'local'
  | 'manual'
  | ExtensionCatalogSource

export type ExtensionPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export type ExtensionDependencyInstallStatus = 'none' | 'ready' | 'installing' | 'installed' | 'error'

export interface MarketplaceExtension {
  id: string
  name: string
  description: string
  author: string
  version: string
  url: string
  source?: ExtensionPublisherSource
  catalogSource?: ExtensionCatalogSource
  tags?: string[]
  openclaw?: boolean
  downloads?: number
}

export interface ExtensionInvocationRecord {
  extensionId: string
  toolName: string
  inputTokens: number
  outputTokens: number
}

export interface ExtensionDefinitionCost {
  extensionId: string
  estimatedTokens: number
}

/**
 * A handle onto the host's already-open SQLite connection. Extensions must not
 * open a database of their own: `better-sqlite3` is a native module built for
 * Electron's ABI in the desktop app and Node's ABI on the server, so a bundled
 * copy would crash in one of the two hosts.
 */
export interface ExtensionStorage {
  /**
   * Runs exactly one statement. It prepares the SQL, so a semicolon-separated
   * batch fails with a raw driver error — this is not the db.exec() that
   * migrations are run with. Split the batch, or declare it as a migration.
   */
  exec(sql: string, params?: unknown[]): void
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined
  transaction<T>(fn: () => T): T
}

/**
 * One versioned schema step. Every table it creates must start with the
 * extension's `ext_<id>_` prefix — a tidiness and clean-uninstall convention
 * checked against these declarations, not an isolation boundary.
 */
export interface ExtensionMigration { version: number; sql: string }

/**
 * Why `ctx.contracts.get()` returned null. A closed set of four:
 *
 * - `not_declared`     the consumer never listed this contract in `consumes`.
 *                      Checked first and reported regardless of whether the
 *                      provider exists, so an undeclared call cannot be used to
 *                      probe which extensions are installed on this host.
 * - `provider_missing` no single enabled extension on this host answers to that
 *                      id and declares that contract. Also covers two cases the
 *                      consumer cannot tell apart and does not need to: the
 *                      provider is loaded but declares no such contract, and two
 *                      installed extensions normalise to the same id so the host
 *                      cannot tell which one was meant (that collision is logged
 *                      at load time, which is where the operator sees it).
 * - `provider_disabled` an extension with that id is installed but is not loaded
 *                      right now. "Not loaded" includes disabled by the operator
 *                      and failed to load; the host does not distinguish them
 *                      here.
 * - `version_mismatch` the provider declares that contract at a different
 *                      version than the consumer asked for.
 */
export type ExtensionContractUnavailableReason =
  | 'not_declared'
  | 'provider_missing'
  | 'provider_disabled'
  | 'version_mismatch'

/**
 * One method of a contract, as the provider declares it.
 *
 * The host does not inspect, validate, transform or serialise either the
 * argument object or the return value. Whatever the provider returns is what
 * the consumer gets, by reference.
 */
export type ExtensionContractMethod = (args: Record<string, unknown>) => unknown | Promise<unknown>

/** One method of a contract, as the consumer calls it through the handle. */
export type ExtensionContractCall = (args?: Record<string, unknown>) => Promise<unknown>

/**
 * One contract an extension offers to other extensions, declared in `provides`.
 *
 * `summary` is required because it is the only thing that tells an operator
 * what a consumer of this contract is being given. The host mediates *access*,
 * not semantics: a contract whose summary says "read only" can still write, and
 * nothing here stops it. The summary and the consumer's `reason` are what make
 * that visible; they are not enforcement.
 */
export interface ExtensionContractDefinition {
  version: number
  summary: string
  methods: Record<string, ExtensionContractMethod>
}

/**
 * One contract an extension asks for, declared in `consumes`.
 *
 * `reason` is not decoration. A declared consumption is a data-access grant
 * shown to the operator in the extension list, and the reason is the sentence
 * they read when deciding whether to keep the extension installed.
 */
export interface ExtensionContractConsumption {
  extension: string
  contract: string
  version: number
  reason: string
}

/**
 * What `ctx.contracts.get()` hands back: exactly the methods the provider
 * listed under that contract, and nothing else.
 *
 * The object has a null prototype and is frozen, so it carries no inherited
 * `toString`/`constructor` to call by accident and a consumer cannot swap a
 * method on it. Any other name is `undefined` — the index signature says so, so
 * call through `handle.list?.(...)` or check first.
 *
 * A handle is a bearer capability: it carries the identity of the extension it
 * was minted for, and the host never re-checks that against whoever calls
 * through it. Handing your handle to another extension hands over your grant.
 */
export interface ExtensionContractHandle {
  readonly [method: string]: ExtensionContractCall | undefined
}

/**
 * `ctx.contracts` — the host-mediated way one extension reaches another's data.
 *
 * Resolution is lazy: nothing is looked up until `get` or `why` is called, so a
 * consumer that loads before its provider still works, and two extensions that
 * consume each other cannot deadlock at load time. It is also re-done on every
 * call, including every call through an already-obtained handle, so a handle
 * captured in `setup()` stops working the moment the provider is disabled or
 * deleted, rather than calling on into a stale closure.
 *
 * Re-resolution follows an edit to an extension's file too, in both module
 * formats and on every runtime the product ships on. The host's reload imports
 * each extension under a fresh generation-stamped module URL -- the only way to
 * get Node to evaluate an ESM file a second time, since its registry is keyed by
 * URL and cannot be evicted -- and evicts CommonJS entries from `require.cache`
 * alongside it. So a contract version bumped on disk is the version served, a
 * method added to or dropped from a `provides` block appears or disappears, and
 * a `consumes` entry deleted from a consumer really does revoke the grant: the
 * next call answers `not_declared`, without a process restart.
 *
 * Switching an extension off and uninstalling it do not depend on any of that:
 * both are read off the config file and the directory listing rather than off
 * module content, so both are immediate. Module *state* follows module
 * *content*: because the file re-executes, its module-level variables start
 * again from their initial values on each reload.
 *
 * Data that comes back across this boundary keeps whatever trust it had. AI
 * Signal's items are newsletter bodies and forum posts written by strangers;
 * arriving through another extension does not make them instructions. A
 * consumer that puts them in front of a model or on an outbound channel must
 * guard them itself (see `guardUntrustedText` in
 * `src/lib/server/untrusted-content.ts`); the host does not do it here, and does
 * not pretend to.
 */
export interface ExtensionContracts {
  /** The provider's declared methods, or null. `why` names the reason for the null. */
  get: (extensionId: string, contract: string) => ExtensionContractHandle | null
  /** The reason `get` would return null, or null when the contract does resolve. */
  why: (extensionId: string, contract: string) => ExtensionContractUnavailableReason | null
}

/** One extension's validated contract declarations, as the host keeps them. */
export interface ExtensionContractDeclarations {
  provides: Record<string, ExtensionContractDefinition>
  consumes: ExtensionContractConsumption[]
}

/** A contract this extension offers, as shown to the operator. */
export interface ExtensionContractProvidedMeta {
  contract: string
  version: number
  summary: string
}

/**
 * A contract this extension asks for, as shown to the operator: the grant it
 * declared, plus why it is not being served when it is not.
 */
export interface ExtensionContractConsumedMeta extends ExtensionContractConsumption {
  /**
   * Absent when the contract resolves, and also absent for an extension that is
   * not running — switched off, or failed to load — where the grant is still
   * listed but there is no provider question to answer. Otherwise the reason
   * the contract does not resolve.
   */
  unavailable?: ExtensionContractUnavailableReason
}

export type ExtensionRpcHandler = (body: Record<string, unknown>) => unknown | Promise<unknown>

export interface ExtensionContext {
  extensionId: string
  tablePrefix: string
  storage: ExtensionStorage
  settings: () => Record<string, unknown>
  log: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void }
  oauth: {
    getGoogleAccessToken: (purpose: string) => Promise<string>
    hasGoogleCredential: (purpose: string) => boolean
    /**
     * Whether this host has a Google OAuth client id and secret at all, which
     * is a different fact from `hasGoogleCredential` and has a different
     * remedy: the operator sets two environment variables and restarts, rather
     * than clicking through a consent screen. False here means a connect link
     * for a listed purpose answers 409 `google_oauth_client_missing` instead of
     * redirecting to consent, so an extension should say that and disable the
     * control rather than offer one that cannot work.
     *
     * True says only that both strings are present. Whether they name a client
     * Google still accepts is not knowable without a consent round trip.
     */
    googleClientConfigured: () => boolean
  }
  /**
   * Where an external command this extension shells out to actually lives, or
   * null when the lookup found nothing.
   *
   * An extension that spawns `ffprobe` by its bare name gets whatever `PATH`
   * the host process inherited, and the packaged desktop app does not inherit
   * the operator's login `PATH`: a Homebrew or nvm binary that works from a
   * terminal is simply absent there. This asks a login shell first and then the
   * well-known install directories, the same way the host resolves the CLI
   * providers' binaries — which extensions cannot call themselves, since they
   * may not import from the host's `src/`.
   *
   * A non-null answer is a path that existed when the lookup ran and nothing
   * more: not that it is executable by this process, not that it is the version
   * wanted, not that it is still there at spawn time. On null, spawn the bare
   * name anyway so the operating system's own ENOENT is what the operator
   * reads, rather than a guess dressed up as a fact.
   *
   * Only a plain command name is accepted (letters, digits and `. _ + -`). The
   * lookup puts the name in a login shell's `command -v`, so a name with a path
   * separator, whitespace or a shell character is refused by name with a thrown
   * `TypeError` and never quietly rewritten. A binary at a known absolute path
   * needs none of this: spawn the path.
   *
   * IT IS EXPENSIVE AND IT BLOCKS. The lookup runs a synchronous `spawnSync`
   * of the operator's login shell — which sources their profile — for up to 2
   * seconds, on the calling thread. That thread also serves the HTTP routes,
   * the WebSocket hub and the scheduler tick, so a slow profile stalls all of
   * them, and a binary that is not installed costs the full spawn again every
   * 30 seconds because negative answers are cached for only that long.
   * Nothing here rate limits it. Resolve a binary once per operation and hold
   * the answer; do not call this per tool invocation, per row, or in a loop.
   */
  resolveBinary: (name: string) => string | null
  /**
   * Access to the contracts other extensions declare. Safe to capture: every
   * call re-resolves, so a captured handle follows the provider being disabled
   * or deleted instead of going stale -- true for every extension regardless
   * of module format, because disabling and deleting are read off the config
   * file and the directory listing, not off module content.
   *
   * Following an edit to an extension's *file* also works in both module
   * formats: the reload re-executes the file, ESM by importing it under a new
   * generation-stamped URL and CommonJS by evicting it from the require cache
   * first. A contract version bumped on disk, a method added or dropped, and a
   * `consumes` entry added or removed each take effect on the next reload
   * without a process restart, and a captured handle follows all of it.
   *
   * Reading this during `setup()` itself is the one further exception worth
   * knowing about -- see `createExtensionContracts` in
   * `src/lib/server/extensions/extension-contracts.ts`.
   */
  contracts: ExtensionContracts
}
