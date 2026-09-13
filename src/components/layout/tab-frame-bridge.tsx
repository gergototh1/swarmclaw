'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { tabIdFromWindow } from '@/lib/app/shell-mode'
import { runTabFlushHandlers } from '@/lib/app/tab-flush'
import { appUrlFromHref, parseHostMessage, tabCommandForKey, type FrameMessage } from '@/lib/app/tab-protocol'

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
  }, [pathname, tabId])

  useEffect(() => {
    // Capture phase on window, so the host sees a tab key or Cmd/Ctrl+K before
    // any handler in the page, and the page's own Cmd+K (search, palette) does
    // not open inside the tab as well.
    const onKey = (e: KeyboardEvent) => {
      const command = tabCommandForKey(e, 'browser')
      if (!command) return
      e.preventDefault()
      e.stopImmediatePropagation()
      postToHost({ source: 'sc-tab', type: 'command', tabId, command })
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [tabId])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return
      const target = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!(target instanceof HTMLAnchorElement)) return
      if (target.target && target.target !== '_self') return
      const url = appUrlFromHref(target.href, window.location.origin)
      if (!url) return
      e.preventDefault()
      e.stopImmediatePropagation()
      postToHost({ source: 'sc-tab', type: 'open-tab', tabId, url, activate: false })
    }
    document.addEventListener('click', onClick, { capture: true })
    document.addEventListener('auxclick', onClick, { capture: true })
    return () => {
      document.removeEventListener('click', onClick, { capture: true })
      document.removeEventListener('auxclick', onClick, { capture: true })
    }
  }, [tabId])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return
      const message = parseHostMessage(event.data)
      if (!message) return
      if (message.type === 'navigate') {
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
