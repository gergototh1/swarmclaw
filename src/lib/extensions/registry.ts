/**
 * Browser-side registry for pages contributed by installed extensions.
 *
 * An extension's page bundle is built separately from this app and arrives as a
 * plain `<script>` tag in an already-running document. It must therefore *not*
 * bundle React: two React instances in one tree make every hook inside the
 * extension's component throw at runtime, with a stack that points into React
 * internals rather than at the mis-built bundle. The host publishes its own
 * React on `window.swarmclaw.modules` (see `components/layout/extension-host.tsx`)
 * and `registerPage` refuses any component that hands back a different instance,
 * so a mis-built extension fails at registration with an actionable message
 * instead of at first render with a cryptic one.
 *
 * None of this is a trust boundary. An extension bundle is a same-origin page
 * script with full access to the DOM, to `window.swarmclaw` and to every network
 * call this app can make; the checks here catch build mistakes, nothing else.
 */

import type { ComponentType } from 'react'
import { hmrSingleton } from '@/lib/shared-utils'

/** Calls an extension's server-side method; bound to one extension by the page renderer. */
export type ExtensionPageRpc = (method: string, body?: object) => Promise<unknown>

/** The component an extension bundle registers for one of its declared pages or tool panels. */
export type ExtensionPageComponent = ComponentType<{
  extensionId: string
  rpc: ExtensionPageRpc
  /** Tool panels only: the reference the tool put in its answer as `panel.id`. */
  refId?: string
  /** Tool panels only: closes the panel. */
  onClose?: () => void
}>

export interface RegisterPageOptions {
  /**
   * The React binding the bundle *imported* — the same object its components
   * close over. Reading `window.swarmclaw.modules.react` back at the call site
   * instead makes this check vacuous: it always matches, and the component still
   * renders against whatever React it was bundled with.
   */
  react: unknown
  /**
   * The extension that owns the page. Required, because pages are keyed by
   * `"<extensionId>:<pageId>"` so two extensions can both ship a page called
   * `main`. A classic (non-module) bundle reads it at top-level script scope
   * from the tag the loader injected: `document.currentScript?.dataset.extension`.
   */
  extensionId: string
}

export interface RegisteredPage {
  Component: ExtensionPageComponent
  extensionId: string
  pageId: string
}

export interface ExtensionRegistryHost {
  /** The host's own React module namespace. */
  react: unknown
  /**
   * The extension whose bundle is executing right now, or `undefined` when that
   * cannot be determined (a registration from a timer or a promise callback, or
   * a non-browser test). Defaults to the `data-extension` attribute the loader
   * stamps on the injected script tag, read through `document.currentScript`.
   */
  currentExtensionId?: () => string | undefined
  /**
   * The `src` of the script tag whose bundle is executing right now, or
   * `undefined` when that cannot be determined (the same later-tick and
   * non-browser cases as `currentExtensionId`). Defaults to reading
   * `document.currentScript`, which for a bundle this app injected is exactly
   * the string `assetUrl` produced, so a caller can reproduce it from the
   * `entry` of the page it is waiting for.
   */
  currentBundleSrc?: () => string | undefined
}

