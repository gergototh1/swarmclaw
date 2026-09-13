'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { TabStrip } from '@/components/layout/tab-strip'
import { useExtensionPages } from '@/hooks/use-extension-pages'
import { pageDocumentTitle } from '@/lib/extensions/page-location'
import { createFlushRequests } from '@/lib/app/tab-flush'
import { addressBarUpdate, isOwnFrameMessage, reconcileFrames, type MountedFrame } from '@/lib/app/tab-frames'
import { tabLabel, type TabLabel } from '@/lib/app/tab-label'
import { setTabNavigator } from '@/lib/app/tab-navigation'
import {
  TAB_WINDOW_NAME_PREFIX, appUrlFromHref, isEditableElementLike, parseFrameMessage, parseTabCommand, tabCommandForKey,
  type HostMessage, type TabCommand,
} from '@/lib/app/tab-protocol'
import {
  HOME_URL, activateByPosition, activateRelative, activateTab, closeTab, liveTabIds, moveTab, newTabId, openTab,
  reopenClosedTab, setTabTitle, setTabUrl, type TabsState,
} from '@/lib/app/tabs'
import { useAppStore } from '@/stores/use-app-store'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useTabsStore } from '@/stores/use-tabs-store'

const READY_TIMEOUT_MS = 20_000
/** Long enough to read the tab's name and reach "Close anyway". */
const REFUSED_CLOSE_TOAST_MS = 10_000

interface DesktopTabBridge {
  onTabCommand?: (cb: (command: unknown) => void) => () => void
}

function desktopBridge(): DesktopTabBridge | null {
  return (window as unknown as { swarmclawDesktop?: DesktopTabBridge }).swarmclawDesktop ?? null
}

function post(frame: HTMLIFrameElement, message: HostMessage): void {
  frame.contentWindow?.postMessage(message, window.location.origin)
}

/** Timers are keyed `${tabId}:${generation}`; drops every one a tab has, whatever its generation. */
function clearReadyTimers(timers: Map<string, number>, id: string): void {
  for (const [key, timer] of timers) {
    if (!key.startsWith(`${id}:`)) continue
    window.clearTimeout(timer)
    timers.delete(key)
  }
}

function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set
  const next = new Set(set)
  next.delete(id)
  return next
}

/** `set` without the ids that no longer name a tab; `set` itself when none are gone. */
function onlyTabIds(set: ReadonlySet<string>, state: TabsState): ReadonlySet<string> {
  const known = new Set(state.tabs.map((t) => t.id))
  if ([...set].every((id) => known.has(id))) return set
  return new Set([...set].filter((id) => known.has(id)))
}

/**
 * The host window's tabs: a strip and one iframe per live tab.
 *
 * At most `MAX_LIVE_FRAMES` frames stay mounted, the most recently used. A
 * frame leaves only after it answers a flush request with true, so an edit it
 * holds is never unloaded; one that answers false stays, over the cap, and is
 * not asked again for a cooldown. A tab without a frame is loaded from its URL
 * when it is activated. Every mounted frame keeps its full size; the ones in
 * the background are hidden and inert, not collapsed.
 */
