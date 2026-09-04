import { AsyncLocalStorage } from 'node:async_hooks'
import { errorMessage } from '@/lib/shared-utils'
import type {
  ExtensionContractCall,
  ExtensionContractConsumption,
  ExtensionContractDeclarations,
  ExtensionContractDefinition,
  ExtensionContractHandle,
  ExtensionContractMethod,
  ExtensionContractUnavailableReason,
  ExtensionContracts,
} from '@/types/extension'

/**
 * Extension-to-extension contracts: the one host-mediated way one extension
 * reaches another's data.
 *
 * Extension storage is deliberately isolated -- `validateMigrationSql` only
 * lets a migration declare tables under its own `ext_<id>_` prefix -- and that
 * isolation is what makes a module safe to switch off and delete. This module
 * does not open it up. A provider names, in its own manifest, the handful of
 * methods it is willing to answer; a consumer names, in its own manifest, which
 * of those it wants and why; and the host will connect the two and nothing
 * else.
 *
 * What that buys, precisely:
 *
 *   - A consumer that did not declare gets nothing, even when the provider is
 *     installed and enabled. Without that one property the declaration is
 *     decoration, so it is checked first, before anything else is even looked
 *     up.
 *   - A consumer reaches the provider's declared methods and nothing else: not
 *     its `rpc` handlers, not its tools, not its `ctx.storage`.
 *   - An operator can read, per extension, which other extension's data it was
 *     granted and the sentence it gave for wanting it.
 *
 * What it does NOT buy, and must not be read as buying:
 *
 *   - This is not a sandbox. Extensions are trusted, same-process code that can
 *     already reach everything the host can reach, exactly as the comment on
 *     `extensionTablePrefix` says of the table prefix. A hostile extension does
 *     not need a contract to read another one's tables. What this stops is the
 *     careless case and the undeclared case, and it is what makes the declared
 *     case auditable.
 *   - The host mediates *access*, not *semantics*. It cannot enforce that a
 *     contract advertised as "read only" only reads: a declared method is an
 *     ordinary function in the provider's own module, and it may do anything
 *     that module can do. `summary` and `reason` are what surface the intent to
 *     an operator. They are documentation, not a check, and nothing in this
 *     file makes them one.
 *   - Data crossing the boundary keeps whatever trust it had. The host does not
 *     inspect, sanitise, clone or serialise arguments or return values -- see
 *     `callContractMethod`.
 *   - A handle is not bound to whoever holds it. It carries the identity of the
 *     consumer it was minted for, so passing one on delegates the grant -- see
 *     `buildContractHandle`.
 *   - A reload does not pick up an edit to an extension's file. Disabling and
 *     deleting take effect immediately, including through a handle captured
 *     earlier; a contract version bumped on disk, or a declaration added or
 *     removed, needs a process restart -- see `callContractMethod`.
 *
 * What this module exports, and which half of it is a compatibility surface.
 * `ExtensionContractError` and `ExtensionContractErrorCode` are public API that
 * reaches extension authors: an extension module cannot import this file, so it
 * matches on `err.name === 'ExtensionContractError'` and switches on
 * `err.code`, which is exactly what the tests do. Renaming either, or renaming
 * one of the four codes, breaks extensions silently and is a breaking change.
 * `ContractValidation`, `ContractResolution`, `ExtensionContractRegistry` and
 * `ContractProviderEntry` are the named shapes of this module's own function
 * arguments and results. They are exported so a caller can name what it holds
 * -- the manager passes a registry, the tests stub one -- not because they are
 * promised to anyone; they may change with the manager.
 */

/** Contract and method names: lower snake case, so `__proto__` and friends cannot be spelled. */
const CONTRACT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/

/**
 * Cap on `summary` and `reason`. Both are extension-authored text rendered on
 * the operator's extension card; the cap keeps one manifest from turning that
 * card into a wall of text.
 */
const MAX_DECLARATION_TEXT = 200

