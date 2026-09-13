'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TabStrip } from '@/components/layout/tab-strip'
import { useExtensionPages } from '@/hooks/use-extension-pages'
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
const FLUSH_TIMEOUT_MS = 3_000

interface MountedFrame {
  id: string
  src: string
  /** Bumped to force a fresh load of the same URL. */
  generation: number
}

interface DesktopTabBridge {
  onTabCommand?: (cb: (command: unknown) => void) => () => void
}

function desktopBridge(): DesktopTabBridge | null {
  return (window as unknown as { swarmclawDesktop?: DesktopTabBridge }).swarmclawDesktop ?? null
}

function post(frame: HTMLIFrameElement, message: HostMessage): void {
  frame.contentWindow?.postMessage(message, window.location.origin)
}

/**
 * The frames that follow from a tab change: a closed tab loses its frame at
 * once (closing already flushed), and the active tab always has one, loaded
 * from its URL. Frames over the live cap are left for the flush-then-sleep
 * effect. Returns `current` itself when nothing changed.
 */
function reconcileFrames(current: MountedFrame[], state: TabsState): MountedFrame[] {
  const known = new Set(state.tabs.map((t) => t.id))
  let next = current.every((f) => known.has(f.id)) ? current : current.filter((f) => known.has(f.id))
  const active = state.tabs.find((t) => t.id === state.activeId)
  if (active && !next.some((f) => f.id === active.id)) next = [...next, { id: active.id, src: active.url, generation: 0 }]
  return next
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

/**
 * The host window's tabs: a strip and one iframe per live tab.
 *
 * At most `MAX_LIVE_FRAMES` frames stay mounted, the most recently used. A
 * frame leaves only after it answers a flush request with true, so an edit it
 * holds is never unloaded; one that answers false stays, over the cap. A tab
 * without a frame is loaded from its URL when it is activated.
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
  const ready = useRef(new Set<string>())
  const readyTimers = useRef(new Map<string, number>())
  const pendingFlush = useRef(new Map<string, { requestId: string; finish: (ok: boolean) => void }>())

  // Frames follow the tabs. Adjusted while rendering, against the tabs state
  // they were last reconciled with, rather than set from an effect: the active
  // tab's frame then appears in the same render as the tab, not one render late.
  const [reconciledFor, setReconciledFor] = useState<TabsState | null>(null)
  if (state && state !== reconciledFor) {
    setReconciledFor(state)
    setMounted((current) => reconcileFrames(current, state))
  }

  useEffect(() => {
    hydrate(`${window.location.pathname}${window.location.search}${window.location.hash}`)
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

  const requestFlush = useCallback((id: string): Promise<boolean> => {
    const frame = frames.current.get(id)
    // A frame that never loaded holds nothing to save.
    if (!frame || !ready.current.has(id)) return Promise.resolve(true)
    const existing = pendingFlush.current.get(id)
    if (existing) return new Promise((resolve) => {
      const previous = existing.finish
      existing.finish = (ok) => { previous(ok); resolve(ok) }
    })
    const requestId = newTabId()
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => settle(false), FLUSH_TIMEOUT_MS)
      function settle(ok: boolean) {
        window.clearTimeout(timer)
        pendingFlush.current.delete(id)
        resolve(ok)
      }
      pendingFlush.current.set(id, { requestId, finish: settle })
      post(frame, { source: 'sc-host', type: 'flush', requestId })
    })
  }, [])

  // Put the least recently used frames to sleep, each only once it has flushed.
  useEffect(() => {
    if (!state) return
    const keep = new Set(liveTabIds(state))
    for (const frame of mounted) {
      if (keep.has(frame.id) || pendingFlush.current.has(frame.id)) continue
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
  }, [state, mounted, requestFlush])

  // A frame that does not say it is ready in time is marked, with a reload.
  useEffect(() => {
    for (const frame of mounted) {
      const key = `${frame.id}:${frame.generation}`
      if (ready.current.has(frame.id) || readyTimers.current.has(key)) continue
      readyTimers.current.set(key, window.setTimeout(() => {
        readyTimers.current.delete(key)
        if (!ready.current.has(frame.id)) setFailed((current) => new Set(current).add(frame.id))
      }, READY_TIMEOUT_MS))
    }
  }, [mounted])

  useEffect(() => {
    const timers = readyTimers.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const reloadTab = useCallback((id: string) => {
    const tab = useTabsStore.getState().state?.tabs.find((t) => t.id === id)
    if (!tab) return
    ready.current.delete(id)
    clearReadyTimers(readyTimers.current, id)
    setFailed((current) => withoutId(current, id))
    setMounted((current) => current.map((f) => (f.id === id ? { id, src: tab.url, generation: f.generation + 1 } : f)))
  }, [])

  const closeWithFlush = useCallback(async (id: string) => {
    const ok = await requestFlush(id)
    if (ok) apply((s) => closeTab(s, id, newTabId))
    else apply((s) => activateTab(s, id))
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
  // other same-origin window (a chat preview iframe, a popup) is ignored.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const message = parseFrameMessage(event.data)
      if (!message) return
      const frame = frames.current.get(message.tabId)
      if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return
      switch (message.type) {
        case 'ready':
          ready.current.add(message.tabId)
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
        case 'flushed': {
          const pending = pendingFlush.current.get(message.tabId)
          if (pending && pending.requestId === message.requestId) pending.finish(message.ok)
          return
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [apply, runCommand])

  // The address bar shows the active tab, so a reload or a bookmark lands there.
  useEffect(() => {
    const active = state?.tabs.find((t) => t.id === state.activeId)
    if (!active) return
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (current !== active.url) window.history.replaceState(window.history.state, '', active.url)
  }, [state])

  // The rail, the palette and useNavigate go through here.
  useEffect(() => {
    setTabNavigator({
      navigateActive: (href) => {
        const url = appUrlFromHref(href, window.location.origin)
        const s = useTabsStore.getState().state
        if (!url || !s) return
        const frame = frames.current.get(s.activeId)
        if (frame && ready.current.has(s.activeId)) {
          post(frame, { source: 'sc-host', type: 'navigate', href: url })
          return
        }
        apply((x) => setTabUrl(x, s.activeId, url))
        clearReadyTimers(readyTimers.current, s.activeId)
        setMounted((current) => current.map((f) => (f.id === s.activeId ? { id: f.id, src: url, generation: f.generation + 1 } : f)))
      },
      openInNewTab: (href, opts) => {
        const url = appUrlFromHref(href, window.location.origin)
        if (!url) return
        apply((s) => openTab(s, { id: newTabId(), url, title: null }, { activate: opts?.activate ?? true }))
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
          return (
            <div key={`${frame.id}:${frame.generation}`} className={active ? 'absolute inset-0' : 'hidden'}>
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
