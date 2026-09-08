'use client'

import { useEffect, useRef, useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { Agent } from '@/types'

const TEAM_COLORS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#EF4444',
  '#F59E0B', '#10B981', '#06B6D4', '#3B82F6',
]

interface TeamInfo {
  label: string
  color: string | null
  agentIds: string[]
}

interface Props {
  teams: TeamInfo[]
  agents: Record<string, Agent>
  onBatchPatch: (patches: Array<{ id: string; patch: Partial<Agent> }>) => void
  onClose: () => void
}

export function OrgChartTeamPanel({ teams, agents, onBatchPatch, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null)
  const [showAddAgent, setShowAddAgent] = useState<string | null>(null)
  const [showNewTeam, setShowNewTeam] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [newTeamConfirmed, setNewTeamConfirmed] = useState(false)

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [onClose])

  const renameTeam = (oldLabel: string, newLabel: string) => {
    const trimmed = newLabel.trim()
    if (!trimmed || trimmed === oldLabel) { setEditingLabel(null); return }
    const team = teams.find((t) => t.label === oldLabel)
    if (!team) return
    const patches = team.agentIds.map((id) => ({
      id,
      patch: { orgChart: { ...(agents[id]?.orgChart || {}), teamLabel: trimmed } } as Partial<Agent>,
    }))
    onBatchPatch(patches)
    setEditingLabel(null)
    if (expandedTeam === oldLabel) setExpandedTeam(trimmed)
  }

  const changeTeamColor = (label: string, color: string) => {
    const team = teams.find((t) => t.label === label)
    if (!team) return
    const patches = team.agentIds.map((id) => ({
      id,
      patch: { orgChart: { ...(agents[id]?.orgChart || {}), teamColor: color } } as Partial<Agent>,
    }))
    onBatchPatch(patches)
  }

  const deleteTeam = (label: string) => {
    const team = teams.find((t) => t.label === label)
    if (!team) return
    const patches = team.agentIds.map((id) => ({
      id,
      patch: { orgChart: { ...(agents[id]?.orgChart || {}), teamLabel: null, teamColor: null } } as Partial<Agent>,
    }))
    onBatchPatch(patches)
    setConfirmDelete(null)
    if (expandedTeam === label) setExpandedTeam(null)
  }

  const removeFromTeam = (agentId: string) => {
    onBatchPatch([{
      id: agentId,
      patch: { orgChart: { ...(agents[agentId]?.orgChart || {}), teamLabel: null, teamColor: null } } as Partial<Agent>,
    }])
  }

  const addToTeam = (agentId: string, teamLabel: string) => {
    const team = teams.find((t) => t.label === teamLabel)
    const teamColor = team?.color || null

    // Find position near existing team members on the chart
    let x: number | undefined
    let y: number | undefined
    const teamMembers = team?.agentIds || []
    const placedMembers = teamMembers
      .map((id) => agents[id])
      .filter((a): a is Agent => !!a && a.orgChart?.x != null)

    if (placedMembers.length > 0) {
      // Place to the right of the rightmost team member
      let maxX = -Infinity
      let maxY = 0
      for (const a of placedMembers) {
        if ((a.orgChart?.x ?? 0) > maxX) {
          maxX = a.orgChart?.x ?? 0
          maxY = a.orgChart?.y ?? 0
        }
      }
      x = maxX + 220
      y = maxY
    }

    const orgChart = {
      ...(agents[agentId]?.orgChart || {}),
      teamLabel,
      ...(teamColor ? { teamColor } : {}),
      ...(x != null ? { x, y } : {}),
    }

    onBatchPatch([{ id: agentId, patch: { orgChart } as Partial<Agent> }])
    setShowAddAgent(null)
  }

  const placeTeamOnChart = (team: TeamInfo) => {
    // Find the rightmost edge of existing chart positions to avoid overlap
    let maxX = 0
    for (const a of Object.values(agents)) {
      if (a.orgChart?.x != null) {
        const right = a.orgChart.x + 200
        if (right > maxX) maxX = right
      }
    }
    const startX = maxX + 80 // gap from existing nodes
    const startY = 40
    const colGap = 220
    const rowGap = 130
    const cols = Math.max(2, Math.ceil(Math.sqrt(team.agentIds.length)))

    const patches = team.agentIds.map((id, i) => ({
      id,
      patch: {
        orgChart: {
          ...(agents[id]?.orgChart || {}),
          x: startX + (i % cols) * colGap,
          y: startY + Math.floor(i / cols) * rowGap,
        },
      } as Partial<Agent>,
    }))
    if (patches.length > 0) onBatchPatch(patches)
  }

  // Agents not assigned to any team
  const teamAgentIds = new Set(teams.flatMap((t) => t.agentIds))
  const unassignedAgents = Object.values(agents).filter(
    (a) => !a.trashedAt && !teamAgentIds.has(a.id),
  )

  return (
    <div
      ref={ref}
      className="absolute top-14 right-4 z-40 w-[260px] bg-raised border border-line-default rounded-md shadow-xl shadow-black/40"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-line-subtle flex items-center justify-between">
        <span className="text-[11px] font-700 uppercase tracking-wider text-text-3">Teams</span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded-xs flex items-center justify-center text-text-3 hover:text-text hover:bg-layer-2 transition-colors cursor-pointer bg-transparent border-none"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="max-h-[400px] overflow-y-auto p-2 flex flex-col gap-1">
        {teams.length === 0 && !showNewTeam && (
          <div className="text-[11px] text-text-3 text-center py-4">No teams yet. Create one below or assign a team via the detail panel.</div>
        )}
        {teams.map((team) => {
          const isExpanded = expandedTeam === team.label
          return (
            <div key={team.label} className="rounded-sm border border-transparent hover:border-line-subtle">
              {/* Team row */}
              <div className="flex items-center gap-2 px-2 py-1.5 group">
                {/* Expand chevron */}
                <button
                  onClick={() => setExpandedTeam(isExpanded ? null : team.label)}
                  className="w-3.5 h-3.5 flex items-center justify-center text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer transition-colors shrink-0"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>

                {/* Color picker */}
                <div className="relative">
                  <button
                    className="w-4 h-4 rounded-full border border-line-default cursor-pointer hover:scale-110 transition-transform shrink-0"
                    style={{ background: team.color || '#6366F1' }}
                    title="Change color"
                    onClick={(e) => {
                      const picker = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement | null
                      if (picker) picker.classList.toggle('hidden')
                    }}
                  />
                  <div className="hidden absolute top-6 left-0 z-50 bg-raised border border-line-default rounded-sm p-1.5 flex flex-wrap gap-1 shadow-lg w-[76px]">
                    {TEAM_COLORS.map((c) => (
                      <button
                        key={c}
                        className="w-4 h-4 rounded-full border border-line-default cursor-pointer hover:scale-110 transition-transform"
                        style={{ background: c }}
                        onClick={() => changeTeamColor(team.label, c)}
                      />
                    ))}
                  </div>
                </div>

                {/* Label */}
                {editingLabel === team.label ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => renameTeam(team.label, editValue)}
                    onKeyDown={(e) => { if (e.key === 'Enter') renameTeam(team.label, editValue) }}
                    className="flex-1 px-1 py-0.5 text-[11px] bg-layer-2 border border-line-default rounded-xs text-text outline-none focus:border-accent-bright/30 min-w-0"
                  />
                ) : (
                  <span
                    className="flex-1 text-[11px] font-500 text-text-2 truncate cursor-text"
                    onClick={() => { setEditingLabel(team.label); setEditValue(team.label) }}
                  >
                    {team.label}
                  </span>
                )}

                <span className="text-[10px] text-text-3 tabular-nums">{team.agentIds.length}</span>

                {/* Place on chart */}
                {(() => {
                  const unplaced = team.agentIds.filter((id) => {
                    const a = agents[id]
                    return a && a.orgChart?.x == null
                  })
                  if (unplaced.length === 0) return null
                  return (
                    <button
                      onClick={() => placeTeamOnChart(team)}
                      className="hidden group-hover:flex items-center justify-center w-4 h-4 rounded-xs text-text-3 hover:text-accent-bright bg-transparent border-none cursor-pointer transition-colors"
                      title="Place on chart"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
                      </svg>
                    </button>
                  )
                })()}

                {/* Delete */}
                {confirmDelete === team.label ? (
                  <div className="flex gap-1">
                    <button onClick={() => deleteTeam(team.label)} className="text-[9px] text-red-400 bg-transparent border-none cursor-pointer">Yes</button>
                    <button onClick={() => setConfirmDelete(null)} className="text-[9px] text-text-3 bg-transparent border-none cursor-pointer">No</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(team.label)}
                    className="hidden group-hover:flex w-4 h-4 rounded-xs items-center justify-center text-text-3 hover:text-red-400 bg-transparent border-none cursor-pointer transition-colors"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 6h18" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" /><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Expanded member list */}
              {isExpanded && (
                <div className="px-2 pb-2 flex flex-col gap-0.5">
                  {team.agentIds.map((aid) => {
                    const a = agents[aid]
                    if (!a) return null
                    return (
                      <div key={aid} className="flex items-center gap-2 pl-5 pr-1 py-1 rounded-xs hover:bg-layer-1 group/member">
                        <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={18} />
                        <span className="flex-1 text-[10px] text-text-2 truncate">{a.name}</span>
                        <span className="text-[9px] text-text-3 capitalize">{a.role || 'worker'}</span>
                        <button
                          onClick={() => removeFromTeam(aid)}
                          className="hidden group-hover/member:flex w-3.5 h-3.5 rounded-xs items-center justify-center text-text-3 hover:text-red-400 bg-transparent border-none cursor-pointer transition-colors"
                          title="Remove from team"
                        >
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    )
                  })}

                  {/* Add agent to team */}
                  {showAddAgent === team.label ? (
                    <div className="pl-5 mt-1 flex flex-col gap-0.5 max-h-[120px] overflow-y-auto rounded-xs border border-line-subtle bg-layer-1 p-1">
                      {unassignedAgents.length === 0 ? (
                        <div className="text-[10px] text-text-3 text-center py-2">All agents assigned</div>
                      ) : (
                        unassignedAgents.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => addToTeam(a.id, team.label)}
                            className="flex items-center gap-2 px-1.5 py-1 rounded-xs hover:bg-layer-2 bg-transparent border-none cursor-pointer text-left w-full transition-colors"
                          >
                            <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={16} />
                            <span className="text-[10px] text-text-3 truncate">{a.name}</span>
                          </button>
                        ))
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowAddAgent(team.label)}
                      className="flex items-center gap-1 pl-5 py-1 text-[10px] text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer transition-colors"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      Add agent
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* Create new team */}
        {showNewTeam ? (
          <div className="px-2 py-1.5 flex flex-col gap-1.5 rounded-sm border border-line-subtle bg-layer-1">
            {!newTeamConfirmed ? (
              /* Step 1: Name input */
              <input
                autoFocus
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTeamName.trim()) setNewTeamConfirmed(true)
                  if (e.key === 'Escape') { setShowNewTeam(false); setNewTeamName(''); setNewTeamConfirmed(false) }
                }}
                placeholder="Team name, then press Enter..."
                className="w-full px-2 py-1.5 text-[11px] bg-layer-2 border border-line-default rounded-xs text-text outline-none focus:border-accent-bright/30 placeholder:text-text-3"
              />
            ) : (
              /* Step 2: Pick agents */
              <>
                <div className="flex items-center justify-between px-1">
                  <span className="text-[10px] font-600 text-text-2 truncate">{newTeamName.trim()}</span>
                  <button
                    onClick={() => setNewTeamConfirmed(false)}
                    className="text-[9px] text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer"
                  >
                    rename
                  </button>
                </div>
                <div className="flex flex-col gap-0.5 max-h-[140px] overflow-y-auto">
                  {unassignedAgents.length === 0 ? (
                    <div className="text-[10px] text-text-3 text-center py-2">No unassigned agents</div>
                  ) : (
                    unassignedAgents.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => {
                          const name = newTeamName.trim()
                          addToTeam(a.id, name)
                          setShowNewTeam(false)
                          setNewTeamName('')
                          setNewTeamConfirmed(false)
                          setExpandedTeam(name)
                        }}
                        className="flex items-center gap-2 px-1.5 py-1 rounded-xs hover:bg-layer-2 bg-transparent border-none cursor-pointer text-left w-full transition-colors"
                      >
                        <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={16} />
                        <span className="text-[10px] text-text-3 truncate">{a.name}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
            <button
              onClick={() => { setShowNewTeam(false); setNewTeamName(''); setNewTeamConfirmed(false) }}
              className="text-[9px] text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer self-center"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewTeam(true)}
            className="flex items-center justify-center gap-1.5 w-full py-2 mt-1 rounded-sm border border-dashed border-line-default text-[10px] font-500 text-text-3 hover:text-text-2 hover:bg-layer-1 bg-transparent cursor-pointer transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Team
          </button>
        )}
      </div>
    </div>
  )
}
