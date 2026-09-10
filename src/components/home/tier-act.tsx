'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useApprovalStore } from '@/stores/use-approval-store'
import { useNavigate } from '@/lib/app/navigation'
import { selectUnreadSessions } from '@/lib/chat/session-unread'
import { filterPulseActions, NEEDS_YOU_PULSE_KINDS } from '@/lib/home/pulse-partition'
import { SectionHeader } from '@/components/ui/section-header'
import { RecentlyOpened } from '@/components/home/recently-opened'
import type { OperationPulse } from '@/types'

const NEEDS_YOU_LIMIT = 6

export function TierAct() {
  const navigateTo = useNavigate()
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const notifications = useAppStore((s) => s.notifications)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const approvals = useApprovalStore((s) => s.approvals)
  const loadApprovals = useApprovalStore((s) => s.loadApprovals)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [askAgentId, setAskAgentId] = useState<string>('')
  const [pulse, setPulse] = useState<OperationPulse | null>(null)

  const agentList = useMemo(() => Object.values(agents), [agents])
  const hasAgents = agentList.length > 0

  useEffect(() => {
    if (!askAgentId && (currentAgentId || agentList[0])) {
      setAskAgentId(currentAgentId || agentList[0]!.id)
    }
  }, [askAgentId, currentAgentId, agentList])

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

  const unreadChats = useMemo(() => selectUnreadSessions(sessions), [sessions])

  const pulseRows = useMemo(
    () => filterPulseActions(pulse?.actions || [], NEEDS_YOU_PULSE_KINDS),
    [pulse],
  )

  /*
   * An unlinked error notification would be invisible if it went to the
   * collapsed Tier 3, so it is promoted here. Anything with an entityId is
   * already represented by its own row and is deliberately left out.
   */
  const errorNotifications = useMemo(
    () => notifications.filter((n) => !n.read && n.type === 'error' && !n.entityId),
    [notifications],
  )

  const approvalRows = useMemo(() => Object.values(approvals), [approvals])

  const nothingWaiting =
    approvalRows.length === 0
    && unreadChats.length === 0
    && pulseRows.length === 0
    && errorNotifications.length === 0

  const ask = async () => {
    const text = draft.trim()
    if (!text || !askAgentId || sending) return
    setSending(true)
    try {
      await setCurrentAgent(askAgentId)
      const sessionId = useAppStore.getState().agents[askAgentId]?.threadSessionId
      if (!sessionId) {
        // Draft is deliberately left in place so the user can retry without retyping.
        toast.error('Couldn’t start a conversation with this agent.', { description: 'Try again in a moment.' })
        return
      }
      setDraft('')
      navigateTo('agents')
      await sendMessage(text, { sessionId })
    } catch {
      toast.error('Something went wrong sending that message.', { description: 'Try again.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {/* Ask bar */}
      <section className="mb-8">
        <div className="flex flex-col gap-2 rounded-lg border border-line-subtle bg-surface p-3 sm:flex-row sm:items-center">
          <select
            value={askAgentId}
            onChange={(e) => setAskAgentId(e.target.value)}
            disabled={!hasAgents}
            className="rounded-md border border-line-subtle bg-layer-1 px-2.5 py-2 text-[12px] font-600 text-text
              disabled:opacity-40"
            style={{ fontFamily: 'inherit' }}
          >
            {hasAgents
              ? agentList.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))
              : <option value="">No agents</option>}
          </select>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask() } }}
            placeholder="Ask an agent…"
            className="min-w-0 flex-1 bg-transparent px-2 py-2 text-[14px] text-text outline-none"
            style={{ fontFamily: 'inherit' }}
          />
          <button
            onClick={() => void ask()}
            disabled={!hasAgents || !draft.trim() || !askAgentId || sending}
            className="rounded-md bg-accent-soft px-3 py-2 text-[12px] font-700 text-accent-bright
              disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none"
            style={{ fontFamily: 'inherit' }}
          >
            Send
          </button>
        </div>
        {!hasAgents && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-text-3">
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
        <section className="mb-8">
          <SectionHeader label="Needs you" />
          <div className="flex flex-col gap-1">
            {approvalRows.slice(0, NEEDS_YOU_LIMIT).map((approval) => (
              <button
                key={approval.id}
                onClick={() => navigateTo('agents')}
                className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left bg-transparent border-none
                  hover:bg-layer-2 transition-colors cursor-pointer w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <div className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                <span className="text-[13px] font-600 text-text">Approval requested</span>
                <span className="truncate text-[11px] text-text-3">{approval.command}</span>
              </button>
            ))}
            {errorNotifications.slice(0, NEEDS_YOU_LIMIT).map((n) => (
              <div key={n.id} className="flex items-center gap-2.5 rounded-md px-3 py-2.5">
                <div className="h-2 w-2 shrink-0 rounded-full bg-red-400" />
                <span className="text-[13px] font-600 text-text">{n.title}</span>
                {n.message && <span className="truncate text-[11px] text-text-3">{n.message}</span>}
              </div>
            ))}
            {pulseRows.slice(0, NEEDS_YOU_LIMIT).map((action) => (
              <button
                key={action.id}
                onClick={() => navigateTo('missions')}
                className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left bg-transparent border-none
                  hover:bg-layer-2 transition-colors cursor-pointer w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <div className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                <span className="text-[13px] font-600 text-text">{action.title}</span>
                <span className="truncate text-[11px] text-text-3">{action.summary}</span>
              </button>
            ))}
            {unreadChats.slice(0, NEEDS_YOU_LIMIT).map(({ session, unread }) => (
              <button
                key={session.id}
                onClick={() => navigateTo('conversations', session.id)}
                className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left bg-transparent border-none
                  hover:bg-layer-2 transition-colors cursor-pointer w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <div className={`h-2 w-2 shrink-0 rounded-full ${unread.isError ? 'bg-red-400' : 'bg-sky-400'}`} />
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
