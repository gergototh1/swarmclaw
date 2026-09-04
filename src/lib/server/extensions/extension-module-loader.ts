import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'

/**
 * How an external extension's module object is obtained, and how a reload gets
 * a *new* one.
 *
 * This file has no import outside node: builtins on purpose. It is the one
 * piece of the loader that has to behave identically on every runtime the
 * product ships on -- `next dev` and `next start` under plain Node, and the
 * desktop app under Electron's embedded Node -- and the only way to show that
 * is to run this exact code under each of them. A test that can only reach it
 * through the TypeScript-transpiling test runner proves nothing about the
 * shipped binary, which is how the ERR_REQUIRE_ESM defect this file exists to
 * fix survived two green test rounds. `extension-module-loader.test.ts`
 * transpiles this file and drives it under plain Node and under Electron's
 * embedded Node; keeping the import list to node: builtins is what makes that
 * possible.
 *
 * Measured, on this repo's own toolchain:
 *
 *   node 22.22.3            require(<ESM>)  OK
 *   electron 33 -> 20.18.3  require(<ESM>)  ERR_REQUIRE_ESM
 *
 * `require(esm)` landed in Node 20.19 / 22.12; Electron 33 bundles 20.18.3, so
 * a `require()`-based loader cannot load an ESM extension in the desktop app at
 * all. Dynamic `import()` works on both, which is why the loader uses it.
 */

/**
 * Query parameter that makes each load of an extension a distinct module URL.
 *
 * Node's ESM registry is keyed by URL and has no eviction API: once a URL has
 * been imported, importing it again returns the same module object, forever.
 * Clearing `require.cache` does not touch it -- the entry a `require()`d ESM
 * module leaves in `require.cache` is a synthetic wrapper whose deletion
 * re-evaluates nothing. A changing query is the only supported way to get a
 * second evaluation of the same file, and it is why a reload leaks: see
 * `importExtensionModule`.
 */
export const EXTENSION_GENERATION_QUERY = 'swarmclawExtensionGeneration'

/**
 * Resolve hook source, registered once per process.
 *
 * Without it a generation-stamped URL re-executes the *entry* file only: a
 * relative specifier inside `index.js?generation=2` resolves to a plain
 * `src/db.mjs` with no query, which the ESM registry already holds from
 * generation 1. Measured on both runtimes -- entry re-executed, dependency did
 * not. Every extension of any size keeps its logic in those dependencies, so
 * without this hook `reload()` would re-run a file that mostly re-exports
 * unchanged code and would look like it worked.
 *
 * The hook copies the parent's generation onto whatever the parent resolves to,
 * so the stamp spreads across the extension's own module graph and the whole
 * graph re-executes. Two deliberate limits:
 *
 *  - Only `file:` URLs are stamped. A `node:` builtin has no query to carry and
 *    a bare `data:` URL is already unique.
 *  - Nothing inside a `node_modules` directory is stamped. An extension's
 *    dependencies are not what the operator edited, and re-executing them per
 *    reload would both widen the leak below and re-run whatever global setup a
 *    package does at import time. They stay shared across generations, exactly
 *    as they are shared with the host. `evictExtensionCommonJsCache` skips
 *    `node_modules` for the same reason, so the rule holds in both module
 *    formats rather than only in ESM.
 *
 * What the hook does not do is bound the stamp to the extension's own tree. It
 * stamps whatever a stamped parent resolves to, so an extension that imported a
 * file from outside `data/extensions` would get a fresh copy of that file, and
 * of everything it imports, per reload. No shipped extension does this and
 * nothing in the host hands one such a path, but the limit is real: this hook
 * is inert only for modules never reached from a generation-stamped parent, not
 * for everything outside the extension directory.
 */