export function TabHost() {
  const state = useTabsStore((s) => s.state)
  const hydrate = useTabsStore((s) => s.hydrate)
  const apply = useTabsStore((s) => s.apply)
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const extensionPages = useExtensionPages()

  const [mounted, setMounted] = useState<MountedFrame[]>([])
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  /**
   * Tabs whose frame said it is ready, with the document that said so. A frame
   * that reloads itself (the loader's Reload, an error boundary) fires `load`
   * with a new document, and is not ready again until that one says so.
   */
  const ready = useRef(new Map<string, Document | null>())
  const readyTimers = useRef(new Map<string, number>())
  const [flushes] = useState(() => createFlushRequests({
    newRequestId: newTabId,
    schedule: (fn, ms) => {
      const timer = window.setTimeout(fn, ms)
      return () => window.clearTimeout(timer)
    },
    now: () => Date.now(),
  }))

  // Frames follow the tabs. Adjusted while rendering, against the tabs state
  // they were last reconciled with, rather than set from an effect: the active
  // tab's frame then appears in the same render as the tab, not one render late.
  const [reconciledFor, setReconciledFor] = useState<TabsState | null>(null)
  if (state && state !== reconciledFor) {
    setReconciledFor(state)
    setMounted((current) => reconcileFrames(current, state))
    setFailed((current) => onlyTabIds(current, state))
  }

  useEffect(() => {
    hydrate(window.location.href, window.location.origin)
  }, [hydrate])

  const labels = useMemo(() => {
    const lookups = {
      agentNames: Object.fromEntries(Object.values(agents).map((a) => [a.id, a.name])),
      sessionTitles: Object.fromEntries(Object.values(sessions).map((s) => [s.id, s.name || 'Untitled chat'])),
      chatroomNames: Object.fromEntries(Object.values(chatrooms).map((c) => [c.id, c.name])),
      extensionPages,
    }
    const map = new Map<string, TabLabel>()
    for (const tab of state?.tabs ?? []) map.set(tab.id, tabLabel(tab.url, tab.title, lookups))
    return map
  }, [agents, sessions, chatrooms, extensionPages, state])

  // Read by callbacks that outlive a render (a flush answer, a toast action).
  const labelsRef = useRef(labels)
  useEffect(() => {
    labelsRef.current = labels
  }, [labels])

  // A closed tab's bookkeeping goes with it. Reopening a closed tab brings back
  // the same id, and its new frame must not inherit "ready", a running timer,
  // a pending flush or a refusal from the old one. (`failed` is pruned above.)
  // Declared before the ready-timer effect so a reopened frame's timer starts
  // against pruned state.
  useEffect(() => {
    if (!state) return
    const known = new Set(state.tabs.map((t) => t.id))
    for (const id of [...ready.current.keys()]) if (!known.has(id)) ready.current.delete(id)
    for (const key of [...readyTimers.current.keys()]) {
      const id = key.slice(0, key.lastIndexOf(':'))
      if (!known.has(id)) clearReadyTimers(readyTimers.current, id)
    }
    flushes.retain(known)
  }, [state, flushes])

  const requestFlush = useCallback((id: string): Promise<boolean> => {
    const frame = frames.current.get(id)
    // A frame that never loaded holds nothing to save.
    if (!frame || !ready.current.has(id)) return Promise.resolve(true)
    return flushes.request(id, (requestId) => post(frame, { source: 'sc-host', type: 'flush', requestId }))
  }, [flushes])

  // Put the least recently used frames to sleep, each only once it has flushed.
  useEffect(() => {
    if (!state) return
    const keep = new Set(liveTabIds(state))
    for (const frame of mounted) {
      if (keep.has(frame.id) || flushes.isPending(frame.id) || flushes.refusedRecently(frame.id)) continue
      void requestFlush(frame.id).then((ok) => {
        if (!ok) return
        // Used again while the flush was out: it stays awake.
        const latest = useTabsStore.getState().state
        if (latest && liveTabIds(latest).includes(frame.id)) return
        ready.current.delete(frame.id)
        clearReadyTimers(readyTimers.current, frame.id)
        setFailed((current) => withoutId(current, frame.id))
        setMounted((current) => current.filter((f) => f.id !== frame.id))
      })
    }
  }, [state, mounted, requestFlush, flushes])

  // A frame that does not say it is ready in time is marked, with a reload.
  const armReadyTimer = useCallback((id: string, generation: number) => {
    const key = `${id}:${generation}`
    if (ready.current.has(id) || readyTimers.current.has(key)) return
    readyTimers.current.set(key, window.setTimeout(() => {
      readyTimers.current.delete(key)
      if (!ready.current.has(id)) setFailed((current) => new Set(current).add(id))
    }, READY_TIMEOUT_MS))
  }, [])

  useEffect(() => {
    for (const frame of mounted) armReadyTimer(frame.id, frame.generation)
  }, [mounted, armReadyTimer])

  // A frame that loaded a document other than the one that said it was ready
  // has reloaded itself: it is booting again, so a flush has nothing to ask it
  // and a navigate goes in by reloading it at the new URL, as for a fresh frame.
  // The initial load, and a load whose document already said ready (its `ready`
  // can arrive before its `load`), change nothing.
  const onFrameLoad = useCallback((id: string, generation: number, element: HTMLIFrameElement) => {
    if (!ready.current.has(id) || ready.current.get(id) === element.contentDocument) return
    ready.current.delete(id)
    armReadyTimer(id, generation)
  }, [armReadyTimer])

  useEffect(() => {
    const timers = readyTimers.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
      flushes.dispose()
    }
  }, [flushes])

  const reloadTab = useCallback((id: string) => {
    const tab = useTabsStore.getState().state?.tabs.find((t) => t.id === id)
    if (!tab) return
    ready.current.delete(id)
    clearReadyTimers(readyTimers.current, id)
    setFailed((current) => withoutId(current, id))
    setMounted((current) => current.map((f) => (f.id === id ? { id, src: tab.url, generation: f.generation + 1 } : f)))
  }, [])

  // A tab whose flush comes back false (or times out) is not closed: it is
  // brought forward so the reader sees what did not save, and the toast names
  // it and offers to close it without asking again. Without that way out a tab
  // holding an edit that can never save (a conflict filed on a doc the reader
  // has left) could never be closed at all.
  const closeWithFlush = useCallback(async (id: string) => {
    const ok = await requestFlush(id)
    if (ok) {
      apply((s) => closeTab(s, id, newTabId))
      return
    }
    apply((s) => activateTab(s, id))
    if (!useTabsStore.getState().state?.tabs.some((t) => t.id === id)) return
    const label = labelsRef.current.get(id)?.title ?? 'This tab'
    toast.error(`${label} has changes that could not be saved.`, {
      id: `tab-close-refused:${id}`,
      duration: REFUSED_CLOSE_TOAST_MS,
      action: { label: 'Close anyway', onClick: () => apply((s) => closeTab(s, id, newTabId)) },
    })
  }, [apply, requestFlush])

  const runCommand = useCallback((command: TabCommand) => {
    switch (command.kind) {
      case 'new': apply((s) => openTab(s, { id: newTabId(), url: HOME_URL, title: null })); return
      case 'close': {
        const activeId = useTabsStore.getState().state?.activeId
        if (activeId) void closeWithFlush(activeId)
        return
      }
      case 'reopen': apply(reopenClosedTab); return
      case 'next': apply((s) => activateRelative(s, 1)); return
      case 'previous': apply((s) => activateRelative(s, -1)); return
      case 'goto': apply((s) => activateByPosition(s, command.position)); return
      case 'palette': window.dispatchEvent(new CustomEvent('swarmclaw:open-palette')); return
    }
  }, [apply, closeWithFlush])

  // Messages from the frames. Acted on only when they come from this origin AND
  // from the very window of the frame this host created for that tab id -- any
  // other same-origin window (a chat preview iframe, a popup) is ignored. The
  // rule is `isOwnFrameMessage` (src/lib/app/tab-frames.ts), tested there.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = parseFrameMessage(event.data)
      if (!message || !isOwnFrameMessage(event, window.location.origin, message.tabId, frames.current)) return
      switch (message.type) {
        case 'ready':
          ready.current.set(message.tabId, frames.current.get(message.tabId)?.contentDocument ?? null)
          clearReadyTimers(readyTimers.current, message.tabId)
          setFailed((current) => withoutId(current, message.tabId))
          return
        case 'location': apply((s) => setTabUrl(s, message.tabId, message.url)); return
        case 'title': apply((s) => setTabTitle(s, message.tabId, message.text)); return
        case 'open-tab':
          apply((s) => openTab(s, { id: newTabId(), url: message.url, title: null }, { activate: message.activate, afterId: message.tabId }))
          return
        case 'command': runCommand(message.command); return
        case 'auth-required': window.location.assign('/login'); return
        case 'flushed': flushes.answer(message.tabId, message.requestId, message.ok); return
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [apply, runCommand, flushes])

  // The address bar shows the active tab, so a reload or a bookmark lands there.
  // `null` state, not `history.state`: Next's patched replaceState passes a state
  // carrying its `__NA` flag straight through, so its router would never learn
  // the URL and `usePathname()` (the rail's highlight) would stay put. Without
  // the flag it copies its own history fields over and restores to the new URL.
  // `addressBarUpdate` refuses a URL that is not a valid app path; the catch is
  // the second line: a replaceState that throws here would, with the tabs
  // stored, throw again on every load.
  useEffect(() => {
    const next = addressBarUpdate(state, `${window.location.pathname}${window.location.search}${window.location.hash}`)
    if (!next) return
    try {
      window.history.replaceState(null, '', next)
    } catch {
      // The address bar keeps its previous URL; the tab itself is unaffected.
    }
  }, [state])

  // The window title follows the active tab, as the page itself names it in a
  // plain window ("Offer draft · SidekickOS"). The base is the title the host
  // mounted with, and it is put back when the host goes.
  const baseTitle = useRef<string | null>(null)
  useEffect(() => {
    const base = document.title
    baseTitle.current = base
    return () => {
      document.title = base
      baseTitle.current = null
    }
  }, [])
  const activeTitle = state ? labels.get(state.activeId)?.title ?? null : null
  useEffect(() => {
    if (baseTitle.current === null) return
    document.title = pageDocumentTitle(activeTitle, baseTitle.current)
    // `state` too: a replaceState above may let the router re-apply its own title.
  }, [activeTitle, state])

  // Focus never stays in a frame that went to the background (a tab key pressed
  // inside a tab switches tabs with focus still there): it follows to the
  // active frame. Focus in the host's own chrome, such as the strip, is left alone.
  const activeId = state?.activeId
  useEffect(() => {
    if (!activeId) return
    const focused = document.activeElement
    if (!(focused instanceof HTMLIFrameElement)) return
    const activeFrame = frames.current.get(activeId)
    if (focused === activeFrame || ![...frames.current.values()].includes(focused)) return
    if (activeFrame) activeFrame.focus()
    else focused.blur()
  }, [activeId])

  // The rail, the palette and useNavigate go through here.
  useEffect(() => {
    setTabNavigator({
      navigateActive: (href, opts) => {
        const url = appUrlFromHref(href, window.location.origin)
        const s = useTabsStore.getState().state
        if (!url || !s) return
        const frame = frames.current.get(s.activeId)
        if (frame && ready.current.has(s.activeId)) {
          post(frame, { source: 'sc-host', type: 'navigate', href: url, panel: opts?.panel })
          return
        }
        // Not ready (still booting, or reloading itself): load it at the new URL.
        // A panel intent has nothing to act on there; the fresh page opens its
        // own panel for a view that has one.
        apply((x) => setTabUrl(x, s.activeId, url))
        clearReadyTimers(readyTimers.current, s.activeId)
        setMounted((current) => current.map((f) => (f.id === s.activeId ? { id: f.id, src: url, generation: f.generation + 1 } : f)))
      },
      openInNewTab: (href, opts) => {
        const url = appUrlFromHref(href, window.location.origin)
        if (!url) return
        apply((s) => openTab(s, { id: newTabId(), url, title: null }, { activate: opts?.activate ?? true }))
      },
      focusActive: () => {
        // Something in the host window that took focus (a dialog, a sheet) keeps it.
        const focused = document.activeElement
        if (focused && focused !== document.body && !(focused instanceof HTMLIFrameElement)) return
        const s = useTabsStore.getState().state
        const frame = s ? frames.current.get(s.activeId) : undefined
        frame?.focus()
      },
    })
    return () => setTabNavigator(null)
  }, [apply])

  // Keys while focus is in the host's own chrome (rail, strip).
  useEffect(() => {
    const platform = desktopBridge()?.onTabCommand ? 'desktop-app' : 'browser'
    const onKey = (e: KeyboardEvent) => {
      // In a text field the Option keys type characters ([ ] { } @ on Hungarian and
      // German layouts) and move by word, so only Cmd/Ctrl+K is taken there.
      const editable = isEditableElementLike(e.target instanceof Element ? e.target : null)
      const command = tabCommandForKey(e, platform, { editable })
      // Cmd+K in the host window is the palette's own listener.
      if (!command || command.kind === 'palette') return
      e.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runCommand])

  // Desktop app: the menu's tab shortcuts.
  useEffect(() => {
    const subscribe = desktopBridge()?.onTabCommand
    if (!subscribe) return
    return subscribe((raw) => {
      const command = parseTabCommand(raw)
      if (command) runCommand(command)
    })
  }, [runCommand])

  if (!state) return <div className="flex-1 bg-bg" />

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <TabStrip
        tabs={state.tabs}
        activeId={state.activeId}
        labels={labels}
        failedIds={failed}
        onActivate={(id) => apply((s) => activateTab(s, id))}
        onClose={(id) => { void closeWithFlush(id) }}
        onNew={() => runCommand({ kind: 'new' })}
        onMove={(id, toIndex) => apply((s) => moveTab(s, id, toIndex))}
      />
      <div className="relative flex-1 min-h-0">
        {mounted.map((frame) => {
          const active = frame.id === state.activeId
          // Every frame keeps the full size, so the document inside a background
          // tab keeps its desktop layout, its width-based panels and its scroll
          // position. `display: none` would give it a 0x0 viewport. A background
          // frame is invisible, takes no pointer events, and is inert (no focus,
          // no find-in-page) and hidden from assistive technology.
          return (
            <div
              key={`${frame.id}:${frame.generation}`}
              className={active ? 'absolute inset-0' : 'absolute inset-0 invisible pointer-events-none'}
              inert={!active}
              aria-hidden={active ? undefined : true}
            >
              <iframe
                ref={(element) => {
                  if (!element) return
                  frames.current.set(frame.id, element)
                  // Only forget this element: a reload's replacement may already be registered.
                  return () => {
                    if (frames.current.get(frame.id) === element) frames.current.delete(frame.id)
                  }
                }}
                name={`${TAB_WINDOW_NAME_PREFIX}${frame.id}`}
                src={frame.src}
                title={labels.get(frame.id)?.title ?? 'Tab'}
                onLoad={(e) => onFrameLoad(frame.id, frame.generation, e.currentTarget)}
                className="w-full h-full border-0 bg-bg"
              />
              {failed.has(frame.id) && (
                <div className="absolute inset-0 flex items-center justify-center bg-bg/90">
                  <div className="text-center">
                    <p className="text-[13px] text-text-2">This tab did not load.</p>
                    <button type="button" onClick={() => reloadTab(frame.id)} className="mt-2 px-3 py-1.5 rounded-sm text-[12.5px] bg-accent-soft text-accent-bright border-none cursor-pointer">
                      Reload
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
