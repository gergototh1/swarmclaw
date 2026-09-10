'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle, Ban, Clock3, MessageCircle } from 'lucide-react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useApprovalStore } from '@/stores/use-approval-store'
import { useNavigate } from '@/lib/app/navigation'
import { selectVisibleUnreadSessions } from '@/lib/chat/session-unread'
import { isLocalhostBrowser } from '@/lib/observability/local-observability'
import { filterPulseActions, NEEDS_YOU_PULSE_KINDS } from '@/lib/home/pulse-partition'
import { dedupeNotifications } from '@/lib/home/notification-dedup'
import { SectionHeader } from '@/components/ui/section-header'
import { RecentlyOpened } from '@/components/home/recently-opened'
import { ChatInput } from '@/components/input/chat-input'
import type { BoardTask, OperationPulse } from '@/types'

const NEEDS_YOU_LIMIT = 6

interface ProblemTaskRow {
  task: BoardTask
  kind: 'failed' | 'blocked'
}

export function TierAct() {
  const navigateTo = useNavigate()
  const router = useRouter()
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const tasks = useAppStore((s) => s.tasks)
  const notifications = useAppStore((s) => s.notifications)
  const currentUser = useAppStore((s) => s.currentUser)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const streamingSessionId = useChatStore((s) => s.streamingSessionId)
  const stopStreaming = useChatStore((s) => s.stopStreaming)
  const approvals = useApprovalStore((s) => s.approvals)
  const loadApprovals = useApprovalStore((s) => s.loadApprovals)

  const [pulse, setPulse] = useState<OperationPulse | null>(null)

  const agentList = useMemo(() => Object.values(agents).filter((a) => !a.trashedAt), [agents])
  const hasAgents = agentList.length > 0
  const firstAgent = agentList[0] ?? null

  /*
   * The ask bar targets the app's global "current agent" -- the same concept
   * ComposerAgentPicker (embedded in ChatInput) already manages -- rather
   * than a second, Home-local picker. See the redesign report for why: two
   * competing "who answers next" states would drift, and this is the only
   * one every other page already trusts. A brand new install has no current
   * agent yet, so default it once agents exist; this never clobbers a
   * selection the user (or another page) already made.
   */
  useEffect(() => {
    if (!currentAgentId && firstAgent) {
      void setCurrentAgent(firstAgent.id)
    }
  }, [currentAgentId, firstAgent, setCurrentAgent])

  useEffect(() => {
    void loadApprovals()
  }, [loadApprovals])

  useEffect(() => {
    let cancelled = false
    void api<OperationPulse>('GET', '/operations/pulse?range=24h')
      .then((next) => { if (!cancelled) setPulse(next) })
      .catch(() => { if (!cancelled) setPulse(null) })
    return () => { cancelled = true }
  }, [])

  const targetAgentId = currentAgentId || firstAgent?.id || null
  const targetSessionId = targetAgentId ? agents[targetAgentId]?.threadSessionId || null : null
  const targetSession = targetSessionId ? sessions[targetSessionId] : null
  const composerStreaming = !!targetSessionId && streamingSessionId === targetSessionId
  const composerBusy = composerStreaming || targetSession?.active === true

  const handleAskSend = useCallback((text: string) => {
    const agentId = currentAgentId || firstAgent?.id
    if (!agentId) return
    void (async () => {
      try {
        await setCurrentAgent(agentId)
        const sessionId = useAppStore.getState().agents[agentId]?.threadSessionId
        if (!sessionId) {
          toast.error('Couldn’t start a conversation with this agent.', { description: 'Try again in a moment.' })
          return
        }
        navigateTo('agents')
        await sendMessage(text, { sessionId })
      } catch {
        toast.error('Something went wrong sending that message.', { description: 'Try again.' })
      }
    })()
  }, [currentAgentId, firstAgent, navigateTo, sendMessage, setCurrentAgent])

  /*
   * `GET /api/chats` returns every session in the install and the `/chat`
   * destination does not re-check ownership, so this is the only gate between
   * a raw unread-chat computation and showing another user's conversation
   * (including their last-message preview text) on this viewer's home. Every
   * other surface that lists sessions -- search-dialog, command-palette --
   * gates through the same `isVisibleSessionForViewer` check before this one.
   */
  const unreadChats = useMemo(
    () => selectVisibleUnreadSessions(sessions, currentUser, { localhost: isLocalhostBrowser() }),
    [currentUser, sessions],
  )

  const pulseRows = useMemo(
    () => filterPulseActions(pulse?.actions || [], NEEDS_YOU_PULSE_KINDS),
    [pulse],
  )

  /*
   * The pre-rebuild home surfaced failed and blocked kanban tasks directly
   * (see the redesign report); the rebuild dropped them and nothing else
   * covers the gap -- `buildOperationPulse()` never ingests a `BoardTask`,
   * and task failures go through `logActivity`, not `createNotification`. A
   * blocked or failed task would otherwise have no signal anywhere outside
   * the Tasks board.
   */
  const problemTasks = useMemo<ProblemTaskRow[]>(() => {
    const rows: ProblemTaskRow[] = []
    for (const task of Object.values(tasks)) {
      if (task.status === 'failed') rows.push({ task, kind: 'failed' })
      else if ((task.blockedBy?.length ?? 0) > 0) rows.push({ task, kind: 'blocked' })
    }
    return rows.sort((a, b) => (b.task.updatedAt || b.task.createdAt || 0) - (a.task.updatedAt || a.task.createdAt || 0))
  }, [tasks])

  const openTask = useCallback((taskId: string) => {
    navigateTo('tasks')
    setEditingTaskId(taskId)
    setTaskSheetOpen(true)
  }, [navigateTo, setEditingTaskId, setTaskSheetOpen])

  /*
   * An unlinked error notification would be invisible if it went to the
   * collapsed Tier 3, so it is promoted here. Anything with an entityId is
   * already represented by its own row and is deliberately left out.
   * Repeats (the same underlying problem firing more than once before it's
   * read) are collapsed client-side and capped -- see notification-dedup.ts.
   */
  const errorNotifications = useMemo(
    () => notifications.filter((n) => !n.read && n.type === 'error' && !n.entityId),
    [notifications],
  )
  const dedupedNotifications = useMemo(() => dedupeNotifications(errorNotifications), [errorNotifications])

  const approvalRows = useMemo(() => Object.values(approvals), [approvals])

  const nothingWaiting =
    approvalRows.length === 0
    && unreadChats.length === 0
    && pulseRows.length === 0
    && dedupedNotifications.length === 0
    && problemTasks.length === 0

  return (
    <>
      {/* Ask bar */}
      <section className="mb-6">
        {hasAgents ? (
          <ChatInput
            streaming={composerStreaming}
            busy={composerBusy}
            onSend={handleAskSend}
            onStop={stopStreaming}
          />
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-line-subtle bg-surface p-4 text-[13px] text-text-3">
            <span>You don’t have any agents yet.</span>
            <button
              onClick={() => navigateTo('agents')}
              className="font-600 text-accent-bright underline bg-transparent border-none cursor-pointer p-0"
              style={{ fontFamily: 'inherit' }}
            >
              Create an agent
            </button>
          </div>
        )}
      </section>

      {/* Needs you — rendered only when something is actually waiting */}
      {!nothingWaiting && (
        <section className="mb-6 rounded-lg border border-line-subtle bg-surface p-5 sm:p-6">
          <SectionHeader
            label="Needs you"
            count={approvalRows.length + dedupedNotifications.length + pulseRows.length + unreadChats.length + problemTasks.length}
          />
          <div className="flex flex-col gap-1">
            {approvalRows.slice(0, NEEDS_YOU_LIMIT).map((approval) => (
              <button
                key={approval.id}
                onClick={() => navigateTo('agents', approval.agentId)}
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left bg-transparent border-none
                  hover:bg-layer-1 transition-colors cursor-pointer w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-400/10 text-amber-400">
                  <AlertTriangle size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block text-[13px] font-600 text-text">Approval requested</span>
                  <span className="block truncate text-[11px] text-text-3">{approval.command}</span>
                </div>
              </button>
            ))}
            {problemTasks.slice(0, NEEDS_YOU_LIMIT).map(({ task, kind }) => (
              <button
                key={task.id}
                onClick={() => openTask(task.id)}
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left bg-transparent border-none
                  hover:bg-layer-1 transition-colors cursor-pointer w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${kind === 'failed' ? 'bg-red-400/10 text-red-400' : 'bg-amber-400/10 text-amber-400'}`}>
                  {kind === 'failed' ? <AlertTriangle size={14} /> : <Ban size={14} />}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-600 text-text">{task.title}</span>
                  <span className="block truncate text-[11px] text-text-3">
                    {kind === 'failed'
                      ? (task.error ? task.error.slice(0, 120) : 'Task failed')
                      : `${(task.agentId && agents[task.agentId]?.name) || 'This task'} is blocked by dependencies`}
                  </span>
                </div>
              </button>
            ))}
            {dedupedNotifications.map(({ notification, occurrenceCount }) => (
              <div key={notification.id} className="flex items-center gap-3 rounded-md px-3 py-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-red-400/10 text-red-400">
                  <AlertTriangle size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block text-[13px] font-600 text-text">{notification.title}</span>
                  {notification.message && <span className="block truncate text-[11px] text-text-3">{notification.message}</span>}
                </div>
                {occurrenceCount > 1 && (
                  <span className="shrink-0 rounded-full border border-line-default bg-layer-2 px-2 py-0.5 text-[10px] font-700 text-text-3">
                    x{occurrenceCount}
                  </span>
                )}
              </div>
            ))}
            {pulseRows.slice(0, NEEDS_YOU_LIMIT).map((action) => (
              <button
                key={action.id}
                onClick={() => router.push(action.href)}
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left bg-transparent border-none
                  hover:bg-layer-1 transition-colors cursor-pointer w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-400/10 text-amber-400">
                  <Clock3 size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block text-[13px] font-600 text-text">{action.title}</span>
                  <span className="block truncate text-[11px] text-text-3">{action.summary}</span>
                </div>
              </button>
            ))}
            {unreadChats.slice(0, NEEDS_YOU_LIMIT).map(({ session, unread }) => (
              <button
                key={session.id}
                onClick={() => navigateTo('conversations', session.id)}
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left bg-transparent border-none
                  hover:bg-layer-1 transition-colors cursor-pointer w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${unread.isError ? 'bg-red-400/10 text-red-400' : 'bg-sky-400/10 text-sky-400'}`}>
                  <MessageCircle size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-600 text-text">{session.name || 'Untitled chat'}</span>
                  {session.lastMessageSummary?.text && (
                    <span className="block truncate text-[11px] text-text-3">{session.lastMessageSummary.text}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <RecentlyOpened />
    </>
  )
}
