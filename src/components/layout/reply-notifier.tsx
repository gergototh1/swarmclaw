'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { shouldNotifyForReply } from '@/lib/chat/notification-gate'
import { advanceReplyNotifierSeen } from '@/components/layout/reply-notifier-state'
import { useWindowFocused } from '@/hooks/use-window-focused'
import { buildNotificationPayload } from '../../../electron/notification-payload'

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
  // `swarmclawDesktop`, not `swarmclaw` -- the bare name is the extension-page
  // API surface owned by `getHostRegistry()` in
  // `src/components/layout/extension-host.tsx`. See the comment on
  // `contextBridge.exposeInMainWorld` in `electron/preload.ts` for why.
  const w = window as unknown as { swarmclawDesktop?: SwarmclawBridge }
  return w.swarmclawDesktop ?? null
}

/**
 * The DECISION lives here, the SEND lives in the Electron main process. Only
 * the renderer knows focus and the active chat; only the main process can
 * reliably deliver a notification for a backgrounded, throttled window.
 *
 * Outside Electron `window.swarmclawDesktop` is undefined and every effect
 * below is a no-op, so this component is safe to render on the web build too.
 *
 * `seen` is the baseline captured on first mount: without it every
 * already-unread chat at load time would fire a notification on startup.
 *
 * The seeding/diffing sequence itself lives in `reply-notifier-state.ts` so
 * it can be exercised without a DOM or a store -- in particular the
 * cold-start case where this component's `sessions` prop starts as `{}`
 * (no persist middleware, see `session-slice.ts`) and is only filled in
 * later by an async `loadSessions()`. See that module's comment for why the
 * baseline must not be taken from an empty list.
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
        toast.error('This conversation no longer exists.')
        return
      }
      setActiveSessionIdOverride(sessionId)
    })
  }, [setActiveSessionIdOverride])

  useEffect(() => {
    const b = bridge()
    if (!b) return
    // `advanceReplyNotifierSeen` narrows this to what the Chat page would
    // actually list as a conversation -- scheduled/task runs, chatroom
    // half-sessions and empty sessions never reach `fired`.
    const step = advanceReplyNotifierSeen(seen.current, sessions ?? {})
    seen.current = step.seen

    for (const sessionId of step.fired) {
      const session = sessions?.[sessionId]
      if (!session) continue
      const agent = session.agentId ? agents?.[session.agentId] : null
      const allowed = shouldNotifyForReply({
        globalEnabled: appSettings?.agentReplyNotifications ?? true,
        agentMuted: agent?.replyNotificationsMuted ?? false,
        isActiveSession: session.id === activeSessionId,
        windowFocused,
      })
      if (!allowed) continue

      const payload = buildNotificationPayload(
        {
          name: session.name,
          lastAssistantAt: session.lastAssistantAt,
          lastFailedTurnAt: session.lastFailedTurnAt,
          lastMessageText: session.lastMessageSummary?.text ?? null,
        },
        agent?.name || '',
      )

      b.notify({
        sessionId: session.id,
        title: payload.title,
        body: payload.body,
        isError: payload.isError,
      })
    }
  }, [sessions, agents, appSettings, activeSessionId, windowFocused])

  return null
}
