'use client'

import { useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import type { Agent, BoardTask, Project } from '@/types'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'work', label: 'Work' },
  { key: 'operations', label: 'Operations' },
  { key: 'activity', label: 'Activity' },
] as const

interface ProjectDetailHeaderProps {
  project: Project
  failedCount: number
  blockedCount: number
  credentialReqCount: number
}

export function ProjectDetailHeader({ project, failedCount, blockedCount, credentialReqCount }: ProjectDetailHeaderProps) {
  const setEditingProjectId = useAppStore((s) => s.setEditingProjectId)
  const setProjectSheetOpen = useAppStore((s) => s.setProjectSheetOpen)
  const activeTab = useAppStore((s) => s.projectDetailTab)
  const setActiveTab = useAppStore((s) => s.setProjectDetailTab)
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const tasks = useAppStore((s) => s.tasks) as Record<string, BoardTask>
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)

  const projectAgentCount = useMemo(
    () => Object.values(agents).filter((a) => a.projectId === activeProjectFilter && !a.trashedAt).length,
    [agents, activeProjectFilter],
  )

  const { totalTasks, completedTasks, progressPct } = useMemo(() => {
    const pt = Object.values(tasks).filter((t) => t.projectId === activeProjectFilter)
    const completed = pt.filter((t) => t.status === 'completed').length
    const total = pt.length
    return {
      totalTasks: total,
      completedTasks: completed,
      progressPct: total > 0 ? Math.round((completed / total) * 100) : 0,
    }
  }, [tasks, activeProjectFilter])

  const workBadge = failedCount + blockedCount
  const opsBadge = credentialReqCount

  return (
    <div className="shrink-0 border-b border-line-subtle">
      {/* Project identity */}
      <div className="px-8 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-sm flex items-center justify-center shrink-0 text-[14px] font-700 text-white/90"
            style={{ backgroundColor: project.color || '#6366F1' }}
          >
            {project.name.charAt(0).toUpperCase()}
          </div>
          <h1 className="font-display text-[22px] font-700 text-text tracking-[-0.02em] truncate flex-1">
            {project.name}
          </h1>
          <button
            onClick={() => { setEditingProjectId(project.id); setProjectSheetOpen(true) }}
            className="shrink-0 p-1.5 rounded-sm hover:bg-layer-2 transition-colors cursor-pointer bg-transparent border-none text-text-3/50 hover:text-text-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
        </div>
        {project.description && (
          <p className="text-[13px] text-text-3/60 mt-1.5 truncate">{project.description}</p>
        )}
        {/* Compact stat bar */}
        <div className="flex items-center gap-1.5 mt-2.5 text-[11px] text-text-3/50">
          <span>{projectAgentCount} agent{projectAgentCount !== 1 ? 's' : ''}</span>
          <span className="text-text-3/20">&middot;</span>
          <span>{totalTasks} task{totalTasks !== 1 ? 's' : ''}</span>
          <span className="text-text-3/20">&middot;</span>
          <span>{completedTasks} completed</span>
          <span className="text-text-3/20">&middot;</span>
          <span className={progressPct === 100 ? 'text-emerald-400' : ''}>{progressPct}%</span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="px-8 flex items-center gap-1">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key
          const badge = tab.key === 'work' ? workBadge : tab.key === 'operations' ? opsBadge : 0
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`relative px-3.5 py-2.5 text-[12px] font-600 transition-colors cursor-pointer bg-transparent border-none
                ${isActive ? 'text-text' : 'text-text-3/50 hover:text-text-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              <span className="flex items-center gap-1.5">
                {tab.label}
                {badge > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-red-500/15 text-red-400 text-[9px] font-700">
                    {badge}
                  </span>
                )}
              </span>
              {isActive && (
                <div className="absolute bottom-0 left-3.5 right-3.5 h-[2px] rounded-full" style={{ backgroundColor: project.color || '#6366F1' }} />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
