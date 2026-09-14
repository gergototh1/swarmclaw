'use client'

import { useEffect, useRef } from 'react'
import { subscribeWs, unsubscribeWs, isWsConnected, onWsStateChange, offWsStateChange } from '@/lib/ws-client'
import { hmrSingleton } from '@/lib/shared-utils'
import { usePageActive } from './use-page-active'
import { createCatchUp, type CatchUp } from '@/lib/app/ws-catch-up'

/** Shared fallback intervals keyed by topic — multiple useWs instances share one interval. */
const sharedFallbacks = hmrSingleton('useWs_sharedFallbacks', () => new Map<string, {
  interval: ReturnType<typeof setInterval> | null
  handlers: Set<() => void>
  ms: number
}>())

function runAllHandlers(topic: string): void {
  const entry = sharedFallbacks.get(topic)
  if (!entry) return
  for (const h of entry.handlers) h()
}

function acquireFallback(topic: string, ms: number, handler: () => void): void {
  const existing = sharedFallbacks.get(topic)
  if (existing) {
    existing.handlers.add(handler)
    return
  }
  const handlers = new Set<() => void>([handler])
  const entry = { interval: null as ReturnType<typeof setInterval> | null, handlers, ms }
  sharedFallbacks.set(topic, entry)
  if (!isWsConnected()) {
    entry.interval = setInterval(() => runAllHandlers(topic), ms)
  }
}

function releaseFallback(topic: string, handler: () => void): void {
  const entry = sharedFallbacks.get(topic)
  if (!entry) return
  entry.handlers.delete(handler)
  if (entry.handlers.size <= 0) {
    if (entry.interval) clearInterval(entry.interval)
    sharedFallbacks.delete(topic)
  }
}

function syncFallbacks(): void {
  const connected = isWsConnected()
  for (const [topic, entry] of sharedFallbacks) {
    if (connected && entry.interval) {
      clearInterval(entry.interval)
      entry.interval = null
    } else if (!connected && !entry.interval) {
      entry.interval = setInterval(() => runAllHandlers(topic), entry.ms)
    }
  }
}

/**
 * Subscribe to a WebSocket topic. Calls `handler` on push events.
 * Falls back to polling at `fallbackMs` when WS is disconnected.
 */
export function useWs(topic: string, handler: () => void | Promise<void>, fallbackMs?: number) {
  const isActive = usePageActive()
  const handlerRef = useRef(handler)
  const fallbackMsRef = useRef(fallbackMs)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const wasActiveRef = useRef(isActive)
  const isActiveRef = useRef(isActive)

  useEffect(() => {
    handlerRef.current = handler
    fallbackMsRef.current = fallbackMs
  }, [handler, fallbackMs])

  const runHandler = () => {
    if (inFlightRef.current) return
    try {
      const result = handlerRef.current()
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        const promise = Promise.resolve(result)
          .catch(() => {})
          .finally(() => {
            if (inFlightRef.current === promise) {
              inFlightRef.current = null
            }
          })
        inFlightRef.current = promise
      }
    } catch {
      // Individual handlers already own their error reporting
    }
  }

  const catchUpRef = useRef<CatchUp | null>(null)

  // Create the catch-up coordinator on first use (refs can't be initialized
  // during render), keep the active flag current for the subscription
  // callback below, and run a catch-up pass when the frame comes back into
  // view. Declared before the subscription effect so `catchUpRef.current` is
  // always set by the time that effect's callback can run.
  //
  // A reactivation can call for a refresh for two different reasons: a push
  // event arrived while inactive (recorded by `onEvent`), or the frame's own
  // socket (see idle-socket.ts) is still disconnected right now, so no push
  // event could have arrived to be recorded as a miss in the first place.
  // Both go through the same `onActiveChange` call so at most one refresh
  // happens either way; a separate direct `runHandler()` call for the second
  // case (as this used to have, in the fallback effect below) would double it
  // whenever both are true at once.
  //
  // `stale` is not gated on `fallbackMs`: a topic with no fallback interval —
  // `'extensions'` in chat-area.tsx, `'skills'` in sidebar-rail.tsx, and every
  // other push-only subscription — otherwise gets no refresh at all after a
  // background-closed socket reconnects; it would sit stale until the next
  // push event, which for a page-list or badge topic can be an arbitrarily
  // long time. `isWsConnected()` reflects this frame's own socket exactly —
  // idle-socket.ts's `connect`/`disconnect` are `connectWs`/`disconnectWs`
  // from the same `ws-client.ts` this reads — so no extra plumbing is needed
  // to ask "was it closed while I was away": right after `becameActive`, the
  // new socket from `idleSocket.setActive(true)` has not reached `onopen` yet,
  // so `isWsConnected()` is still false only when it really was closed.
  useEffect(() => {
    if (catchUpRef.current == null) {
      catchUpRef.current = createCatchUp(() => runHandler())
    }
    isActiveRef.current = isActive
    const becameActive = !wasActiveRef.current && isActive
    wasActiveRef.current = isActive
    const stale = becameActive && !isWsConnected()
    catchUpRef.current.onActiveChange(isActive, stale)
  }, [isActive])

  // WS subscription — only re-runs when topic changes. Re-subscribing on every
  // tab switch would cost more than the handler runs it skips, and the socket
  // connection itself is handled by a later task — so the subscription stays
  // open while the frame is inactive; only the handler is skipped.
  useEffect(() => {
    if (!topic) return

    const cb = () => catchUpRef.current?.onEvent(isActiveRef.current)
    subscribeWs(topic, cb)
    return () => { unsubscribeWs(topic, cb) }
  }, [topic])

  // Stable handler ref for fallback — identity stays the same across renders
  const fallbackHandlerRef = useRef(() => runHandler())
  useEffect(() => {
    fallbackHandlerRef.current = () => runHandler()
  })

  // Fallback polling with shared intervals and connection state notifications.
  // The immediate refresh-on-reactivation used to live here too; it now goes
  // through the catch-up effect above so exactly one refresh happens per
  // activation, however many reasons there are for it.
  useEffect(() => {
    if (!topic) return

    // Don't run polling while the tab is hidden
    if (!isActive) return

    const ms = fallbackMsRef.current
    if (!ms || ms <= 0) return

    // Subscribe to connection state changes to start/stop fallback
    const stateHandler = () => syncFallbacks()
    onWsStateChange(stateHandler)
    // Use a stable wrapper that delegates to the current handler ref
    const stableFallbackHandler = () => fallbackHandlerRef.current()
    acquireFallback(topic, ms, stableFallbackHandler)

    return () => {
      offWsStateChange(stateHandler)
      releaseFallback(topic, stableFallbackHandler)
    }
  }, [topic, isActive])
}
