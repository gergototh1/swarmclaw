'use client'

import { useSyncExternalStore } from 'react'
import { isFrameActive, subscribeFrameActive } from '@/lib/app/frame-active'

function subscribe(cb: () => void) {
  document.addEventListener('visibilitychange', cb)
  const offFrame = subscribeFrameActive(cb)
  return () => {
    document.removeEventListener('visibilitychange', cb)
    offFrame()
  }
}

function getSnapshot(): boolean {
  // A background tab frame is "hidden" as far as the app is concerned, even
  // though the browser still calls its document visible: the reader is looking
  // at another tab of the same window.
  return document.visibilityState === 'visible' && isFrameActive()
}

function getServerSnapshot(): boolean {
  return true
}

/** Returns `true` when this window — and, in the tab host, this tab — is the one on screen. SSR-safe. */
export function usePageActive(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
