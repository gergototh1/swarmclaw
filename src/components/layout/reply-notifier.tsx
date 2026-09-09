'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { sessionUnreadState } from '@/lib/chat/session-unread'
import { shouldNotifyForReply } from '@/lib/chat/notification-gate'
import { useWindowFocused } from '@/hooks/use-window-focused'

interface NotifyPayload {
  sessionId: string
  title: string
  body: string
  isError: boolean
}

interface SwarmclawBridge {
  notify: (payload: NotifyPayload) => void
  onOpenChat: (cb: (sessionId: string) => void) => () => void
}

function bridge(): SwarmclawBridge | null {
  const w = window as unknown as { swarmclaw?: SwarmclawBridge }
  return w.swarmclaw ?? null
}

/**
 * The DECISION lives here, the SEND lives in the Electron main process. Only
 * the renderer knows focus and the active chat; only the main process can
 * reliably deliver a notification for a backgrounded, throttled window.
 *
 * Outside Electron `window.swarmclaw` is undefined and every effect below is
 * a no-op, so this component is safe to render on the web build too.
 *
 * `seen` is the baseline captured on first mount: without it every
 * already-unread chat at load time would fire a notification on startup.
 */
export function ReplyNotifier() {
  const sessions = useAppStore((s) => s.sessions)
  const agents = useAppStore((s) => s.agents)
  const appSettings = useAppStore((s) => s.appSettings)
  const activeSessionId = useAppStore(selectActiveSessionId)
  const setActiveSessionIdOverride = useAppStore((s) => s.setActiveSessionIdOverride)
  const windowFocused = useWindowFocused()
  const seen = useRef<Map<string, number> | null>(null)

  useEffect(() => {
    const b = bridge()
    if (!b) return
    return b.onOpenChat((sessionId) => {
      // The chat may have been deleted since the notification was sent. The
      // window still comes forward (the main process handles that) -- here we
      // only explain why nothing opened, instead of leaving an empty view.
      if (!useAppStore.getState().sessions?.[sessionId]) {
        toast.error('Ez a beszelgetes mar nem letezik.')
        return
      }
      setActiveSessionIdOverride(sessionId)
    })
  }, [setActiveSessionIdOverride])

  useEffect(() => {
    const b = bridge()
    if (!b) return
    const list = Object.values(sessions ?? {})

    if (seen.current === null) {
      seen.current = new Map(list.map((s) => [s.id, sessionUnreadState(s).lastActivityAt]))
      return
    }

    for (const session of list) {
      const state = sessionUnreadState(session)
      const previous = seen.current.get(session.id) ?? 0
      seen.current.set(session.id, state.lastActivityAt)
      if (state.lastActivityAt <= previous) continue
      if (!state.unread) continue

      const agent = session.agentId ? agents?.[session.agentId] : null
      const allowed = shouldNotifyForReply({
        globalEnabled: appSettings?.agentReplyNotifications ?? true,
        agentMuted: agent?.replyNotificationsMuted ?? false,
        isActiveSession: session.id === activeSessionId,
        windowFocused,
      })
      if (!allowed) continue

      b.notify({
        sessionId: session.id,
        title: (agent?.name || '').trim() || 'SwarmClaw',
        body: state.isError ? `A futas hibaval vegzodott: ${session.name}` : `Valaszolt: ${session.name}`,
        isError: state.isError,
      })
    }
  }, [sessions, agents, appSettings, activeSessionId, windowFocused])

  return null
}
