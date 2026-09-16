import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { Session, Agent, ExternalAgentRuntime } from '../../types'
import { fetchAgents, bulkPatchAgents } from '../../lib/agents'
import { api } from '@/lib/app/api-client'
import { safeStorageRemove, safeStorageSet } from '@/lib/app/safe-storage'
import { invalidateFingerprint, setIfChanged } from '../set-if-changed'
import { createLoader, createInflightDeduplicator } from '../store-utils'

const agentThreadDedup = createInflightDeduplicator('agentSlice_inflightLoads')

export interface AgentSlice {
  currentAgentId: string | null
  setCurrentAgent: (id: string | null) => Promise<void>
  /** The agent's long-lived thread, created on first use. Null when the server refused. */
  ensureAgentThread: (agentId: string) => Promise<Session | null>
  agents: Record<string, Agent>
  loadAgents: () => Promise<void>
  updateAgentInStore: (agent: Agent) => void
  togglePinAgent: (id: string) => Promise<void>
  trashedAgents: Record<string, Agent>
  loadTrashedAgents: () => Promise<void>
  batchUpdateAgents: (patches: Array<{ id: string; patch: Partial<Agent> }>) => Promise<void>
  externalAgents: ExternalAgentRuntime[]
  loadExternalAgents: () => Promise<void>
}

export const createAgentSlice: StateCreator<AppState, [], [], AgentSlice> = (set, get) => ({
  currentAgentId: null,
  setCurrentAgent: async (id) => {
    if (!id) {
      set({ currentAgentId: null, activeSessionIdOverride: null })
      safeStorageRemove('sc_agent')
      return
    }
    if (get().currentAgentId === id && get().agents[id]?.threadSessionId) {
      set({ activeSessionIdOverride: null })
      return
    }
    set({ currentAgentId: id, activeSessionIdOverride: null })
    safeStorageSet('sc_agent', id)

    await get().ensureAgentThread(id)
  },
  ensureAgentThread: async (agentId) => {
    const existingId = get().agents[agentId]?.threadSessionId
    if (existingId && get().sessions[existingId]) return get().sessions[existingId]
    await agentThreadDedup.dedup(agentId, async () => {
      try {
        const user = get().currentUser || 'default'
        const session = await api<Session>('POST', `/agents/${agentId}/thread`, { user })
        if (session?.id) {
          const agents = { ...get().agents }
          if (agents[agentId]) agents[agentId] = { ...agents[agentId], threadSessionId: session.id }
          const sessions = { ...get().sessions, [session.id]: session }
          invalidateFingerprint('sessions')
          set({ sessions, agents })
        }
      } catch (err: unknown) {
        console.warn('Agent thread creation failed:', err)
      }
    })
    const threadId = get().agents[agentId]?.threadSessionId
    return threadId ? get().sessions[threadId] ?? null : null
  },
  agents: {},
  loadAgents: createLoader<AppState>(set, 'agents', () => fetchAgents()),
  updateAgentInStore: (agent) => {
    invalidateFingerprint('agents')
    setIfChanged<AppState>(set, 'agents', { ...get().agents, [agent.id]: agent })
  },
  togglePinAgent: async (id) => {
    const agents = { ...get().agents }
    if (!agents[id]) return
    const wasPinned = agents[id].pinned
    agents[id] = { ...agents[id], pinned: !wasPinned }
    invalidateFingerprint('agents')
    set({ agents })
    try {
      await api('PUT', `/agents/${id}`, { pinned: !wasPinned })
    } catch (err: unknown) {
      console.warn('Pin toggle failed:', err)
      await get().loadAgents()
    }
  },
  batchUpdateAgents: async (patches) => {
    // Optimistic update
    const agents = { ...get().agents }
    for (const { id, patch } of patches) {
      if (agents[id]) {
        agents[id] = { ...agents[id], ...patch, updatedAt: Date.now() }
      }
    }
    invalidateFingerprint('agents')
    set({ agents })
    try {
      await bulkPatchAgents(patches)
      await get().loadAgents()
    } catch (err: unknown) {
      console.warn('Bulk agent update failed:', err)
      await get().loadAgents()
    }
  },
  trashedAgents: {},
  loadTrashedAgents: createLoader<AppState>(set, 'trashedAgents', () => api<Record<string, Agent>>('GET', '/agents/trash')),
  externalAgents: [],
  loadExternalAgents: createLoader<AppState>(set, 'externalAgents', () => api<ExternalAgentRuntime[]>('GET', '/external-agents'))
})
