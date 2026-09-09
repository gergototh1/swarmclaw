import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { Sessions, Session } from '../../types'
import { api } from '@/lib/app/api-client'
import { fetchChat, fetchChats } from '@/lib/chat/chats'
import { invalidateFingerprint, setIfChanged } from '../set-if-changed'
import { createLoader, createInflightDeduplicator } from '../store-utils'
import { buildNewAgentSessionPayload } from '@/lib/chat/new-session'

const sessionRefreshDedup = createInflightDeduplicator('sessionSlice_inflightRefreshes')

function getSessionSortScore(session: Session): number {
  return session.lastAssistantAt
    || session.lastActiveAt
    || session.updatedAt
    || session.createdAt
    || 0
}

function hasSessionContent(session: Session): boolean {
  if (typeof session.messageCount === 'number' && Number.isFinite(session.messageCount) && session.messageCount > 0) {
    return true
  }
  if (session.lastMessageSummary) return true
  return Array.isArray(session.messages) && session.messages.length > 0
}

function getLatestAgentSessionId(s: AppState, agentId: string, threadSessionId?: string | null): string | null {
  let bestAnyId: string | null = null
  let bestAnyScore = Number.NEGATIVE_INFINITY
  let bestWithContentId: string | null = null
  let bestWithContentScore = Number.NEGATIVE_INFINITY

  for (const [sessionId, session] of Object.entries(s.sessions)) {
    if (session.agentId !== agentId) continue
    const score = getSessionSortScore(session)
    if (score > bestAnyScore) {
      bestAnyScore = score
      bestAnyId = sessionId
    }
    if (hasSessionContent(session) && score > bestWithContentScore) {
      bestWithContentScore = score
      bestWithContentId = sessionId
    }
  }

  if (bestWithContentId) return bestWithContentId
  if (threadSessionId && s.sessions[threadSessionId]?.agentId === agentId) return threadSessionId
  return bestAnyId
}

/** Derive the active session ID from the current agent — no stored `currentSessionId`. */
export function selectActiveSessionId(s: AppState): string | null {
  if (s.activeSessionIdOverride && s.sessions[s.activeSessionIdOverride]) {
    return s.activeSessionIdOverride
  }
  if (!s.currentAgentId) return null
  const agent = s.agents[s.currentAgentId]
  return getLatestAgentSessionId(s, s.currentAgentId, agent?.threadSessionId) || agent?.threadSessionId || null
}

export interface SessionSlice {
  sessions: Sessions
  activeSessionIdOverride: string | null
  setActiveSessionIdOverride: (id: string | null) => void
  loadSessions: () => Promise<void>
  refreshSession: (id: string) => Promise<void>
  removeSession: (id: string) => void
  clearSessions: (ids: string[]) => Promise<void>
  togglePinSession: (id: string) => Promise<void>
  updateSessionInStore: (session: Session) => void
  /**
   * Open another conversation with the agent of the current one.
   *
   * Lifted out of ChatArea because the Chat page's list header needs it too,
   * and that header renders in the route layout, outside ChatArea's closure.
   * Two copies of "clone this session's routing and start again" would be two
   * chances to drift apart.
   */
  startNewChatSession: () => Promise<Session | null>
}

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set, get) => ({
  sessions: {},
  activeSessionIdOverride: null,
  setActiveSessionIdOverride: (id) => set({ activeSessionIdOverride: id }),
  startNewChatSession: async () => {
    const state = get()
    const sessionId = selectActiveSessionId(state)
    const session = sessionId ? state.sessions[sessionId] : null
    if (!session) return null
    const agentName = session.agentId ? state.agents[session.agentId]?.name : null
    const next = await api<Session>('POST', '/chats', {
      ...buildNewAgentSessionPayload(session),
      name: agentName || session.name,
    })
    get().updateSessionInStore(next)
    set({ activeSessionIdOverride: next.id })
    return next
  },
  loadSessions: createLoader<AppState>(set, 'sessions', () => fetchChats()),
  refreshSession: async (id) => {
    if (!id) return
    await sessionRefreshDedup.dedup(id, async () => {
      try {
        const session = await fetchChat(id)
        const existing = get().sessions[id]
        // Skip update if the session data hasn't changed
        if (existing && JSON.stringify(existing) === JSON.stringify(session)) return
        invalidateFingerprint('sessions')
        set({
          sessions: { ...get().sessions, [id]: session },
        })
      } catch (err: unknown) {
        console.warn('Store error:', err)
      }
    })
  },
  removeSession: (id) => {
    const sessions = { ...get().sessions }
    delete sessions[id]
    invalidateFingerprint('sessions')
    const activeSessionId = selectActiveSessionId(get())
    if (activeSessionId === id) {
      set({ sessions, currentAgentId: null, activeSessionIdOverride: null })
    } else {
      const overrideId = get().activeSessionIdOverride
      set({ sessions, activeSessionIdOverride: overrideId === id ? null : overrideId })
    }
  },
  clearSessions: async (ids) => {
    if (!ids.length) return
    await api('DELETE', '/chats', { ids })
    const sessions = { ...get().sessions }
    for (const id of ids) delete sessions[id]
    invalidateFingerprint('sessions')
    const activeSessionId = selectActiveSessionId(get())
    if (activeSessionId && ids.includes(activeSessionId)) {
      set({ sessions, currentAgentId: null, activeSessionIdOverride: null })
    } else {
      const overrideId = get().activeSessionIdOverride
      set({
        sessions,
        activeSessionIdOverride: overrideId && ids.includes(overrideId) ? null : overrideId,
      })
    }
  },
  togglePinSession: async (id) => {
    const sessions = { ...get().sessions }
    if (!sessions[id]) return
    const wasPinned = sessions[id].pinned
    sessions[id] = { ...sessions[id], pinned: !wasPinned }
    invalidateFingerprint('sessions')
    set({ sessions })
    try {
      await api('PUT', `/chats/${id}`, { pinned: !wasPinned })
    } catch (err: unknown) {
      console.warn('Pin toggle failed:', err)
      await get().loadSessions()
    }
  },
  updateSessionInStore: (session) => {
    invalidateFingerprint('sessions')
    setIfChanged<AppState>(set, 'sessions', { ...get().sessions, [session.id]: session })
  }
})
