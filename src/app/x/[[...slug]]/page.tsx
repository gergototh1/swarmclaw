'use client'

import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { MainContent } from '@/components/layout/main-content'
import { getHostRegistry } from '@/components/layout/extension-host'
import { useExtensionPagesState } from '@/hooks/use-extension-pages'
import { assetUrl, loadExtensionPage, pageKey, type RegisteredPage } from '@/lib/extensions/registry'
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

/**
 * How long a loaded bundle gets to call `registerPage` before this gives up.
 *
 * Generous because a bundle may register from a dynamic import rather than at
 * top-level script scope, and because the alternative to waiting is telling the
 * user an extension is broken when it is merely slow.
 */
const REGISTER_TIMEOUT_MS = 10_000

interface Failure {
  title: string
  detail: string
  /** What the extension author should change. Omitted when the detail already says it. */
  hint?: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; registered: RegisteredPage }
  | { status: 'error'; failure: Failure }

function PageMessage({ tone, title, detail, hint }: Failure & { tone: 'error' | 'muted' }) {
  const error = tone === 'error'
  return (
    <div className="flex-1 overflow-y-auto px-8 py-10">
      <div
        className={`max-w-[720px] rounded-[14px] border px-5 py-4 ${
          error ? 'border-danger/20 bg-danger/[0.06]' : 'border-white/[0.06] bg-white/[0.02]'
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
  const [tracked, setTracked] = useState<{ target: string; state: LoadState }>({
    target: '',
    state: { status: 'loading' },
  })

  // Declared paths are exactly `/x/<slug>`. A deeper path still resolves to its
  // `/x/<slug>` prefix so an extension page can do client-side sub-routing, which
  // also keeps this in step with how the rail decides an entry is active.
  const page = useMemo(
    () => pages.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`)),
    [pages, pathname],
  )

  // Depend on the fields rather than the object: `useExtensionPagesState` hands
  // back a fresh array on every refresh, and re-running the load effect for an
  // unchanged page would flash the spinner over an already rendered page.
  const extensionId = page?.extensionId
  const pageId = page?.id
  const entry = page?.entry
  const css = page?.css

  // Which bundle the state below belongs to. Navigating to another extension page
  // must show a spinner rather than the previous page's outcome, and deriving that
  // here beats resetting state from the effect, which would render the stale
  // outcome for one frame first.
  const target = extensionId && pageId && entry ? [extensionId, pageId, entry, css ?? ''].join('\u0000') : ''
  const state: LoadState = tracked.target === target ? tracked.state : { status: 'loading' }

  useEffect(() => {
    if (!extensionId || !pageId || !entry) return
    let cancelled = false
    let bundleLoaded = false
    const host = getHostRegistry()

    const settle = (next: LoadState) => { if (!cancelled) setTracked({ target, state: next }) }
    const fail = (failure: Failure) => settle({ status: 'error', failure })

    // Scoped to this page's own bundle so that an extension shipping one entry
    // per page never has one page's refusal reported on another's route.
    const bundleSrc = assetUrl(extensionId, entry)
    const refusalFailure = (): Failure | undefined => {
      const refusal = host.registrationRefusal(extensionId, pageId, bundleSrc)
      if (!refusal) return undefined
      return {
        title: `Extension "${extensionId}" was refused when it registered page "${refusal.pageId}"`,
        detail: refusal.message,
        hint: 'SwarmClaw rejected the registration, so no component was stored for this page. Fix the bundle, '
          + 'rebuild the extension and reload.',
      }
    }

    const timer = setTimeout(() => {
      if (cancelled || host.getPage(extensionId, pageId)) return
      // A bundle may register from a later tick than the one the load settled on,
      // and be refused then. That case is the reason this timer exists, so the
      // refusal recorded since is checked here too: without this the real reason
      // is discarded in favour of the generic "never registered" below.
      const refused = refusalFailure()
      if (refused) {
        fail(refused)
        return
      }
      if (!bundleLoaded) {
        fail({
          title: `Extension "${extensionId}" is still loading its bundle`,
          detail: `${entry} has not finished loading after ${REGISTER_TIMEOUT_MS / 1000} seconds, and it reported `
            + 'neither success nor an error.',
          hint: 'Check the Network tab for the request to this extension\'s assets, then reload.',
        })
        return
      }
      fail({
        title: `Extension "${extensionId}" loaded its bundle but never registered page "${pageId}"`,
        detail: `${entry} ran without calling window.swarmclaw.registerPage('${pageId}', Component, `
          + `{ react, extensionId }) within ${REGISTER_TIMEOUT_MS / 1000} seconds.`,
        hint: `Register at top-level script scope, and pass exactly the page id "${pageId}" — the "id" field of this `
          + 'page in the extension\'s ui.pages declaration, not its label or its path slug.',
      })
    }, REGISTER_TIMEOUT_MS)

    const off = host.onPageRegistered(extensionId, pageId, () => {
      clearTimeout(timer)
      const registered = host.getPage(extensionId, pageId)
      if (registered) settle({ status: 'ready', registered })
    })

    loadExtensionPage({ extensionId, entry, css })
      .then(() => {
        bundleLoaded = true
        if (cancelled || host.getPage(extensionId, pageId)) return
        // The bundle has executed, so a refusal it triggered is already recorded.
        // Without one, the bundle may still register from a later tick, so the
        // timeout above is left to decide, and looks again for a refusal itself.
        const refused = refusalFailure()
        if (!refused) return
        clearTimeout(timer)
        fail(refused)
      })
      .catch((err: unknown) => {
        clearTimeout(timer)
        fail({
          title: `Extension "${extensionId}" could not load the bundle for page "${pageId}"`,
          detail: err instanceof Error ? err.message : String(err),
          hint: `Check that the extension has been built and that ${entry} exists in its workspace directory, `
            + 'then reload.',
        })
      })

    return () => { cancelled = true; clearTimeout(timer); off() }
  }, [extensionId, pageId, entry, css, target])

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
              + 'installed. The list is retried in the background; reload if the page does not appear on its own.'}
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
