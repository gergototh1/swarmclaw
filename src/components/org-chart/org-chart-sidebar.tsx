'use client'

import { useCallback, useRef, useState } from 'react'
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
  agents: Agent[]
  allAgents: Record<string, Agent>
  teams: TeamInfo[]
  onDragStart?: (e: React.PointerEvent, agentId: string) => void
  onTeamDragStart?: (e: React.PointerEvent, team: TeamInfo) => void
  onPlaceTeam?: (team: TeamInfo) => void
  onBatchPatch: (patches: Array<{ id: string; patch: Partial<Agent> }>) => void
}

type RoleFilter = 'all' | 'worker' | 'coordinator'
type SidebarTab = 'agents' | 'teams'

export function OrgChartSidebar({ agents, allAgents, teams, onDragStart, onTeamDragStart, onPlaceTeam, onBatchPatch }: Props) {
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [tab, setTab] = useState<SidebarTab>('agents')
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [showAddAgent, setShowAddAgent] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [colorPickerOpen, setColorPickerOpen] = useState<string | null>(null)
  const [showNewTeam, setShowNewTeam] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [newTeamColor, setNewTeamColor] = useState(TEAM_COLORS[0])
  const [newTeamConfirmed, setNewTeamConfirmed] = useState(false)
  const [addAgentSearch, setAddAgentSearch] = useState('')
  const [width, setWidth] = useState(280)
  const resizing = useRef(false)

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizing.current = true
    const startX = e.clientX
    const startW = width
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)

    const onMove = (ev: PointerEvent) => {
      if (!resizing.current) return
      const newW = Math.max(180, Math.min(400, startW + (ev.clientX - startX)))
      setWidth(newW)
    }
    const onUp = () => {
      resizing.current = false
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }, [width])

  const allAgentCount = Object.values(allAgents).filter(a => !a.trashedAt).length
  const hasContent = agents.length > 0 || teams.length > 0 || allAgentCount > 0
  if (!hasContent) return null

  const filtered = agents.filter((a) => {
    if (query && !a.name.toLowerCase().includes(query.toLowerCase())) return false
    if (roleFilter !== 'all' && (a.role || 'worker') !== roleFilter) return false
    return true
  })

  const workerCount = agents.filter((a) => (a.role || 'worker') === 'worker').length
  const coordCount = agents.filter((a) => a.role === 'coordinator').length

  // Agents not assigned to any team
  const teamAgentIds = new Set(teams.flatMap((t) => t.agentIds))
  const unassignedAgents = Object.values(allAgents).filter(
    (a) => !a.trashedAt && !teamAgentIds.has(a.id),
  )

  const renameTeam = (oldLabel: string, newLabel: string) => {
    const trimmed = newLabel.trim()
    if (!trimmed || trimmed === oldLabel) { setEditingLabel(null); return }
    const team = teams.find((t) => t.label === oldLabel)
    if (!team) return
    const patches = team.agentIds.map((id) => ({
      id,
      patch: { orgChart: { ...(allAgents[id]?.orgChart || {}), teamLabel: trimmed } } as Partial<Agent>,
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
      patch: { orgChart: { ...(allAgents[id]?.orgChart || {}), teamColor: color } } as Partial<Agent>,
    }))
    onBatchPatch(patches)
  }

  const deleteTeam = (label: string) => {
    const team = teams.find((t) => t.label === label)
    if (!team) return
    const patches = team.agentIds.map((id) => ({
      id,
      patch: { orgChart: { ...(allAgents[id]?.orgChart || {}), teamLabel: null, teamColor: null } } as Partial<Agent>,
    }))
    onBatchPatch(patches)
    setConfirmDelete(null)
    if (expandedTeam === label) setExpandedTeam(null)
  }

  const removeFromTeam = (agentId: string) => {
    onBatchPatch([{
      id: agentId,
      patch: { orgChart: { ...(allAgents[agentId]?.orgChart || {}), teamLabel: null, teamColor: null } } as Partial<Agent>,
    }])
  }

  const addToTeam = (agentId: string, teamLabel: string) => {
    const team = teams.find((t) => t.label === teamLabel)
    const teamColor = team?.color || null
    // Place near existing team members
    let x: number | undefined
    let y: number | undefined
    const placedMembers = (team?.agentIds || [])
      .map((id) => allAgents[id])
      .filter((a): a is Agent => !!a && a.orgChart?.x != null)
    if (placedMembers.length > 0) {
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
    onBatchPatch([{
      id: agentId,
      patch: {
        orgChart: {
          ...(allAgents[agentId]?.orgChart || {}),
          teamLabel,
          ...(teamColor ? { teamColor } : {}),
          ...(x != null ? { x, y } : {}),
        },
      } as Partial<Agent>,
    }])
    setShowAddAgent(null)
  }

  return (
    <div className="absolute top-4 left-4 z-20 max-h-[calc(100%-32px)] flex flex-col bg-raised/90 backdrop-blur-sm border border-line-subtle rounded-md shadow-lg overflow-hidden select-none" style={{ width }} onWheel={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize z-10 hover:bg-accent-bright/10 active:bg-accent-bright/20 transition-colors"
        onPointerDown={onResizePointerDown}
      />
      {/* Tab switcher */}
      <div className="flex border-b border-line-subtle">
        <button
          onClick={() => setTab('agents')}
          className={`flex-1 text-[10px] font-600 tracking-[0.03em] py-2.5 transition-colors cursor-pointer bg-transparent border-none ${
            tab === 'agents' ? 'text-text border-b-2 border-accent-bright' : 'text-text-3/60 hover:text-text-3'
          }`}
        >
          Agents ({agents.length})
        </button>
        <button
          onClick={() => setTab('teams')}
          className={`flex-1 text-[10px] font-600 tracking-[0.03em] py-2.5 transition-colors cursor-pointer bg-transparent border-none ${
            tab === 'teams' ? 'text-text border-b-2 border-accent-bright' : 'text-text-3/60 hover:text-text-3'
          }`}
        >
          Teams ({teams.length})
        </button>
      </div>

      {tab === 'agents' && (
        <>
          <div className="px-2 pt-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents..."
              className="w-full px-2 py-1 text-[11px] bg-layer-2 border border-line-default rounded-xs text-text outline-none focus:border-accent-bright/30 placeholder:text-text-3"
            />
          </div>
          <div className="px-2 pt-1.5 pb-1 flex gap-1">
            {([['all', 'All', agents.length], ['worker', 'Workers', workerCount], ['coordinator', 'Coords', coordCount]] as const).map(([key, label, count]) => (
              <button
                key={key}
                onClick={() => setRoleFilter(key as RoleFilter)}
                className={`text-[9px] font-600 px-1.5 py-0.5 rounded-xs border transition-colors cursor-pointer bg-transparent ${
                  roleFilter === key
                    ? 'border-accent-bright/30 text-accent-bright bg-accent-bright/10'
                    : 'border-line-subtle text-text-3/60 hover:text-text-3'
                }`}
              >
                {label} ({count})
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain p-2 flex flex-col gap-1">
            {filtered.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-layer-2 cursor-grab active:cursor-grabbing transition-colors touch-none"
                onPointerDown={(e) => onDragStart?.(e, agent.id)}
              >
                <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={20} />
                <span className="text-[11px] font-600 text-text-2 truncate">{agent.name}</span>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="text-[10px] text-text-3 text-center py-2">No matches</div>
            )}
          </div>
        </>
      )}

      {tab === 'teams' && (
        <div className="flex-1 overflow-y-auto overscroll-contain p-2 flex flex-col gap-1">
          {teams.length === 0 && !showNewTeam && (
            <div className="text-[10px] text-text-3 text-center py-4">No teams yet</div>
          )}
          {teams.map((team) => {
            const isExpanded = expandedTeam === team.label
            const unplacedCount = team.agentIds.filter((id) => allAgents[id]?.orgChart?.x == null).length
            return (
              <div key={team.label} className="rounded-sm">
                {/* Team row */}
                <div className="flex items-center gap-1.5 px-1 py-1.5 rounded-sm hover:bg-layer-2 transition-colors group">
                  {/* Drag grip */}
                  <div
                    className="shrink-0 w-3.5 h-5 flex flex-col items-center justify-center gap-[2px] cursor-grab active:cursor-grabbing text-text-3/25 hover:text-text-3/50 touch-none"
                    onPointerDown={(e) => onTeamDragStart?.(e, team)}
                    title="Drag to chart"
                  >
                    {[0, 1, 2].map((r) => (
                      <div key={r} className="flex gap-[2px]">
                        <div className="w-[2px] h-[2px] rounded-full bg-current" />
                        <div className="w-[2px] h-[2px] rounded-full bg-current" />
                      </div>
                    ))}
                  </div>
                  {/* Expand */}
                  <button
                    onClick={() => setExpandedTeam(isExpanded ? null : team.label)}
                    className="w-3.5 h-3.5 flex items-center justify-center text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer shrink-0"
                  >
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                      style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                  {/* Color dot — click to pick */}
                  <div className="relative">
                    <button
                      className="w-3 h-3 rounded-full border border-line-default cursor-pointer hover:scale-110 transition-transform shrink-0"
                      style={{ background: team.color || '#6366F1' }}
                      title="Change color"
                      onClick={() => setColorPickerOpen(colorPickerOpen === team.label ? null : team.label)}
                    />
                    {colorPickerOpen === team.label && (
                      <div className="absolute top-5 left-0 z-50 bg-raised border border-line-default rounded-sm p-1.5 flex flex-wrap gap-1 shadow-lg w-[76px]">
                        {TEAM_COLORS.map((c) => (
                          <button
                            key={c}
                            className="w-4 h-4 rounded-full border border-line-default cursor-pointer hover:scale-110 transition-transform"
                            style={{ background: c }}
                            onClick={() => { changeTeamColor(team.label, c); setColorPickerOpen(null) }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Label — click to rename */}
                  {editingLabel === team.label ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => renameTeam(team.label, editValue)}
                      onKeyDown={(e) => { if (e.key === 'Enter') renameTeam(team.label, editValue) }}
                      className="flex-1 px-1 py-0.5 text-[10px] bg-layer-2 border border-line-default rounded-xs text-text outline-none focus:border-accent-bright/30 min-w-0"
                    />
                  ) : (
                    <span
                      className="flex-1 text-[11px] font-600 text-text-2 truncate cursor-text"
                      onClick={() => { setEditingLabel(team.label); setEditValue(team.label) }}
                    >
                      {team.label}
                    </span>
                  )}
                  <span className="text-[9px] text-text-3 tabular-nums">{team.agentIds.length}</span>
                  {/* Place */}
                  {unplacedCount > 0 && (
                    <button
                      onClick={() => onPlaceTeam?.(team)}
                      className="hidden group-hover:block text-[8px] font-600 px-1 py-0.5 rounded-xs border border-accent-bright/20 text-accent-bright bg-accent-bright/5 hover:bg-accent-bright/15 cursor-pointer transition-colors"
                      title="Place on chart"
                    >
                      Place
                    </button>
                  )}
                  {/* Delete */}
                  {confirmDelete === team.label ? (
                    <div className="flex gap-1">
                      <button onClick={() => deleteTeam(team.label)} className="text-[9px] text-red-400 bg-transparent border-none cursor-pointer">Yes</button>
                      <button onClick={() => setConfirmDelete(null)} className="text-[9px] text-text-3 bg-transparent border-none cursor-pointer">No</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(team.label)}
                      className="hidden group-hover:flex w-3.5 h-3.5 rounded-xs items-center justify-center text-text-3 hover:text-red-400 bg-transparent border-none cursor-pointer transition-colors"
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M3 6h18" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" /><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Expanded: members + add */}
                {isExpanded && (
                  <div className="flex flex-col gap-0.5 pl-3 pb-1.5">
                    {team.agentIds.map((id) => {
                      const a = allAgents[id]
                      if (!a) return null
                      const onChart = a.orgChart?.x != null
                      return (
                        <div
                          key={id}
                          className={`flex items-center gap-2 px-2 py-1 rounded-xs group/member transition-colors ${
                            onChart
                              ? 'hover:bg-layer-1'
                              : 'hover:bg-layer-2 cursor-grab active:cursor-grabbing touch-none'
                          }`}
                          onPointerDown={onChart ? undefined : (e) => onDragStart?.(e, id)}
                        >
                          <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={16} />
                          <span className="flex-1 text-[10px] text-text-2 truncate">{a.name}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeFromTeam(id) }}
                            className="hidden group-hover/member:flex w-3.5 h-3.5 rounded-xs items-center justify-center text-text-3 hover:text-red-400 bg-transparent border-none cursor-pointer transition-colors"
                            title="Remove from team"
                          >
                            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      )
                    })}
                    {/* Add agent */}
                    {showAddAgent === team.label ? (
                      <AgentPicker
                        agents={unassignedAgents}
                        search={addAgentSearch}
                        onSearchChange={setAddAgentSearch}
                        onSelect={(id) => addToTeam(id, team.label)}
                        onClose={() => { setShowAddAgent(null); setAddAgentSearch('') }}
                      />
                    ) : (
                      <button
                        onClick={() => { setShowAddAgent(team.label); setAddAgentSearch('') }}
                        className="flex items-center gap-1 px-2 py-1 text-[9px] text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer transition-colors"
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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

          {/* New team */}
          {showNewTeam ? (
            <div className="px-1 py-1.5 flex flex-col gap-1.5 rounded-sm border border-line-subtle bg-layer-1">
              {!newTeamConfirmed ? (
                <>
                  {/* Name + color in one step */}
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={newTeamName}
                      onChange={(e) => setNewTeamName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newTeamName.trim()) setNewTeamConfirmed(true)
                        if (e.key === 'Escape') { setShowNewTeam(false); setNewTeamName(''); setNewTeamConfirmed(false); setNewTeamColor(TEAM_COLORS[0]) }
                      }}
                      placeholder="Team name..."
                      className="flex-1 min-w-0 px-2 py-1.5 text-[10px] bg-layer-2 border border-line-default rounded-xs text-text outline-none focus:border-accent-bright/30 placeholder:text-text-3"
                    />
                    <button
                      onClick={() => { if (newTeamName.trim()) setNewTeamConfirmed(true) }}
                      disabled={!newTeamName.trim()}
                      className="shrink-0 text-[9px] font-600 px-2 py-1.5 rounded-xs border-none cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default bg-accent-bright/15 text-accent-bright hover:bg-accent-bright/25"
                    >
                      Next
                    </button>
                  </div>
                  <div className="flex items-center gap-1 px-0.5">
                    <span className="text-[8px] text-text-3 mr-0.5">Color</span>
                    {TEAM_COLORS.map((c) => (
                      <button
                        key={c}
                        className="w-3.5 h-3.5 rounded-full border-2 cursor-pointer hover:scale-110 transition-all"
                        style={{
                          background: c,
                          borderColor: newTeamColor === c ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.08)',
                        }}
                        onClick={() => setNewTeamColor(c)}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 px-1">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: newTeamColor }} />
                    <span className="text-[10px] font-600 text-text-2 truncate flex-1">{newTeamName.trim()}</span>
                    <button onClick={() => setNewTeamConfirmed(false)} className="text-[8px] text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer">edit</button>
                  </div>
                  <div className="text-[8px] text-text-3 px-1">Pick first agent:</div>
                  <AgentPicker
                    agents={unassignedAgents}
                    search={addAgentSearch}
                    onSearchChange={setAddAgentSearch}
                    onSelect={(id) => {
                      const name = newTeamName.trim()
                      // Add agent with team color
                      const agent = allAgents[id]
                      onBatchPatch([{
                        id,
                        patch: {
                          orgChart: {
                            ...(agent?.orgChart || {}),
                            teamLabel: name,
                            teamColor: newTeamColor,
                          },
                        } as Partial<Agent>,
                      }])
                      setShowNewTeam(false)
                      setNewTeamName('')
                      setNewTeamColor(TEAM_COLORS[0])
                      setNewTeamConfirmed(false)
                      setAddAgentSearch('')
                      setExpandedTeam(name)
                    }}
                    onClose={() => { setShowNewTeam(false); setNewTeamName(''); setNewTeamColor(TEAM_COLORS[0]); setNewTeamConfirmed(false); setAddAgentSearch('') }}
                  />
                </>
              )}
              <button
                onClick={() => { setShowNewTeam(false); setNewTeamName(''); setNewTeamColor(TEAM_COLORS[0]); setNewTeamConfirmed(false); setAddAgentSearch('') }}
                className="text-[8px] text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer self-center py-0.5"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowNewTeam(true)}
              className="flex items-center justify-center gap-1 w-full py-1.5 mt-0.5 rounded-xs border border-dashed border-line-default text-[9px] font-600 text-text-3 hover:text-text-2 hover:bg-layer-1 bg-transparent cursor-pointer transition-colors"
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Team
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AgentPicker({
  agents,
  search,
  onSearchChange,
  onSelect,
  onClose,
}: {
  agents: Agent[]
  search: string
  onSearchChange: (v: string) => void
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const filtered = search
    ? agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents

  return (
    <div className="mt-0.5 flex flex-col gap-0.5 rounded-xs border border-line-subtle bg-layer-1 p-1">
      {agents.length > 3 && (
        <input
          autoFocus
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
          placeholder="Search..."
          className="w-full px-1.5 py-1 text-[9px] bg-layer-2 border border-line-default rounded-xs text-text outline-none focus:border-accent-bright/30 placeholder:text-text-3 mb-0.5"
        />
      )}
      <div className="max-h-[100px] overflow-y-auto flex flex-col gap-0.5">
        {agents.length === 0 ? (
          <div className="text-[9px] text-text-3 text-center py-1.5">All agents assigned</div>
        ) : filtered.length === 0 ? (
          <div className="text-[9px] text-text-3 text-center py-1.5">No matches</div>
        ) : (
          filtered.map((a) => (
            <button
              key={a.id}
              onClick={() => onSelect(a.id)}
              className="flex items-center gap-2 px-1.5 py-1 rounded-xs hover:bg-layer-2 bg-transparent border-none cursor-pointer text-left w-full transition-colors"
            >
              <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={14} />
              <span className="text-[9px] text-text-3 truncate">{a.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
