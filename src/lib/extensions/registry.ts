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
 */

import type { ComponentType } from 'react'
import { hmrSingleton } from '@/lib/shared-utils'

/** Calls an extension's server-side method; bound to one extension by the page renderer. */
export type ExtensionPageRpc = (method: string, body?: object) => Promise<unknown>

/** The component an extension bundle registers for one of its declared pages. */
export type ExtensionPageComponent = ComponentType<{ extensionId: string; rpc: ExtensionPageRpc }>

export interface RegisterPageOptions {
  /**
   * The host React instance, which the bundle must read from
   * `window.swarmclaw.modules.react` rather than importing its own copy.
   */
  react: unknown
  /** The extension that owns the page. Optional, and only used for diagnostics. */
  extensionId?: string
}

export interface RegisteredPage {
  Component: ExtensionPageComponent
  extensionId?: string
}

export interface ExtensionRegistry {
  registerPage(id: string, Component: ExtensionPageComponent, opts: RegisterPageOptions): void
  getPage(id: string): RegisteredPage | undefined
  /**
   * Run `cb` when the page with `id` is registered, immediately if it already is.
   * A bundle is fetched asynchronously and may register long after the page
   * component mounted, so a renderer subscribes rather than polling. Returns an
   * unsubscribe function.
   */
  onPageRegistered(id: string, cb: (id: string) => void): () => void
}

export function createExtensionRegistry(host: { react: unknown }): ExtensionRegistry {
  const pages = new Map<string, RegisteredPage>()
  const waiters = new Map<string, Set<(id: string) => void>>()

  return {
    registerPage(id, Component, opts) {
      // `opts` is typed, but the caller is untyped JavaScript from a separately
      // built bundle, so a missing object is as likely as a wrong React.
      if (!opts || opts.react !== host.react) {
        throw new Error(
          `Extension page "${id}" was built against a different React instance; ` +
          'build with react, react-dom and react/jsx-runtime as externals resolved from window.swarmclaw.modules',
        )
      }
      pages.set(id, { Component, extensionId: opts.extensionId })
      // Copy before iterating: a callback may register or unsubscribe others.
      const pending = waiters.get(id)
      waiters.delete(id)
      if (pending) for (const cb of [...pending]) cb(id)
    },

    getPage(id) {
      return pages.get(id)
    },

    onPageRegistered(id, cb) {
      if (pages.has(id)) {
        cb(id)
        return () => {}
      }
      let set = waiters.get(id)
      if (!set) {
        set = new Set()
        waiters.set(id, set)
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
 * installed first: React runs child effects before parent effects, so a page
 * component cannot rely on `ExtensionHost`'s effect having run, and calls
 * `getHostRegistry()` itself before loading.
 */
export function loadExtensionPage(page: { extensionId: string; entry: string; css?: string }): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('loadExtensionPage is browser-only: there is no document to load the bundle into'))
  }

  const key = `${page.extensionId}:${page.entry}`
  const existing = bundleLoads.get(key)
  if (existing) return existing

  const load = new Promise<void>((resolve, reject) => {
    if (page.css) {
      const link = document.createElement('link')
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
    script.onerror = () => reject(new Error(`Extension bundle failed to load: ${script.src}`))
    document.head.appendChild(script)
  })

  // A failed load must not be cached: the user may reinstall or rebuild the
  // extension and retry without reloading the whole app.
  load.catch(() => { bundleLoads.delete(key) })
  bundleLoads.set(key, load)
  return load
}

/** Forget which bundles have been loaded. Test-only. */
export function resetRegistryForTests(): void {
  bundleLoads.clear()
}