export interface ExtensionRegistry {
  /**
   * Record the component an extension's bundle contributes for one of its pages.
   *
   * The bundle must pass the `react` binding it imported and its own
   * `extensionId`:
   *
   * ```js
   * import * as React from 'react'                       // external -> host copy
   * const extensionId = document.currentScript?.dataset.extension
   * window.swarmclaw.registerPage('main', Main, { react: React, extensionId })
   * ```
   *
   * Do not pass `window.swarmclaw.modules.react` as `react`. That value is the
   * host's React by definition, so the identity check passes for every bundle,
   * including one that carries its own React and will throw "Invalid hook call"
   * at first render. Only the imported binding proves anything.
   *
   * These are build-correctness checks, not a security boundary: an extension
   * bundle runs as a same-origin page script with full DOM access, so it can do
   * anything this app can do regardless of what it passes here.
   */
  registerPage(pageId: string, Component: ExtensionPageComponent, opts: RegisterPageOptions): void
  getPage(extensionId: string, pageId: string): RegisteredPage | undefined
  /**
   * Run `cb` when the given extension's page is registered, immediately if it
   * already is. A bundle is fetched asynchronously and may register long after
   * the page component mounted, so a renderer subscribes rather than polling.
   * Returns an unsubscribe function.
   */
  onPageRegistered(extensionId: string, pageId: string, cb: (pageId: string) => void): () => void
  /**
   * The most recent registration `registerPage` refused for this page, if any.
   *
   * A bundle calls `registerPage` at top-level script scope, so a refusal throws
   * *inside the bundle's own execution*: the browser reports an uncaught error to
   * the console, `script.onload` still fires, and `loadExtensionPage` still
   * resolves. Nothing about the load tells the renderer that anything went wrong,
   * which is exactly how a mis-built extension ends up showing a blank page. The
   * refusal is recorded here so the page route can render the message that until
   * now only existed in devtools.
   *
   * When nothing was refused under `pageId`, the newest refusal recorded by the
   * *same bundle* is returned instead: a bundle that registered under a mistyped
   * page id leaves nothing under the id the host is waiting for, and its message
   * names the id it actually used. Renderers must therefore treat the message as
   * the authority on which page it describes rather than assuming it is `pageId`.
   *
   * `bundleSrc` is what scopes that fallback, and callers should pass
   * `assetUrl(extensionId, entry)` for the page they are waiting for. An
   * extension that ships one entry per page loads bundles that fail
   * independently, and without the scope a page whose own bundle silently never
   * registered would be reported with a sibling bundle's refusal — a message
   * about a different page, in place of the accurate "never registered" one.
   * Refusals recorded outside top-level bundle execution carry no `bundleSrc`
   * and so are never used as a fallback for a bundle that has one.
   */
  registrationRefusal(extensionId: string, pageId: string, bundleSrc?: string): PageRegistrationRefusal | undefined
}

/** A `registerPage` call the registry rejected, kept so a renderer can explain a page that never appeared. */
export interface PageRegistrationRefusal {
  /**
   * The extension whose bundle was executing, which is not necessarily the id the
   * call claimed — a bundle registering under someone else's id is one of the
   * refusals recorded here.
   */
  extensionId: string
  /** The page id the call passed, which the extension may never have declared. */
  pageId: string
  /** The thrown message, written for the extension author. */
  message: string
  /** `Date.now()` at the refusal. */
  at: number
  /**
   * The `src` of the script tag that was executing, exactly as
   * `loadExtensionPage` set it, so `assetUrl(extensionId, entry)` reproduces it.
   * `undefined` when the refusal did not happen during top-level bundle
   * execution, which is also the case in a non-browser test.
   */
  bundleSrc?: string
}

/**
 * How many refusals one registry keeps.
 *
 * Only the newest per page is ever read, so this exists purely to bound a
 * pathological bundle that retries `registerPage` in a loop. Small on purpose:
 * a page with more than a handful of failed registrations behind it is already
 * being told the newest one.
 */
const MAX_REFUSALS = 20

/** The registry key for one page. Extension-scoped, so page ids only need to be unique per extension. */
export function pageKey(extensionId: string, pageId: string): string {
  return `${extensionId}:${pageId}`
}

/**
 * The extension whose bundle is currently executing, per the `data-extension`
 * attribute `loadExtensionPage` stamps on the script tag it injects. `undefined`
 * outside synchronous top-level bundle execution, where the browser gives us
 * nothing to check against.
 */
function executingExtensionId(): string | undefined {
  if (typeof document === 'undefined') return undefined
  return document.currentScript?.dataset.extension
}

/**
 * The `src` attribute of the script tag currently executing. Read with
 * `getAttribute` rather than the `src` property, which the browser resolves to
 * an absolute URL: the attribute is the string `loadExtensionPage` assigned, so
 * it compares equal to `assetUrl(extensionId, entry)` without any normalising.
 */
function executingBundleSrc(): string | undefined {
  if (typeof document === 'undefined') return undefined
  return document.currentScript?.getAttribute('src') ?? undefined
}

/**
 * True for something React can actually render as an element type.
 *
 * Function components are the common case. `memo()`, `forwardRef()` and `lazy()`
 * return plain objects rather than functions, and React identifies those by a
 * `$$typeof` symbol registered as `Symbol.for('react.<kind>')`, so the symbol's
 * description is what separates them from any other object.
 *
 * Accepting every non-null object instead (which this used to do) let a bundle
 * pass its whole module namespace — `registerPage('main', mod, ...)` rather than
 * `mod.default` — and store cleanly, only to die in the renderer with React's own
 * "type is invalid" wording, which names nothing the author can act on.
 */
