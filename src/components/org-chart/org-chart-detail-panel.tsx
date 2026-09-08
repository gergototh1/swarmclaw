'use client'

import { useCallback, useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentPickerList } from '@/components/shared/agent-picker-list'
import { resolveTeamColor } from '@/lib/org-chart'
import type { Agent } from '@/types'
import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import { isOrchestratorProviderEligible } from '@/lib/orchestrator-config'

const TEAM_COLORS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#EF4444',
  '#F59E0B', '#10B981', '#06B6D4', '#3B82F6',
]

interface Props {
  agent: Agent
  allAgents: Record<string, Agent>
  teamNames: string[]
  lastError?: string | null
  onPatch: (patches: Array<{ id: string; patch: Partial<Agent> }>) => void
  onNavigate: (view: string, id?: string | null) => void
  onRemove: () => void
  onClose: () => void
}

export function OrgChartDetailPanel({
  agent,
  allAgents,
  teamNames,
  lastError,
  onPatch,
  onNavigate,
  onRemove,
  onClose,
}: Props) {
  const role = agent.role || 'worker'
  const delegationEnabled = agent.delegationEnabled ?? false
  const delegationMode = agent.delegationTargetMode || 'all'
  const delegationTargets = agent.delegationTargetAgentIds || []
  const teamLabel = agent.orgChart?.teamLabel || ''
  const teamColor = agent.orgChart?.teamColor || ''
  const [teamInput, setTeamInput] = useState(teamLabel)
  const [showNewTeamInput, setShowNewTeamInput] = useState(false)

  const otherAgents = Object.values(allAgents).filter((a) => a.id !== agent.id && !a.trashedAt)

  const patchAgent = useCallback((patch: Partial<Agent>) => {
    onPatch([{ id: agent.id, patch }])
  }, [agent.id, onPatch])

  return (
    <div className="absolute top-0 right-0 z-30 w-[260px] h-full bg-raised/95 backdrop-blur-sm border-l border-line-subtle shadow-xl shadow-black/30 flex flex-col overflow-hidden" onPointerDown={(e) => e.stopPropagation()}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-line-subtle">
        <AgentAvatar
          seed={agent.avatarSeed || null}
          avatarUrl={agent.avatarUrl}
          name={agent.name}
          size={32}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-600 text-text truncate">{agent.name}</div>
          {agent.model && <div className="text-[10px] text-text-3 truncate">{agent.model}</div>}
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded-xs flex items-center justify-center text-text-3 hover:text-text hover:bg-layer-2 transition-colors cursor-pointer bg-transparent border-none"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Error banner */}
      {lastError && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 flex items-start gap-2">
          <span className="text-red-400 text-[10px] mt-0.5 shrink-0">⚠</span>
          <div className="text-[10px] text-red-300 line-clamp-3">{lastError}</div>
        </div>
      )}

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-4 flex flex-col gap-4" onWheel={(e) => e.stopPropagation()}>
        {/* Role toggle */}
        {!WORKER_ONLY_PROVIDER_IDS.has(agent.provider) && (
        <Section label="Role">
          <div className="flex gap-1">
            {(['worker', 'coordinator'] as const).map((r) => (
              <button
                key={r}
                onClick={() => patchAgent({ role: r })}
                className={`flex-1 text-[11px] font-500 py-1.5 rounded-xs border transition-colors cursor-pointer ${
                  role === r
                    ? 'border-accent-bright/30 text-accent-bright bg-accent-bright/10'
                    : 'border-line-subtle text-text-3 bg-transparent hover:bg-layer-2'
                }`}
              >
                {r === 'coordinator' ? 'Coordinator' : 'Worker'}
              </button>
            ))}
          </div>
        </Section>
        )}

        {/* Delegation */}
        {role === 'coordinator' && (
          <>
            <Section label="Delegation">
              <div className="flex gap-1">
                <button
                  onClick={() => patchAgent({ delegationEnabled: true })}
                  className={`flex-1 text-[11px] font-500 py-1.5 rounded-xs border transition-colors cursor-pointer ${
                    delegationEnabled
                      ? 'border-accent-bright/30 text-accent-bright bg-accent-bright/10'
                      : 'border-line-subtle text-text-3 bg-transparent hover:bg-layer-2'
                  }`}
                >
                  Enabled
                </button>
                <button
                  onClick={() => patchAgent({ delegationEnabled: false })}
                  className={`flex-1 text-[11px] font-500 py-1.5 rounded-xs border transition-colors cursor-pointer ${
                    !delegationEnabled
                      ? 'border-accent-bright/30 text-accent-bright bg-accent-bright/10'
                      : 'border-line-subtle text-text-3 bg-transparent hover:bg-layer-2'
                  }`}
                >
                  Disabled
                </button>
              </div>
            </Section>

            {delegationEnabled && (
              <>
                <Section label="Delegate To">
                  <div className="flex gap-1 mb-2">
                    {(['all', 'selected'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => patchAgent({ delegationTargetMode: m })}
                        className={`flex-1 text-[11px] font-500 py-1.5 rounded-xs border transition-colors cursor-pointer ${
                          delegationMode === m
                            ? 'border-accent-bright/30 text-accent-bright bg-accent-bright/10'
                            : 'border-line-subtle text-text-3 bg-transparent hover:bg-layer-2'
                        }`}
                      >
                        {m === 'all' ? 'All' : 'Selected'}
                      </button>
                    ))}
                  </div>
                  {delegationMode === 'selected' && (
                    <AgentPickerList
                      agents={otherAgents}
                      selected={delegationTargets}
                      onSelect={(id) => {
                        const next = delegationTargets.includes(id)
                          ? delegationTargets.filter((t) => t !== id)
                          : [...delegationTargets, id]
                        patchAgent({ delegationTargetAgentIds: next })
                      }}
                      maxHeight={140}
                    />
                  )}
                </Section>
              </>
            )}
          </>
        )}

        {/* Orchestrator */}
        {isOrchestratorProviderEligible(agent.provider) && (
          <Section label="Orchestrator">
            <div className="flex gap-1">
              <button
                onClick={() => patchAgent({ orchestratorEnabled: true })}
                className={`flex-1 text-[11px] font-500 py-1.5 rounded-xs border transition-colors cursor-pointer ${
                  agent.orchestratorEnabled
                    ? 'border-amber-400/30 text-amber-400 bg-amber-400/10'
                    : 'border-line-subtle text-text-3 bg-transparent hover:bg-layer-2'
                }`}
              >
                On
              </button>
              <button
                onClick={() => patchAgent({ orchestratorEnabled: false })}
                className={`flex-1 text-[11px] font-500 py-1.5 rounded-xs border transition-colors cursor-pointer ${
                  !agent.orchestratorEnabled
                    ? 'border-amber-400/30 text-amber-400 bg-amber-400/10'
                    : 'border-line-subtle text-text-3 bg-transparent hover:bg-layer-2'
                }`}
              >
                Off
              </button>
            </div>
            {agent.orchestratorEnabled && agent.orchestratorGovernance && (
              <span className="text-[9px] mt-1 text-amber-400/80 block">
                {agent.orchestratorGovernance}
              </span>
            )}
          </Section>
        )}

        {/* Team */}
        <Section label="Team">
          <div className="flex flex-col gap-1.5">
            {/* Existing teams as selectable chips */}
            {teamNames.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {teamNames.map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      const next = teamLabel === t ? null : t
                      const color = next ? resolveTeamColor(allAgents, next) : null
                      onPatch([{
                        id: agent.id,
                        patch: { orgChart: { ...(agent.orgChart || {}), teamLabel: next, ...(color ? { teamColor: color } : { teamColor: null }) } },
                      }])
                      setTeamInput(next || '')
                    }}
                    className={`text-[10px] font-500 px-2 py-1 rounded-xs border cursor-pointer transition-colors ${
                      teamLabel === t
                        ? 'border-accent-bright/30 text-accent-bright bg-accent-bright/10'
                        : 'border-line-subtle text-text-3 bg-transparent hover:bg-layer-2'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            {/* New team input */}
            {showNewTeamInput ? (
              <input
                autoFocus
                value={teamInput}
                onChange={(e) => setTeamInput(e.target.value)}
                onBlur={() => {
                  const v = teamInput.trim()
                  if (v && v !== teamLabel) {
                    onPatch([{
                      id: agent.id,
                      patch: { orgChart: { ...(agent.orgChart || {}), teamLabel: v } },
                    }])
                  }
                  setShowNewTeamInput(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setShowNewTeamInput(false)
                }}
                placeholder="New team name..."
                className="w-full px-2 py-1.5 text-[11px] bg-layer-2 border border-line-default rounded-xs text-text outline-none focus:border-accent-bright/30 placeholder:text-text-3"
              />
            ) : (
              <button
                onClick={() => { setTeamInput(''); setShowNewTeamInput(true) }}
                className="w-full text-[10px] font-500 py-1.5 rounded-xs border border-dashed border-line-default text-text-3 bg-transparent hover:bg-layer-2 hover:text-text-2 transition-colors cursor-pointer flex items-center justify-center gap-1"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New Team
              </button>
            )}
          </div>
        </Section>

        {/* Team color — updates all agents in the team */}
        {teamLabel && (
          <Section label="Team Color">
            <div className="flex flex-wrap gap-1.5">
              {TEAM_COLORS.map((c) => (
                <button
                  key={c}
                  className={`w-5 h-5 rounded-full border cursor-pointer hover:scale-110 transition-transform ${
                    teamColor === c ? 'border-white/40 ring-1 ring-white/30' : 'border-line-default'
                  }`}
                  style={{ background: c }}
                  onClick={() => {
                    // Patch all agents in this team, not just the selected one
                    const patches = Object.values(allAgents)
                      .filter((a) => a.orgChart?.teamLabel === teamLabel)
                      .map((a) => ({
                        id: a.id,
                        patch: { orgChart: { ...(a.orgChart || {}), teamColor: c } } as Partial<Agent>,
                      }))
                    onPatch(patches)
                  }}
                />
              ))}
            </div>
          </Section>
        )}
      </div>

      {/* Quick actions */}
      <div className="px-4 py-3 border-t border-line-subtle flex flex-col gap-1.5">
        <button
          onClick={() => onNavigate('agents', agent.id)}
          className="w-full text-[11px] font-500 py-2 rounded-xs border border-accent-bright/20 text-accent-bright bg-accent-bright/5 hover:bg-accent-bright/10 transition-colors cursor-pointer"
        >
          Open in Agents
        </button>
        <button
          onClick={onRemove}
          className="w-full text-[11px] font-500 py-2 rounded-xs border border-red-400/20 text-red-400/80 bg-transparent hover:bg-red-500/10 transition-colors cursor-pointer"
        >
          Remove from Chart
        </button>
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-600 uppercase tracking-wider text-text-3 mb-1.5">{label}</div>
      {children}
    </div>
  )
}
