'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { updateAgent } from '@/lib/agents'
import { toast } from 'sonner'
import type { Agent } from '@/types'

export function AssignAgentPicker({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const loadAgents = useAppStore((s) => s.loadAgents)
  const [query, setQuery] = useState('')

  const unassigned = Object.values(agents).filter((a) =>
    !a.trashedAt && a.projectId !== projectId && (!query || a.name.toLowerCase().includes(query.toLowerCase())),
  )

  const handleAssign = async (agentId: string) => {
    await updateAgent(agentId, { projectId })
    await loadAgents()
    toast.success('Agent assigned to project')
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-0 top-full mt-2 z-50 w-[260px] rounded-md bg-surface/95 backdrop-blur-xl border border-line-default overflow-hidden">
        <div className="p-2.5 border-b border-line-subtle">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents..."
            autoFocus
            className="w-full px-2.5 py-1.5 text-[12px] bg-layer-2 rounded-sm border border-line-default text-text placeholder:text-text-3 outline-none"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
        <div className="max-h-[240px] overflow-y-auto p-1">
          {unassigned.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-text-3 text-center">
              {query ? 'No matching agents' : 'All agents are already assigned'}
            </div>
          )}
          {unassigned.map((a) => (
            <button
              key={a.id}
              onClick={() => handleAssign(a.id)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-sm text-left hover:bg-layer-2 transition-colors cursor-pointer bg-transparent border-none"
              style={{ fontFamily: 'inherit' }}
            >
              <AgentAvatar seed={a.avatarSeed} avatarUrl={a.avatarUrl} name={a.name} size={22} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-text truncate">{a.name}</div>
                <div className="text-[10px] text-text-3 truncate">{a.model || a.provider}</div>
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
