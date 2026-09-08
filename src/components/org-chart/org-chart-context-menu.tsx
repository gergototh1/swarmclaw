'use client'

import { useEffect, useRef, useState } from 'react'
import type { Agent } from '@/types'
import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'

interface Props {
  agent: Agent
  teamNames: string[]
  x: number
  y: number
  onClose: () => void
  onAction: (action: ContextAction) => void
}

export type ContextAction =
  | { type: 'set_role'; role: 'coordinator' | 'worker' }
  | { type: 'set_team_label'; label: string }
  | { type: 'detach' }
  | { type: 'remove_from_chart' }
  | { type: 'open_agent' }

export function OrgChartContextMenu({ agent, teamNames, x, y, onClose, onAction }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [showTeamPicker, setShowTeamPicker] = useState(false)

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = () => onClose()
    window.addEventListener('wheel', handler, { passive: true })
    return () => window.removeEventListener('wheel', handler)
  }, [onClose])

  const role = agent.role || 'worker'
  const hasParent = !!agent.orgChart?.parentId
  const currentTeam = agent.orgChart?.teamLabel || null

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[180px] bg-raised border border-line-default rounded-sm shadow-xl shadow-black/40 py-1 text-[12px]"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[10px] font-700 uppercase tracking-[0.03em] text-text-3 truncate">
        {agent.name}
      </div>
      <div className="h-px bg-layer-2 my-0.5" />

      {/* Quick-jump actions */}
      <MenuBtn onClick={() => { onAction({ type: 'open_agent' }); onClose() }}>
        Open in Agents
      </MenuBtn>

      <div className="h-px bg-layer-2 my-0.5" />

      {/* Hierarchy actions */}
      {!WORKER_ONLY_PROVIDER_IDS.has(agent.provider) && (
        role === 'worker' ? (
          <MenuBtn onClick={() => { onAction({ type: 'set_role', role: 'coordinator' }); onClose() }}>
            Promote to Coordinator
          </MenuBtn>
        ) : (
          <MenuBtn onClick={() => { onAction({ type: 'set_role', role: 'worker' }); onClose() }}>
            Demote to Worker
          </MenuBtn>
        )
      )}

      {hasParent && (
        <MenuBtn onClick={() => { onAction({ type: 'detach' }); onClose() }}>
          Detach from Parent
        </MenuBtn>
      )}

      <div className="h-px bg-layer-2 my-0.5" />

      {/* Team assignment */}
      {showTeamPicker ? (
        <div className="px-2 py-1 flex flex-col gap-0.5">
          {teamNames.length === 0 ? (
            <div className="text-[10px] text-text-3 text-center py-1.5">No teams yet</div>
          ) : (
            teamNames.map((t) => (
              <button
                key={t}
                onClick={() => {
                  onAction({ type: 'set_team_label', label: currentTeam === t ? '' : t })
                  onClose()
                }}
                className={`w-full text-left px-2 py-1 rounded-xs text-[11px] transition-colors cursor-pointer border-none ${
                  currentTeam === t
                    ? 'bg-accent-bright/10 text-accent-bright font-600'
                    : 'bg-transparent text-text-2 hover:bg-layer-2'
                }`}
                style={{ fontFamily: 'inherit' }}
              >
                {currentTeam === t ? `${t} (remove)` : t}
              </button>
            ))
          )}
        </div>
      ) : (
        <MenuBtn onClick={() => setShowTeamPicker(true)}>
          {currentTeam ? `Team: ${currentTeam}` : 'Assign Team'}
        </MenuBtn>
      )}

      <div className="h-px bg-layer-2 my-0.5" />

      <MenuBtn className="text-red-400/80" onClick={() => { onAction({ type: 'remove_from_chart' }); onClose() }}>
        Remove from Chart
      </MenuBtn>
    </div>
  )
}

function MenuBtn({ children, onClick, className = '' }: { children: React.ReactNode; onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 hover:bg-layer-2 cursor-pointer transition-colors bg-transparent border-none text-text-2 ${className}`}
      style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
    >
      {children}
    </button>
  )
}
