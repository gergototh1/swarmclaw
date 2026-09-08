'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'

interface TransferAgentPickerProps {
  /** Agent IDs to exclude from the list (e.g. current agent) */
  excludeIds?: string[]
  /** Restrict to these agent IDs only (e.g. chatroom members) */
  filterIds?: string[]
  onSelect: (agentId: string) => void
  onClose: () => void
}

export function TransferAgentPicker({ excludeIds, filterIds, onSelect, onClose }: TransferAgentPickerProps) {
  const agents = useAppStore((s) => s.agents)
  const [query, setQuery] = useState('')

  const excludeSet = new Set(excludeIds || [])
  const filterSet = filterIds ? new Set(filterIds) : null

  const filtered = Object.values(agents).filter((a) =>
    !a.trashedAt
    && !excludeSet.has(a.id)
    && (!filterSet || filterSet.has(a.id))
    && (!query || a.name.toLowerCase().includes(query.toLowerCase())),
  )

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-0 bottom-full mb-2 z-50 w-[220px] rounded-sm bg-surface/80 backdrop-blur-xl border border-line-default overflow-hidden">
        <div className="p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents..."
            autoFocus
            className="w-full px-2 py-1.5 text-[12px] bg-layer-2 rounded-xs border border-line-default text-text placeholder:text-text-3 outline-none"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
        <div className="max-h-[200px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-text-3 text-center">No agents</div>
          )}
          {filtered.map((a) => (
            <button
              key={a.id}
              onClick={() => onSelect(a.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-layer-2 transition-colors cursor-pointer bg-transparent border-none"
              style={{ fontFamily: 'inherit' }}
            >
              <AgentAvatar seed={a.avatarSeed} avatarUrl={a.avatarUrl} name={a.name} size={20} />
              <span className="text-[12px] text-text truncate">{a.name}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