const RESOLVE_HOOKS_SOURCE = `
const KEY = ${JSON.stringify(EXTENSION_GENERATION_QUERY)}
const NODE_MODULES = '/node_modules/'

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  const parentUrl = context && context.parentURL
  if (typeof parentUrl !== 'string' || !parentUrl.startsWith('file:')) return resolved
  const generation = new URL(parentUrl).searchParams.get(KEY)
  if (!generation) return resolved
  if (typeof resolved.url !== 'string' || !resolved.url.startsWith('file:')) return resolved
  const target = new URL(resolved.url)
  if (target.searchParams.has(KEY)) return resolved
  if (target.pathname.includes(NODE_MODULES)) return resolved
  target.searchParams.set(KEY, generation)
  return { ...resolved, url: target.href, shortCircuit: true }
}
`

const RESOLVE_HOOKS_SPECIFIER = `data:text/javascript,${encodeURIComponent(RESOLVE_HOOKS_SOURCE)}`

/**
 * Registration is per process and must not happen twice: a second registration
 * adds a second copy of the hook to the chain, which stamps nothing new but
 * costs a hop on every resolve in the process. The flag lives on `globalThis`
 * rather than in module scope because Next's dev server re-evaluates this
 * module on hot reload, which would otherwise register a fresh copy per edit.
 */
const REGISTERED_FLAG = '__swarmclawExtensionResolveHooksRegistered__'

interface RegistrationHost {
  [REGISTERED_FLAG]?: boolean
}

/**
 * Registers the resolve hook, once. Returns whether the hook is active.
 *
 * `false` means a reload still re-executes the extension's entry file but not
 * the modules it imports -- degraded, not broken. The caller decides what to
 * say about it; this function does not log, because it is also run outside the
 * host by the standalone runtime tests.
 */
export function ensureExtensionResolveHooks(): boolean {
  const host = globalThis as unknown as RegistrationHost
  if (host[REGISTERED_FLAG] === true) return true
  try {
    register(RESOLVE_HOOKS_SPECIFIER)
    host[REGISTERED_FLAG] = true
    return true
  } catch {
    return false
  }
}

/** The module URL an extension file is imported under for a given load generation. */
export function extensionModuleUrl(filePath: string, generation: number): string {
  const url = pathToFileURL(filePath)
  url.searchParams.set(EXTENSION_GENERATION_QUERY, String(generation))
  return url.href
}

/**
 * Bundler note: the specifier is a runtime value, so webpack and Turbopack both
 * try to turn this into a bundled dependency and, failing that, into a
 * `require()` -- which is the very call that cannot load ESM on Electron. The
 * two ignore comments are what keep it a real `import()` in the built server.
 * They are load-bearing; deleting them reintroduces the defect only in the
 * production build, where no unit test would see it.
 */
function dynamicImport(url: string): Promise<Record<string, unknown>> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url) as Promise<Record<string, unknown>>
}

/**
 * Imports one extension entry file for the given generation.
 *
 * Leak, measured rather than estimated (see `extension-module-loader.test.ts`
 * and the task report): every generation adds one module record per file in the
 * extension's own module graph to Node's ESM registry, and every one of them
 * stays for the life of the process. Node exposes no way to remove them. The
 * host bumps the generation only on an explicit reload -- installing, editing,
 * enabling, disabling or deleting an extension, or a write the extensions
 * directory watcher sees -- not per request, so the count grows with operator
 * actions rather than with traffic. `node_modules` is excluded from stamping
 * above and from the CommonJS eviction below, so an extension's dependencies
 * are imported once for the process no matter how often it reloads.
 */
export async function importExtensionModule(filePath: string, generation: number): Promise<Record<string, unknown>> {
  ensureExtensionResolveHooks()
  return dynamicImport(extensionModuleUrl(filePath, generation))
}

/**
 * The value an extension module means to export.
 *
 * `import()` hands back a namespace object either way, but the two module
 * systems put the extension in different places: a CommonJS module's
 * `module.exports` arrives as `default`, and so does an ESM `export default`.
 * A namespace with no `default` is an ESM module written with named exports
 * only, and is itself the object to read.
 */
export function extensionModuleExport(namespace: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(namespace, 'default')) return namespace.default
  return namespace
}

