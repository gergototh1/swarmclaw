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

/** The component an extension bundle registers for one of its declared pages. */
export type ExtensionPageComponent = ComponentType<{ extensionId: string; rpc: ExtensionPageRpc }>

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
}

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

/** `memo()` and `forwardRef()` return objects, not functions, so both shapes count. */
function isComponentLike(value: unknown): boolean {
  return typeof value === 'function' || (typeof value === 'object' && value !== null)
}

export function createExtensionRegistry(host: ExtensionRegistryHost): ExtensionRegistry {
  const pages = new Map<string, RegisteredPage>()
  const waiters = new Map<string, Set<(pageId: string) => void>>()
  const currentExtensionId = host.currentExtensionId || executingExtensionId

  return {
    registerPage(pageId, Component, opts) {
      // `opts` is typed, but the caller is untyped JavaScript from a separately
      // built bundle, so a missing object is as likely as a wrong React.
      if (!opts || opts.react !== host.react) {
        throw new Error(
          `Extension page "${pageId}" was built against a different React instance than the host. ` +
          'Pass the react binding the bundle imported, with react, react-dom and react/jsx-runtime ' +
          'built as externals that resolve to the host copies. Do not read ' +
          'window.swarmclaw.modules.react back and pass that: it matches by definition, so it defeats ' +
          'this check while your component still renders against its own React.',
        )
      }

      const reportedId = typeof opts.extensionId === 'string' ? opts.extensionId.trim() : ''
      if (!reportedId) {
        throw new Error(
          `Extension page "${pageId}" was registered without an extensionId. Read it at top-level ` +
          'script scope from document.currentScript?.dataset.extension, which the loader stamps on ' +
          'the bundle tag.',
        )
      }
      // The reported id decides which page a renderer finds, so it is checked
      // against the bundle the loader actually injected rather than trusted.
      const executing = currentExtensionId()
      if (executing !== undefined && executing !== reportedId) {
        throw new Error(
          `Extension page "${pageId}" was registered with extensionId "${reportedId}", but this ` +
          `bundle belongs to extension "${executing}". An extension can only register its own pages; ` +
          'read the id from document.currentScript?.dataset.extension instead of hard-coding it.',
        )
      }

      if (!isComponentLike(Component)) {
        throw new Error(
          `Extension page "${pageKey(reportedId, pageId)}" was registered with ${String(Component)} ` +
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