function isComponentLike(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (typeof value !== 'object' || value === null) return false
  const marker = (value as { $$typeof?: unknown }).$$typeof
  return typeof marker === 'symbol' && (marker.description ?? '').startsWith('react.')
}

/** What a refused `registerPage` was handed, for an error message the author can act on. */
function describeValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    // A module namespace stringifies to "[object Module]", which on its own reads
    // like a type name rather than a mistake, so name the fix alongside it.
    const keys = Object.keys(value as Record<string, unknown>)
    if (keys.includes('default')) return 'a module object (pass its .default export, not the whole module)'
    return `an object with keys [${keys.slice(0, 5).join(', ')}]`
  }
  return String(value)
}

export function createExtensionRegistry(host: ExtensionRegistryHost): ExtensionRegistry {
  const pages = new Map<string, RegisteredPage>()
  const waiters = new Map<string, Set<(pageId: string) => void>>()
  const refusals: PageRegistrationRefusal[] = []
  const currentExtensionId = host.currentExtensionId || executingExtensionId
  const currentBundleSrc = host.currentBundleSrc || executingBundleSrc

  /**
   * Record why a registration was refused, then throw it.
   *
   * Recording before throwing is the whole point: the throw lands in the
   * extension bundle's own top-level execution, so it never reaches the host and
   * the page route would otherwise have nothing to show but an empty frame.
   * Refusals are attributed to the bundle that was executing where that is
   * knowable, so a bundle claiming another extension's id cannot hide its
   * mistake under that id or plant a message on it.
   */
  function refuse(pageId: string, reportedId: string, message: string): never {
    const owner = currentExtensionId() ?? reportedId
    if (owner) {
      refusals.push({ extensionId: owner, pageId, message, at: Date.now(), bundleSrc: currentBundleSrc() })
      if (refusals.length > MAX_REFUSALS) refusals.shift()
    }
    throw new Error(message)
  }

  return {
    registerPage(pageId, Component, opts) {
      // `opts` is typed, but the caller is untyped JavaScript from a separately
      // built bundle, so a missing object is as likely as a wrong React.
      const reportedId = opts && typeof opts.extensionId === 'string' ? opts.extensionId.trim() : ''
      if (!opts || opts.react !== host.react) {
        refuse(pageId, reportedId,
          `Extension page "${pageId}" was built against a different React instance than the host. ` +
          'Pass the react binding the bundle imported, with react, react-dom and react/jsx-runtime ' +
          'built as externals that resolve to the host copies. Do not read ' +
          'window.swarmclaw.modules.react back and pass that: it matches by definition, so it defeats ' +
          'this check while your component still renders against its own React.',
        )
      }

      if (!reportedId) {
        refuse(pageId, reportedId,
          `Extension page "${pageId}" was registered without an extensionId. Read it at top-level ` +
          'script scope from document.currentScript?.dataset.extension, which the loader stamps on ' +
          'the bundle tag.',
        )
      }
      // The reported id decides which page a renderer finds, so it is checked
      // against the bundle the loader actually injected rather than trusted.
      const executing = currentExtensionId()
      if (executing !== undefined && executing !== reportedId) {
        refuse(pageId, reportedId,
          `Extension page "${pageId}" was registered with extensionId "${reportedId}", but this ` +
          `bundle belongs to extension "${executing}". An extension can only register its own pages; ` +
          'read the id from document.currentScript?.dataset.extension instead of hard-coding it.',
        )
      }

      if (!isComponentLike(Component)) {
        refuse(pageId, reportedId,
          `Extension page "${pageKey(reportedId, pageId)}" was registered with ${describeValue(Component)} ` +
          'instead of a component. A bundle whose module interop leaves the default export undefined ' +
          'hits this; check what the bundle passes as the second argument to registerPage.',
        )
      }

      const key = pageKey(reportedId, pageId)
      pages.set(key, { Component, extensionId: reportedId, pageId })
      // Copy before iterating: a callback may register or unsubscribe others.
      const pending = waiters.get(key)
      waiters.delete(key)
      if (pending) for (const cb of [...pending]) cb(pageId)
    },

    getPage(extensionId, pageId) {
      return pages.get(pageKey(extensionId, pageId))
    },

    onPageRegistered(extensionId, pageId, cb) {
      const key = pageKey(extensionId, pageId)
      if (pages.has(key)) {
        cb(pageId)
        return () => {}
      }
      let set = waiters.get(key)
      if (!set) {
        set = new Set()
        waiters.set(key, set)
      }
      const subscribers = set
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },

    registrationRefusal(extensionId, pageId, bundleSrc) {
      for (let i = refusals.length - 1; i >= 0; i--) {
        const refusal = refusals[i]
        if (refusal.extensionId === extensionId && refusal.pageId === pageId) return refusal
      }
      // Nothing under this page id, so fall back to the newest refusal from the
      // same bundle: one that registered under a mistyped id records nothing
      // under the id the host waits for, and its message names the id it
      // actually used. Scoped to the bundle because an extension may ship one
      // entry per page, and a refusal from a sibling entry says nothing about
      // the page being waited for.
      for (let i = refusals.length - 1; i >= 0; i--) {
        const refusal = refusals[i]
        if (refusal.extensionId === extensionId && refusal.bundleSrc === bundleSrc) return refusal
      }
      return undefined
    },
  }
}

