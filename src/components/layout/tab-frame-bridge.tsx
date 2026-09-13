'use client'

import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { sidebarOpenForNavigate } from '@/lib/app/panel-intent'
import { tabIdFromWindow } from '@/lib/app/shell-mode'
import { runTabFlushHandlers } from '@/lib/app/tab-flush'
import { appUrlFromHref, isEditableElementLike, parseHostMessage, tabCommandForKey, type FrameMessage } from '@/lib/app/tab-protocol'
import { useAppStore } from '@/stores/use-app-store'

export function postToHost(message: FrameMessage): void {
  window.parent.postMessage(message, window.location.origin)
}

/** The raw title of what this tab shows; a no-op outside a tab. */
export function reportTabTitle(text: string | null): void {
  if (typeof window === 'undefined') return
  const tabId = tabIdFromWindow(window)
  if (tabId) postToHost({ source: 'sc-tab', type: 'title', tabId, text })
}

/** Asks the host to open an app URL in a new, active tab. False outside a tab. */
export function openAppUrlInNewTab(href: string): boolean {
  if (typeof window === 'undefined') return false
  const tabId = tabIdFromWindow(window)
  const url = appUrlFromHref(href, window.location.origin)
  if (!tabId || !url) return false
  postToHost({ source: 'sc-tab', type: 'open-tab', tabId, url, activate: true })
  return true
}

/**
 * A tab's side of the conversation with the host.
 *
 * It reports where the tab is, forwards the keys and modified link clicks that
 * belong to the host, and answers the host's two requests: navigate, and flush
 * before this frame is put to sleep or closed.
 */
export function TabFrameBridge({ tabId }: { tabId: string }) {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const router = useRouter()

  useEffect(() => {
    postToHost({ source: 'sc-tab', type: 'ready', tabId })
  }, [tabId])

  useEffect(() => {
    const report = () => {
      const url = appUrlFromHref(window.location.href, window.location.origin)
      if (url) postToHost({ source: 'sc-tab', type: 'location', tabId, url })
    }
    report()
    window.addEventListener('popstate', report)
    return () => window.removeEventListener('popstate', report)
    // `usePathname()` alone misses a query-only navigation (pushState /
    // replaceState fire no `popstate`), so the search string is also a
    // dependency here.
  }, [pathname, search, tabId])

  useEffect(() => {
    // Capture phase on window, so the host sees a tab key or Cmd/Ctrl+K before
    // any handler in the page, and the page's own Cmd+K (search, palette) does
    // not open inside the tab as well.
    const onKey = (e: KeyboardEvent) => {
      // In a text field the Option keys type characters ([ ] { } @ on Hungarian
      // and German layouts) and move by word, so only Cmd/Ctrl+K is taken there.
      const editable = isEditableElementLike(e.target instanceof Element ? e.target : null)
      const command = tabCommandForKey(e, 'browser', { editable })
      if (!command) return
      e.preventDefault()
      e.stopImmediatePropagation()
      postToHost({ source: 'sc-tab', type: 'command', tabId, command })
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [tabId])

  useEffect(() => {
    // Bubble phase, and skip a click a page already handled: a modified click
    // is taken only when the page's own handler (if any) declined it, so the
    // page's link handling always runs first.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return
      const target = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!(target instanceof HTMLAnchorElement)) return
      if (target.target && target.target !== '_self') return
      if (target.hasAttribute('download')) return
      const url = appUrlFromHref(target.href, window.location.origin)
      if (!url) return
      e.preventDefault()
      postToHost({ source: 'sc-tab', type: 'open-tab', tabId, url, activate: false })
    }
    document.addEventListener('click', onClick)
    document.addEventListener('auxclick', onClick)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('auxclick', onClick)
    }
  }, [tabId])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return
      const message = parseHostMessage(event.data)
      if (!message) return
      if (message.type === 'navigate') {
        // The side panel renders here, from this window's store, so a rail
        // click's intent for it is applied here -- against the path this tab
        // is on before it moves, as the rail does in a plain window.
        if (message.panel) {
          const { sidebarOpen, setSidebarOpen } = useAppStore.getState()
          setSidebarOpen(sidebarOpenForNavigate(message.panel, window.location.pathname, message.href, sidebarOpen))
        }
        router.push(message.href)
        return
      }
      void runTabFlushHandlers().then((ok) => {
        postToHost({ source: 'sc-tab', type: 'flushed', tabId, requestId: message.requestId, ok })
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [router, tabId])

  return null
}