/**
 * How many contract calls may be in flight in one call chain.
 *
 * A provider's method is allowed to consume a contract of its own -- that is a
 * legitimate composition, and forbidding it would only push the same call
 * through a worse route. Resolution is lazy, so a cycle (A consumes B, B
 * consumes A) cannot form at load time; a cycle that actually runs is the
 * consumer's own bug. This bound is what turns that bug into a named error
 * naming the chain, instead of a blown stack or a hang.
 *
 * Depth is tracked per async call chain, not process-wide, so two unrelated
 * consumers calling contracts at the same time do not add up against each
 * other. Eight is well above any composition anyone has a reason to write and
 * well below anything that hurts.
 */
export const MAX_CONTRACT_CALL_DEPTH = 8

/**
 * The frames of contract calls currently in flight on this async chain, oldest
 * first. `AsyncLocalStorage` and not a module-level counter: a counter shared
 * by every chain in the process would trip on unrelated concurrent calls and
 * report a cycle that is not there.
 */
const callChain = new AsyncLocalStorage<string[]>()

export type ExtensionContractErrorCode =
  | 'unavailable'
  | 'unknown_method'
  | 'call_depth_exceeded'
  | 'provider_threw'

/**
 * Every failure a contract call can produce, in one class, so a consumer can
 * tell "the provider went away" from "the provider threw" without parsing a
 * message. A provider's own exception is wrapped rather than rethrown: rule 5
 * of the brief -- the consumer must learn which provider, contract and method
 * failed, and must stay alive to decide what to do about it. The original is
 * kept on `cause`.
 *
 * One exception to the wrapping: an ExtensionContractError raised deeper in the
 * chain passes through unchanged. See the catch in `callContractMethod`.
 */
export class ExtensionContractError extends Error {
  readonly code: ExtensionContractErrorCode
  readonly consumerId: string
  readonly extensionId: string
  readonly contract: string
  readonly method: string
  readonly reason?: ExtensionContractUnavailableReason

  constructor(params: {
    code: ExtensionContractErrorCode
    message: string
    consumerId: string
    extensionId: string
    contract: string
    method: string
    reason?: ExtensionContractUnavailableReason
    cause?: unknown
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause })
    this.name = 'ExtensionContractError'
    this.code = params.code
    this.consumerId = params.consumerId
    this.extensionId = params.extensionId
    this.contract = params.contract
    this.method = params.method
    this.reason = params.reason
  }
}

/**
 * The id a contract is resolved on: lowercased, with a trailing `.js`/`.mjs`
 * dropped, so a consumer may write `extension: 'aisignal'` for the file
 * `aisignal.mjs` -- which is how the brief spells it, and the only spelling an
 * extension author can be expected to know.
 *
 * The mapping is lossy in one direction: 'aisignal.mjs' and 'aisignal.js' both
 * normalise to 'aisignal'. Two such files installed side by side make the id
 * ambiguous, and `resolveExtensionContract` deliberately refuses to pick one --
 * see the comment there.
 *
 * Unlike `extensionTablePrefix` this does NOT flatten punctuation, so
 * 'ai-signal.mjs' and 'ai_signal.mjs' stay distinct ids here even though they
 * share a table prefix. Do not use the two interchangeably.
 */