// --- bundle loading (browser only) ---

/**
 * In-flight and completed bundle loads, keyed by extension and entry, so a page
 * that mounts twice (route churn, StrictMode) appends one script tag, not two.
 * Kept on `globalThis` so a Next.js HMR reload does not lose track of tags that
 * are already in the document.
 */
const bundleLoads = hmrSingleton(
  'extensionRegistry_bundleLoads',
  () => new Map<string, Promise<void>>(),
)

/**
 * URL of one built asset of an extension.
 *
 * `entry` and `css` in a page declaration are workspace-relative and start with
 * `dist/`, but `GET /api/extensions/<id>/assets/<rest>` takes `<rest>` relative
 * to `dist`, so exactly one leading `dist/` segment is dropped here.
 *
 * Load-bearing dependency: this is only safe because `validateExtensionPages`
 * (`lib/server/extensions/extension-pages.ts`) rejects `..` in `entry` and `css`.
 * `encodeURIComponent` leaves dots alone, and a browser normalises `..` before
 * it ever issues the request, so an unvalidated relative path would let a page
 * declaration point this script tag at an arbitrary same-origin URL. Do not
 * relax that validator without hardening this function first.
 */
export function assetUrl(extensionId: string, rel: string): string {
  const distRelative = rel.replace(/^dist\//, '')
  const path = distRelative.split('/').map(encodeURIComponent).join('/')
  return `/api/extensions/${encodeURIComponent(extensionId)}/assets/${path}`
}

/**
 * Fetch an extension page's stylesheet and bundle into the live document.
 *
 * Resolves once the bundle has executed, which is when it has had the chance to
 * call `window.swarmclaw.registerPage`. Callers must make sure the registry is
 * installed first by calling `getHostRegistry()` themselves: the install is
 * idempotent, and doing it at the call site keeps this independent of where
 * `ExtensionHost` sits in the tree.
 */
export function loadExtensionPage(page: { extensionId: string; entry: string; css?: string }): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('loadExtensionPage is browser-only: there is no document to load the bundle into'))
  }

  const key = `${page.extensionId}:${page.entry}`
  const existing = bundleLoads.get(key)
  if (existing) return existing

  const load = new Promise<void>((resolve, reject) => {
    let link: HTMLLinkElement | null = null
    if (page.css) {
      link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = assetUrl(page.extensionId, page.css)
      link.dataset.extension = page.extensionId
      document.head.appendChild(link)
    }
    const script = document.createElement('script')
    script.src = assetUrl(page.extensionId, page.entry)
    script.async = true
    script.dataset.extension = page.extensionId
    script.onload = () => resolve()
    script.onerror = () => {
      // The load is evicted below, so a retry rebuilds both tags. Drop the dead
      // ones first, or the retry appends a second stylesheet for the same href
      // and leaves a script tag that will never load behind it.
      link?.remove()
      script.remove()
      reject(new Error(`Extension bundle failed to load: ${script.src}`))
    }
    document.head.appendChild(script)
  })

  // A failed load must not be cached: the user may reinstall or rebuild the
  // extension and retry without reloading the whole app. Delete only our own
  // entry, matching the inflight-GET cleanup in `lib/app/api-client.ts`, so a
  // retry that already started is not evicted by the failure that preceded it.
  load.catch(() => {
    if (bundleLoads.get(key) === load) bundleLoads.delete(key)
  })
  bundleLoads.set(key, load)
  return load
}

/** Forget which bundles have been loaded. Test-only. */
export function resetRegistryForTests(): void {
  bundleLoads.clear()
}