/**
 * The key Node would file `target` under in the module cache: its resolved
 * realpath, or the path unchanged when it does not resolve.
 */
export function moduleCacheKey(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * Evicts a CommonJS extension, and the workspace files it loaded, from
 * `require.cache`. Its `node_modules` are deliberately left in place.
 *
 * Still needed after the move to `import()`. Importing a CommonJS file goes
 * through Node's CommonJS loader underneath, which keeps its own realpath-keyed
 * cache: a generation-stamped URL gives the ESM side a fresh module record, but
 * the CommonJS side hands that record the *cached* `module.exports` unless the
 * entry is evicted first. Measured on both runtimes -- with this eviction a
 * CommonJS extension and its workspace files re-execute per generation, without
 * it neither does.
 *
 * `node_modules` is skipped so that the two module formats agree. The resolve
 * hook above does not stamp a dependency, so an ESM extension's dependencies
 * are evaluated once per process; sweeping them out of `require.cache` here
 * made a CommonJS extension's dependencies re-execute on *every* reload
 * instead, which is measurably worse than a stale copy: a connection pool, a
 * process listener or a native binding created at a package's import time was
 * created again per reload, with the previous one still registered and now
 * unreachable. The cost of skipping them is that a dependency changed on disk
 * -- upgraded through `installExtensionDependencies`, or edited inside
 * `node_modules` -- is not picked up until the process restarts. That was
 * already true for every ESM extension; it is now true for both, which is what
 * the extension-facing documentation says.
 *
 * Node keys that cache by the *resolved realpath* of a module, not by the path
 * the caller handed to `require()`, so the eviction key has to be realpath'd to
 * match. DATA_DIR is `path.resolve`d and deliberately not realpath'd, because it
 * is also shown to people and written into stored state; on a host whose data
 * directory sits behind a symlink the unrealpath'd key therefore matched nothing
 * and the eviction silently did nothing at all, leaving the previous module
 * object live until the process restarted. macOS is the everyday case:
 * `os.tmpdir()` is `/var/folders/...`, a link to `/private/var/folders/...`.
 * Realpathing here, rather than realpathing DATA_DIR for everything, confines
 * the change to the one place that has to agree with Node's own key.
 *
 * `realpathSync` throws for a path that no longer resolves: a file deleted
 * between the directory listing and this call, or a workspace directory that was
 * never created. Falling back to the unresolved path in that case is not a claim
 * that the fallback still finds the right cache entry -- it does not, because
 * Node keyed the entry by the realpath computed at *load* time. It is harmless
 * regardless: the caller evicts immediately before importing the same file, and
 * a file that has vanished fails that import moments later whatever this
 * managed to evict.
 *
 * `containerRoot` bounds the sweep. A workspace directory which is, or has
 * become, a symlink to somewhere broad would otherwise widen the prefix match
 * into a sweep of the process-wide `require.cache`, shared by every module the
 * host and every extension has ever required. Extensions run in-process and can
 * already reach worse than that directly, so this is not closing an escalation
 * of capability -- it is closing an accidental blast radius.
 */
export function evictExtensionCommonJsCache(
  moduleCache: Record<string, unknown>,
  options: { entryPaths: string[]; containerDir: string; containerRoot: string },
): void {
  for (const entryPath of options.entryPaths) {
    delete moduleCache[moduleCacheKey(entryPath)]
  }
  const containerDir = moduleCacheKey(options.containerDir)
  const containerRoot = moduleCacheKey(options.containerRoot)
  const isWithinRoot =
    containerDir === containerRoot || containerDir.startsWith(`${containerRoot}${path.sep}`)
  if (!isWithinRoot) return
  const nodeModulesSegment = `${path.sep}node_modules${path.sep}`
  for (const cacheKey of Object.keys(moduleCache)) {
    if (!cacheKey.startsWith(`${containerDir}${path.sep}`)) continue
    if (cacheKey.slice(containerDir.length).includes(nodeModulesSegment)) continue
    delete moduleCache[cacheKey]
  }
}