export function normalizeContractExtensionId(id: unknown): string {
  if (typeof id !== 'string') return ''
  return id.trim().toLowerCase().replace(/\.(m?js)$/, '')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readDeclarationText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export type ContractValidation =
  | { ok: true; declarations: ExtensionContractDeclarations }
  | { ok: false; error: string }

/**
 * Checks one extension's `provides` and `consumes` at load time.
 *
 * A rejection here fails the load, which is right for a declaration the
 * extension got wrong (a contract with no methods, a consumption with no
 * reason). It is emphatically NOT right for a consumption whose provider is
 * absent: that is checked at call time and answered with null, because an
 * unmet dependency must not stop the consumer from loading.
 *
 * One thing this cannot check, and does not claim to: a method declared twice.
 * `{ list: a, list: b }` is a JavaScript object literal, so the second wins
 * before this function ever sees it and there is no trace of the first. The
 * same goes for a contract name declared twice. Catching that would take a
 * parse of the extension source, which nothing here does.
 */
export function validateExtensionContracts(
  ownId: string,
  rawProvides: unknown,
  rawConsumes: unknown,
): ContractValidation {
  const provides: Record<string, ExtensionContractDefinition> = {}

  if (rawProvides != null) {
    if (!isPlainRecord(rawProvides)) return { ok: false, error: 'provides must be an object keyed by contract name' }
    for (const contract of Object.keys(rawProvides)) {
      if (!CONTRACT_NAME_RE.test(contract)) {
        return { ok: false, error: `provides contract name "${contract}" must be lower case letters, digits and underscore, starting with a letter` }
      }
      const raw = rawProvides[contract]
      if (!isPlainRecord(raw)) return { ok: false, error: `provides."${contract}" must be an object with version, summary and methods` }
      if (!Number.isInteger(raw.version) || (raw.version as number) < 1) {
        return { ok: false, error: `provides."${contract}".version must be a positive integer, got ${JSON.stringify(raw.version)}` }
      }
      const summary = readDeclarationText(raw.summary)
      if (!summary) {
        return { ok: false, error: `provides."${contract}".summary is required: it is what tells an operator what a consumer of this contract is given` }
      }
      if (summary.length > MAX_DECLARATION_TEXT) {
        return { ok: false, error: `provides."${contract}".summary must be at most ${MAX_DECLARATION_TEXT} characters` }
      }
      if (!isPlainRecord(raw.methods)) return { ok: false, error: `provides."${contract}".methods must be an object` }
      const methodNames = Object.keys(raw.methods)
      if (methodNames.length === 0) {
        return { ok: false, error: `provides."${contract}".methods declares no methods: a contract nothing can call is a contract the consumer cannot tell from a missing one` }
      }
      const methods: Record<string, ExtensionContractMethod> = {}
      for (const method of methodNames) {
        if (!CONTRACT_NAME_RE.test(method)) {
          return { ok: false, error: `provides."${contract}".methods."${method}" must be lower case letters, digits and underscore, starting with a letter` }
        }
        const fn = raw.methods[method]
        if (typeof fn !== 'function') {
          return { ok: false, error: `provides."${contract}".methods."${method}" must be a function, got ${typeof fn}` }
        }
        methods[method] = fn as ExtensionContractMethod
      }
      provides[contract] = { version: raw.version as number, summary, methods }
    }
  }

  const consumes: ExtensionContractConsumption[] = []
  const ownNormalized = normalizeContractExtensionId(ownId)
  const seen = new Set<string>()

  if (rawConsumes != null) {
    if (!Array.isArray(rawConsumes)) return { ok: false, error: 'consumes must be an array' }
    for (const raw of rawConsumes as unknown[]) {
      if (!isPlainRecord(raw)) return { ok: false, error: 'consumes entries must be objects with extension, contract, version and reason' }
      const extension = readDeclarationText(raw.extension)
      if (!extension) return { ok: false, error: 'consumes entry needs a non-empty extension id' }
      const contract = readDeclarationText(raw.contract)
      if (!CONTRACT_NAME_RE.test(contract)) {
        return { ok: false, error: `consumes contract name "${contract}" must be lower case letters, digits and underscore, starting with a letter` }
      }
      if (!Number.isInteger(raw.version) || (raw.version as number) < 1) {
        return { ok: false, error: `consumes."${extension}.${contract}".version must be a positive integer, got ${JSON.stringify(raw.version)}` }
      }
      const reason = readDeclarationText(raw.reason)
      if (!reason) {
        return { ok: false, error: `consumes."${extension}.${contract}".reason is required: it is what the operator reads when granting this extension access to another one's data` }
      }
      if (reason.length > MAX_DECLARATION_TEXT) {
        return { ok: false, error: `consumes."${extension}.${contract}".reason must be at most ${MAX_DECLARATION_TEXT} characters` }
      }
      const normalized = normalizeContractExtensionId(extension)
      if (normalized === ownNormalized) {
        return { ok: false, error: `consumes."${extension}.${contract}" names this extension as its own provider: call the method directly instead` }
      }
      const key = `${normalized}:${contract}`
      if (seen.has(key)) {
        return { ok: false, error: `consumes declares "${extension}.${contract}" twice: the extension and contract pair is the key, so two entries make the requested version ambiguous` }
      }
      seen.add(key)
      consumes.push({ extension, contract, version: raw.version as number, reason })
    }
  }

  return { ok: true, declarations: { provides, consumes } }
}

/** One loaded extension that declares contracts, as the registry reports it. */
export interface ContractProviderEntry {
  /** The provider's loaded id, e.g. 'aisignal.mjs'. Used in messages and logs, never for matching. */
  id: string
  declarations: ExtensionContractDeclarations
}

/**
 * The live extension registry, as this module needs to see it. An interface and
 * not a direct import of the manager, so resolution can be read, and tested,
 * without dragging in the loader, the filesystem and the database.
 */
export interface ExtensionContractRegistry {
  /**
   * Make sure the extension map is populated. Called before every resolution.
   * The manager's implementation deliberately does nothing while a load is
   * already in progress -- see `createExtensionContracts`.
   */
  ensureLoaded: () => void
  /** The declarations of the extension loaded under exactly this id, or null. */
  declarationsOf: (loadedId: string) => ExtensionContractDeclarations | null
  /** Every loaded extension whose id normalises to this one. Normally zero or one. */
  providersFor: (normalizedId: string) => ContractProviderEntry[]
  /** Whether an extension with this normalised id is installed on this host, loaded or not. */
  isInstalled: (normalizedId: string) => boolean
}

export type ContractResolution =
  | { ok: true; providerId: string; definition: ExtensionContractDefinition }
  | { ok: false; reason: ExtensionContractUnavailableReason }

/**
 * The single place that answers "can this extension call that contract, and if
 * not, why not?". `get`, `why` and every call through an already-obtained
 * handle all come through here, so there is exactly one answer to read.
 *
 * The order of the checks is load-bearing. The declaration is checked first and
 * on its own: an undeclared consumption is reported as `not_declared` whether
 * or not the provider exists, so a consumer cannot use `why` to enumerate the
 * extensions installed on this host. That mirrors `getRpcHandler`, which
 * collapses every one of its failures to null for the same reason.
 */
export function resolveExtensionContract(
  consumerId: string,
  extensionId: string,
  contract: string,
  registry: ExtensionContractRegistry,
): ContractResolution {
  registry.ensureLoaded()

  const wantedProvider = normalizeContractExtensionId(extensionId)
  const wantedContract = readDeclarationText(contract)
  const declarations = registry.declarationsOf(consumerId)
  const declared = declarations?.consumes.find(
    (entry) => normalizeContractExtensionId(entry.extension) === wantedProvider && entry.contract === wantedContract,
  )
  if (!declared) return { ok: false, reason: 'not_declared' }

  const matches = registry.providersFor(wantedProvider)
  if (matches.length === 0) {
    // Installed but not loaded covers both "the operator switched it off" and
    // "it failed to load". The four reason codes are a closed set and the
    // consumer's recourse is the same either way; the operator learns which it
    // was from the extension list, which shows the load failure separately.
    return { ok: false, reason: registry.isInstalled(wantedProvider) ? 'provider_disabled' : 'provider_missing' }
  }
  if (matches.length > 1) {
    // Two installed extensions normalise to the same id ('x.js' and 'x.mjs').
    // Picking either one would hand a consumer a provider it did not ask for
    // and could not tell apart, so neither is served. From the consumer's side
    // that is indistinguishable from there being no provider, which is what
    // `provider_missing` says; the collision itself is logged at load time,
    // where the operator can act on it.
    return { ok: false, reason: 'provider_missing' }
  }

  const provider = matches[0]
  const definition = Object.prototype.hasOwnProperty.call(provider.declarations.provides, wantedContract)
    ? provider.declarations.provides[wantedContract]
    : undefined
  if (!definition) return { ok: false, reason: 'provider_missing' }
  if (definition.version !== declared.version) return { ok: false, reason: 'version_mismatch' }

  return { ok: true, providerId: provider.id, definition }
}

/**
 * Invokes one contract method on behalf of one consumer.
 *
 * Every call re-resolves from scratch against the live extension map. That is
 * what makes a captured `ctx.contracts` -- or a handle stashed in a
 * module-level variable at `setup()` time, which is exactly what an extension
 * author will do -- follow the operator: if the provider has since been
 * disabled or deleted, the call fails with a named error instead of running a
 * stale closure over a provider the operator believes is switched off. A
 * disabled extension has to actually stop answering, or the toggle in the
 * extension list is a lie.
 *
 * Re-resolving does NOT pick up an edit to an extension's file, and this is the
 * one guarantee not to claim. `reload()` re-runs the loader, but
 * `clearExtensionRequireCache` in `extensions.ts` deletes a CommonJS cache
 * entry, which evicts neither an ESM module nor -- under the tsx loader this
 * project runs -- a CJS one, so the loader re-reads a module object Node never
 * re-executed. A provider whose contract version is bumped on disk, a method
 * added or dropped from a `provides` block, and a `consumes` entry edited or
 * deleted from a consumer all keep behaving exactly as they did before the
 * edit, until the process restarts. Disabling and deleting are the two that do
 * take effect on a reload, because they are driven by the config file and the
 * directory listing rather than by module content. Both halves are pinned by
 * the live-manager tests in `extension-contracts.test.ts`; evicting the module
 * cache is a platform-wide change to every extension reload, not a contracts
 * one, and is tracked separately.
 *
 * Arguments and return values pass through untouched: not cloned, not frozen,
 * not serialised, not inspected. Two consequences worth stating rather than
 * discovering. A provider may hand back a live reference into its own state,
 * and a consumer that mutates it mutates the provider's data; and a return
 * value that could never survive `JSON.stringify` still arrives intact here and
 * only breaks at whatever wire the consumer eventually puts it on. The host
 * transforming it would be worse: it would silently change dates, drop
 * undefined and imply the data had been cleaned when it had not.
 */
async function callContractMethod(params: {
  consumerId: string
  extensionId: string
  contract: string
  method: string
  registry: ExtensionContractRegistry
  args: Record<string, unknown> | undefined
}): Promise<unknown> {
  const { consumerId, extensionId, contract, method, registry } = params
  const resolved = resolveExtensionContract(consumerId, extensionId, contract, registry)
  if (!resolved.ok) {
    throw new ExtensionContractError({
      code: 'unavailable',
      reason: resolved.reason,
      consumerId,
      extensionId,
      contract,
      method,
      message: `contract ${extensionId}.${contract}.${method} is no longer available to ${consumerId}: ${resolved.reason}`,
    })
  }

  const fn = Object.prototype.hasOwnProperty.call(resolved.definition.methods, method)
    ? resolved.definition.methods[method]
    : undefined
  if (typeof fn !== 'function') {
    throw new ExtensionContractError({
      code: 'unknown_method',
      consumerId,
      extensionId,
      contract,
      method,
      message: `contract ${extensionId}.${contract} no longer declares a method "${method}"`,
    })
  }

  const frame = `${consumerId} -> ${resolved.providerId}.${contract}.${method}`
  const chain = callChain.getStore() ?? []
  if (chain.length >= MAX_CONTRACT_CALL_DEPTH) {
    throw new ExtensionContractError({
      code: 'call_depth_exceeded',
      consumerId,
      extensionId,
      contract,
      method,
      message: `contract call depth ${MAX_CONTRACT_CALL_DEPTH} exceeded; chain: ${[...chain, frame].join(' | ')}`,
    })
  }

  return callChain.run([...chain, frame], async () => {
    try {
      return await fn(params.args ?? {})
    } catch (err: unknown) {
      // A contract error raised further down the chain is rethrown as it is.
      // Re-wrapping it would bury its code: a `call_depth_exceeded` at the
      // bottom of a cycle would surface as `provider_threw` at every hop back
      // up, and the message would grow one nested prefix per hop. The frame
      // that would be added is already in the depth error's chain, which names
      // every hop at once.
      if (err instanceof ExtensionContractError) throw err
      throw new ExtensionContractError({
        code: 'provider_threw',
        consumerId,
        extensionId,
        contract,
        method,
        message: `contract ${resolved.providerId}.${contract}.${method} threw: ${errorMessage(err)}`,
        cause: err,
      })
    }
  })
}

/**
 * Builds the handle for one resolved contract: exactly the methods the provider
 * declared, each one a wrapper that re-resolves at call time.
 *
 * Null prototype and frozen. The null prototype is the same defence
 * `getRpcHandler` needed: an ordinary object would answer `handle.constructor`,
 * `handle.toString` and `handle.hasOwnProperty` with callable functions nobody
 * declared. Freezing means a consumer that swaps a method on the handle it was
 * given changes nothing, and a fresh handle per `get()` means the swap cannot
 * propagate to a later `get()` either.
 *
 * Neither of those makes the handle contained. `consumerId` is baked into the
 * closure at mint time and never re-checked against whoever calls, so a handle
 * carries the identity of the consumer it was minted for wherever it is passed:
 * an extension that hands its handle -- or its whole `ctx.contracts` -- to a
 * third extension delegates its grant along with it, and that third extension
 * then reads the provider's data having declared nothing. A handle is a bearer
 * capability, and nothing here can be otherwise: same-process extensions can
 * pass each other any value at all, which is the point the header of this file
 * makes about this not being a sandbox. What the declaration buys is that the
 * grant, and the extension that holds it, are named where an operator reads
 * them.
 */
function buildContractHandle(params: {
  consumerId: string
  extensionId: string
  contract: string
  definition: ExtensionContractDefinition
  registry: ExtensionContractRegistry
}): ExtensionContractHandle {
  const handle: Record<string, ExtensionContractCall> = Object.create(null)
  for (const method of Object.keys(params.definition.methods)) {
    handle[method] = (args?: Record<string, unknown>) => callContractMethod({
      consumerId: params.consumerId,
      extensionId: params.extensionId,
      contract: params.contract,
      method,
      registry: params.registry,
      args,
    })
  }
  return Object.freeze(handle) as ExtensionContractHandle
}

/**
 * The `ctx.contracts` handed to one extension in `setup()`.
 *
 * Nothing is resolved here -- the object is two closures. That is what lets a
 * consumer load before its provider, and what makes a cycle at load time
 * impossible: neither side looks the other up until something is actually
 * called.
 *
 * The one sharp edge: `get()` called from inside `setup()` itself resolves
 * against a half-built extension map, because `setup()` runs during `load()`
 * and only the extensions loaded so far are in it. A provider later in the
 * directory listing reads as `provider_missing` at that moment and resolves
 * normally on the next call. The manager's `ensureLoaded` is written to not
 * re-enter `load()` for exactly this reason; without that, resolving during
 * `setup()` would recurse until the stack ran out, re-running every extension's
 * migrations on the way down -- the same trap the `settings` closure in
 * `load()` documents. Resolve lazily, not in `setup()`.
 */
export function createExtensionContracts(
  consumerId: string,
  registry: ExtensionContractRegistry,
): ExtensionContracts {
  return Object.freeze({
    get: (extensionId: string, contract: string): ExtensionContractHandle | null => {
      const resolved = resolveExtensionContract(consumerId, extensionId, contract, registry)
      if (!resolved.ok) return null
      return buildContractHandle({
        consumerId,
        extensionId,
        contract,
        definition: resolved.definition,
        registry,
      })
    },
    why: (extensionId: string, contract: string): ExtensionContractUnavailableReason | null => {
      const resolved = resolveExtensionContract(consumerId, extensionId, contract, registry)
      return resolved.ok ? null : resolved.reason
    },
  })
}
