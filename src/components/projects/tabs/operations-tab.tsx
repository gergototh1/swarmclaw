'use client'

import { useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { updateAgent } from '@/lib/agents'
import { useNavigate } from '@/lib/app/navigation'
import { toast } from 'sonner'
import { relativeDate, formatHeartbeatInterval } from '../project-utils'
import { AssignAgentPicker } from '../assign-agent-picker'
import type { Agent, Project, Schedule } from '@/types'

interface OperationsTabProps {
  project: Project
}

export function OperationsTab({ project }: OperationsTabProps) {
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const schedules = useAppStore((s) => s.schedules) as Record<string, Schedule>
  const secrets = useAppStore((s) => s.secrets)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const navigateTo = useNavigate()
  const setEditingScheduleId = useAppStore((s) => s.setEditingScheduleId)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const setEditingSecretId = useAppStore((s) => s.setEditingSecretId)
  const setSecretSheetOpen = useAppStore((s) => s.setSecretSheetOpen)

  const [assignPickerOpen, setAssignPickerOpen] = useState(false)

  const projectAgents = useMemo(
    () => Object.values(agents).filter((a) => a.projectId === activeProjectFilter && !a.trashedAt),
    [agents, activeProjectFilter],
  )

  const projectSchedules = useMemo(
    () => Object.values(schedules).filter((s) => s.projectId === activeProjectFilter),
    [schedules, activeProjectFilter],
  )

  const projectSecrets = useMemo(
    () => Object.values(secrets).filter((s) => s.projectId === activeProjectFilter),
    [secrets, activeProjectFilter],
  )

  const priorities = Array.isArray(project.priorities) ? project.priorities : []
  const openObjectives = Array.isArray(project.openObjectives) ? project.openObjectives : []
  const capabilityHints = Array.isArray(project.capabilityHints) ? project.capabilityHints : []
  const successMetrics = Array.isArray(project.successMetrics) ? project.successMetrics : []
  const credentialRequirements = Array.isArray(project.credentialRequirements) ? project.credentialRequirements : []

  const handleUnassignAgent = async (agentId: string) => {
    await updateAgent(agentId, { projectId: undefined })
    await loadAgents()
    toast.success('Agent removed from project')
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-6 space-y-8">
      {/* Section 1: Agents */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[12px] font-700 tracking-[0.03em] text-text-3">
            Agents ({projectAgents.length})
          </h3>
          <div className="relative">
            <button
              onClick={() => setAssignPickerOpen(!assignPickerOpen)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer border-none"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Assign Agent
            </button>
            {assignPickerOpen && (
              <AssignAgentPicker
                projectId={project.id}
                onClose={() => setAssignPickerOpen(false)}
              />
            )}
          </div>
        </div>
        {projectAgents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-default px-5 py-6 text-center">
            <p className="text-[12px] text-text-3">No agents assigned yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {projectAgents.map((agent) => (
              <div
                key={agent.id}
                className="group/agent flex items-center gap-3 px-4 py-3 rounded-lg border border-line-subtle bg-layer-1 hover:bg-layer-2 hover:border-line-default transition-all"
              >
                <button
                  onClick={() => navigateTo('agents', agent.id)}
                  className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer bg-transparent border-none text-left p-0"
                  style={{ fontFamily: 'inherit' }}
                >
                  <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-600 text-text truncate">{agent.name}</div>
                    <div className="text-[11px] text-text-3 truncate">{agent.model || agent.provider}</div>
                  </div>
                </button>
                {agent.lastUsedAt && (
                  <span className="text-[10px] text-text-3 shrink-0">{relativeDate(agent.lastUsedAt)}</span>
                )}
                <button
                  onClick={() => handleUnassignAgent(agent.id)}
                  title="Remove from project"
                  className="opacity-0 group-hover/agent:opacity-100 p-1 rounded-xs hover:bg-red-500/10 text-text-3 hover:text-red-400 transition-all cursor-pointer bg-transparent border-none shrink-0"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 2: Operating Context */}
      {(priorities.length > 0 || openObjectives.length > 0 || capabilityHints.length > 0 || successMetrics.length > 0) && (
        <div>
          <h3 className="text-[12px] font-700 tracking-[0.03em] text-text-3 mb-3">Operating Context</h3>
          <div className="space-y-4">
            {priorities.length > 0 && (
              <div>
                <div className="text-[11px] font-600 text-text-3 mb-1.5">Pilot Priorities</div>
                <div className="flex flex-wrap gap-1.5">
                  {priorities.map((p) => (
                    <span key={p} className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-600 text-accent-bright">{p}</span>
                  ))}
                </div>
              </div>
            )}
            {openObjectives.length > 0 && (
              <div>
                <div className="text-[11px] font-600 text-text-3 mb-1.5">Open Objectives</div>
                <div className="space-y-1.5">
                  {openObjectives.map((o) => (
                    <div key={o} className="flex items-start gap-2 text-[12px] text-text-2">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                      <span>{o}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {capabilityHints.length > 0 && (
              <div>
                <div className="text-[11px] font-600 text-text-3 mb-1.5">Capability Hints</div>
                <div className="flex flex-wrap gap-1.5">
                  {capabilityHints.map((h) => (
                    <span key={h} className="rounded-full bg-layer-2 px-2.5 py-1 text-[11px] font-600 text-text-2">{h}</span>
                  ))}
                </div>
              </div>
            )}
            {successMetrics.length > 0 && (
              <div>
                <div className="text-[11px] font-600 text-text-3 mb-1.5">Success Metrics</div>
                <div className="space-y-1.5">
                  {successMetrics.map((m) => (
                    <div key={m} className="flex items-start gap-2 text-[12px] text-text-2">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                      <span>{m}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Section 3: Credentials & Secrets */}
      <div>
        <h3 className="text-[12px] font-700 tracking-[0.03em] text-text-3 mb-3">Credentials & Secrets</h3>
        <div className="space-y-3">
          {credentialRequirements.length > 0 && (
            <div>
              <div className="text-[11px] font-600 text-text-3 mb-1">Credential Requirements</div>
              <div className="space-y-1.5">
                {credentialRequirements.map((item) => (
                  <div key={item} className="flex items-start gap-2 text-[12px] text-text-2">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="text-[11px] text-text-3">{projectSecrets.length} linked secret{projectSecrets.length === 1 ? '' : 's'}</p>
          <button
            onClick={() => { setEditingSecretId(null); setSecretSheetOpen(true) }}
            className="px-3 py-2 rounded-sm bg-accent-soft text-[12px] font-600 text-accent-bright hover:bg-accent-bright/15 transition-all cursor-pointer border-none"
            style={{ fontFamily: 'inherit' }}
          >
            Add project secret
          </button>
        </div>
      </div>

      {/* Section 4: Schedules */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[12px] font-700 tracking-[0.03em] text-text-3">
            Schedules ({projectSchedules.length})
          </h3>
          <button
            onClick={() => { setEditingScheduleId(null); setScheduleSheetOpen(true) }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer border-none"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Schedule
          </button>
        </div>
        {projectSchedules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-default px-5 py-6 text-center">
            <p className="text-[12px] text-text-3">No schedules yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {projectSchedules.map((schedule) => {
              const agent = schedule.agentId ? agents[schedule.agentId] : null
              return (
                <button
                  key={schedule.id}
                  onClick={() => { setEditingScheduleId(schedule.id); setScheduleSheetOpen(true) }}
                  className="flex items-center gap-3 px-4 py-3 rounded-sm border border-line-subtle bg-layer-1 hover:bg-layer-2 hover:border-line-default transition-all cursor-pointer text-left w-full"
                  style={{ fontFamily: 'inherit' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400/60 shrink-0">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span className="text-[13px] text-text truncate flex-1">{schedule.name}</span>
                  <span className={`shrink-0 px-2 py-0.5 rounded-xs text-[10px] font-600 tracking-[0.03em] ${
                    schedule.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-layer-2 text-text-3'
                  }`}>
                    {schedule.status}
                  </span>
                  {agent && (
                    <span className="shrink-0 flex items-center gap-1.5 text-[11px] text-text-3">
                      <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={16} />
                    </span>
                  )}
                  {schedule.nextRunAt && (
                    <span className="text-[10px] text-text-3 shrink-0">next: {relativeDate(schedule.nextRunAt)}</span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Heartbeat config */}
        {(project.heartbeatPrompt || project.heartbeatIntervalSec) && (
          <div className="mt-4 rounded-lg border border-line-subtle bg-surface px-4 py-3">
            <div className="text-[11px] font-700 tracking-[0.03em] text-sky-400">
              Heartbeat &middot; Every {formatHeartbeatInterval(project.heartbeatIntervalSec)}
            </div>
            <p className="mt-1 text-[12px] text-text-2 leading-relaxed">
              {project.heartbeatPrompt || 'No heartbeat prompt configured.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
