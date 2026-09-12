'use client'

import { Component, useCallback, useMemo, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { MainContent } from '@/components/layout/main-content'
import { getHostRegistry } from '@/components/layout/extension-host'
import { useExtensionPagesState } from '@/hooks/use-extension-pages'
import {
  useRegisteredExtensionComponent,
  type ExtensionComponentFailure,
} from '@/hooks/use-registered-extension-component'
import { pageKey } from '@/lib/extensions/registry'
import { looksLikeDuplicateReact } from '@/lib/extensions/duplicate-react'

/**
 * The route every extension-contributed page renders at.
 *
 * The declaration side of this (`ui.pages` in an extension's manifest, validated
 * by `lib/server/extensions/extension-pages.ts`) only says *that* a page exists.
 * Here is where the browser actually fetches the extension's built bundle, waits
 * for it to hand back a component through `window.swarmclaw.registerPage`, and
 * renders it.
 *
 * Most of this file is failure handling, deliberately. This route is the only
 * place a user ever finds out that an installed extension is broken, and every
 * way it breaks looks identical from here by default — an empty frame. The four
 * that matter:
 *
 * 1. the assets 404 (never built, or a bad `entry`) — the loader rejects;
 * 2. the bundle runs but never calls `registerPage` — nothing distinguishes this
 *    from success except that no component arrives, hence the timeout;
 * 3. `registerPage` refused the call. The throw happens inside the bundle's own
 *    top-level execution, so `script.onload` still fires and the loader still
 *    resolves: the only trace is the refusal the registry records for us;
 * 4. the component throws on its first render, overwhelmingly "Invalid hook call"
 *    from a bundle that shipped its own React. The registry cannot catch this one
 *    (a bundle that passes `window.swarmclaw.modules.react` satisfies the
 *    identity check by definition), so the error boundary below is the only net.
 *
 * Two more failures happen before any bundle is reached: the page list may not
 * name this path, and the request for the page list may itself have failed. They
 * are separate messages because they call for opposite actions, and the segment
 * is optional in the route so that a bare `/x` gets the first of them rather than
 * Next's own 404, which explains nothing about extensions.
 */

function PageMessage({ tone, title, detail, hint }: ExtensionComponentFailure & { tone: 'error' | 'muted' }) {
  const error = tone === 'error'
  return (
    <div className="flex-1 overflow-y-auto px-8 py-10">
      <div
        className={`max-w-[720px] rounded-lg border px-5 py-4 ${
          error ? 'border-danger/20 bg-danger/[0.06]' : 'border-line-subtle bg-surface'
        }`}
      >
        <h1 className={`text-[14px] font-700 tracking-[-0.01em] ${error ? 'text-danger' : 'text-text-2'}`}>{title}</h1>
        <p className="mt-2 text-[13px] leading-[1.6] text-text-2 whitespace-pre-wrap break-words">{detail}</p>
        {hint && <p className="mt-2 text-[12px] leading-[1.6] text-text-3">{hint}</p>}
      </div>
    </div>
  )
}

/**
 * Catches a throw from the extension's own component.
 *
 * Reset by remounting: the route gives this a `key` of the page it wraps, so
 * navigating to a different extension page clears a previous crash instead of
 * showing it for the new page.
 */
class ExtensionPageBoundary extends Component<
  { extensionId: string; pageId: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: Error | null } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { extensionId, pageId } = this.props
    return (
      <PageMessage
        tone="error"
        title={`Extension "${extensionId}" crashed while rendering page "${pageId}"`}
        detail={error.message}
        hint={looksLikeDuplicateReact(error.message)
          ? 'That error means the page is running against a second copy of React. The bundle shipped its own: '
            + 'build react, react-dom and react/jsx-runtime as externals resolving to window.swarmclaw.modules, and '
            + 'pass the react binding the bundle imported to registerPage (not window.swarmclaw.modules.react, which '
            + 'matches by definition and proves nothing).'
          : 'The error came from the extension\'s component, not from SwarmClaw. Reload after rebuilding the extension.'}
      />
    )
  }
}

export default function ExtensionPageRoute() {
  const pathname = usePathname()
  const { pages, loaded, error: pagesError } = useExtensionPagesState()

  // Declared paths are exactly `/x/<slug>`. A deeper path still resolves to its
  // `/x/<slug>` prefix so an extension page can do client-side sub-routing, which
  // also keeps this in step with how the rail decides an entry is active.
  const page = useMemo(
    () => pages.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`)),
    [pages, pathname],
  )

  const extensionId = page?.extensionId
  const pageId = page?.id
  const entry = page?.entry
  const css = page?.css

  const state = useRegisteredExtensionComponent(
    extensionId && pageId && entry
      ? { extensionId, componentId: pageId, entry, css, declaredIn: 'ui.pages' }
      : null,
  )

  const rpc = useCallback(
    (method: string, body?: object) => getHostRegistry().rpc(extensionId ?? '', method, body),
    [extensionId],
  )

  if (!page) {
    if (!loaded) {
      return (
        <MainContent>
          <PageMessage tone="muted" title="Loading extension pages…" detail="Looking up which extension owns this page." />
        </MainContent>
      )
    }
    // A list that never arrived is not a list that says no. Told apart because the
    // remedies are opposite, and because the restart that most often causes this
    // is the one right after an extension is installed: reporting it as "not
    // installed" sends the user to undo the thing that just worked.
    if (pagesError) {
      return (
        <MainContent>
          <PageMessage
            tone="error"
            title="Could not load the list of extension pages"
            detail={'SwarmClaw could not fetch which pages installed extensions contribute, so it does not know '
              + `whether one owns ${pathname}. The request failed with: ${pagesError}`}
            hint={'This is usually the server restarting, which is what happens right after an extension is '
              + 'installed. The list is retried automatically as soon as the connection to the server comes back; '
              + 'reload if the page does not appear within a few seconds of that.'}
          />
        </MainContent>
      )
    }
    return (
      <MainContent>
        <PageMessage
          tone="error"
          title={`No installed extension contributes a page at ${pathname}`}
          detail="Extension pages come from the ui.pages declaration of an installed, enabled extension."
          hint="Check that the extension is installed and enabled on the Extensions screen, and that its declared path matches this URL."
        />
      </MainContent>
    )
  }

  if (state.status === 'error') {
    return <MainContent><PageMessage tone="error" {...state.failure} /></MainContent>
  }

  if (state.status === 'loading') {
    return (
      <MainContent>
        <PageMessage
          tone="muted"
          title={`Loading ${page.label}…`}
          detail={`Fetching the page bundle contributed by extension "${page.extensionId}".`}
        />
      </MainContent>
    )
  }

  const ExtensionComponent = state.registered.Component
  return (
    <MainContent>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ExtensionPageBoundary
          key={pageKey(page.extensionId, page.id)}
          extensionId={page.extensionId}
          pageId={page.id}
        >
          <ExtensionComponent extensionId={page.extensionId} rpc={rpc} />
        </ExtensionPageBoundary>
      </div>
    </MainContent>
  )
}
