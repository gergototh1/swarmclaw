'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useNavigate } from '@/lib/app/navigation'
import { tightestCap } from '@/lib/home/mission-budget'
import { selectUpcomingSchedules } from '@/lib/home/upcoming-schedules'
import { SectionHeader } from '@/components/ui/section-header'
import type { Mission } from '@/types'

const POLL_MS = 20_000
const NOW_TICK_MS = 60_000

const BAR_TONE: Record<'normal' | 'warn' | 'danger', string> = {
  normal: 'bg-accent-bright',
  warn: 'bg-amber-400',
  danger: 'bg-red-400',
}

export function TierLive() {
  const navigateTo = useNavigate()
  const agents = useAppStore((s) => s.agents)
  const tasks = useAppStore((s) => s.tasks)
  const schedules = useAppStore((s) => s.schedules)
  const sessions = useAppStore((s) => s.sessions)
  const streamingSessionId = useChatStore((s) => s.streamingSessionId)

  const [missions, setMissions] = useState<Mission[]>([])
  const fingerprintRef = useRef<string>('')
  // `Date.now()` can't be called inside `useMemo` (react-hooks/purity treats
  // it as an impure read), so "now" lives in state instead and ticks once a
  // minute — plenty for a schedule list, since nothing here needs second
  // precision.
  const [now, setNow] = useState(() => Date.now())

  /*
   * Missions have API routes but no store slice, and one section is not reason
   * enough to add one. The state is component-local, so a poll re-render stays
   * inside this subtree; the fingerprint guard just keeps it from re-rendering
   * on every tick when nothing moved.
   */
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await api<Mission[]>('GET', '/missions')
        if (cancelled) return
        const running = next.filter((m) => m.status === 'running')
        const fingerprint = JSON.stringify(running)
        if (fingerprint === fingerprintRef.current) return
        fingerprintRef.current = fingerprint
        setMissions(running)
      } catch {
        /* a failed poll leaves the last good list on screen */
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const runningTasks = useMemo(
    () => Object.values(tasks).filter((t) => t.status === 'running' || t.status === 'queued'),
    [tasks],
  )

  const upcoming = useMemo(() => selectUpcomingSchedules(schedules, now), [schedules, now])

  const streamingSession = streamingSessionId ? sessions[streamingSessionId] : null
  const nothingRunning = missions.length === 0 && runningTasks.length === 0 && !streamingSession

  if (nothingRunning && upcoming.length === 0) {
    return <p className="mb-6 px-1 text-[12px] text-text-3">Nothing running.</p>
  }

  return (
    <>
      {!nothingRunning && (
        <section className="mb-6 rounded-lg border border-line-subtle bg-surface p-5 sm:p-6">
          <SectionHeader label="Running now" />
          <div className="flex flex-col gap-1">
            {missions.map((mission) => {
              const cap = tightestCap(mission)
              const milestone = mission.milestones[mission.milestones.length - 1]
              return (
                <button
                  key={mission.id}
                  onClick={() => navigateTo('missions')}
                  className="rounded-md px-3 py-2.5 text-left bg-transparent border-none hover:bg-layer-1
                    transition-colors cursor-pointer w-full"
                  style={{ fontFamily: 'inherit' }}
                >
                  <span className="block truncate text-[13px] font-600 text-text">{mission.title}</span>
                  {milestone && (
                    <span className="block truncate text-[11px] text-text-3">{milestone.summary}</span>
                  )}
                  {cap && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-layer-2">
                        <div
                          className={`h-full ${BAR_TONE[cap.tone]}`}
                          style={{ width: `${Math.round(cap.fraction * 100)}%` }}
                        />
                      </div>
                      <span className="shrink-0 text-[10px] text-text-3">{cap.label}</span>
                    </div>
                  )}
                </button>
              )
            })}

            {runningTasks.map((task) => {
              const agent = task.agentId ? agents[task.agentId] : null
              return (
                <div key={task.id} className="flex items-center gap-2.5 rounded-md px-3 py-2.5">
                  <div className={`h-2 w-2 shrink-0 rounded-full ${task.status === 'running' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-600 text-text">{task.title}</span>
                    <span className="text-[11px] text-text-3">{agent?.name || 'Unassigned'} · {task.status}</span>
                  </div>
                </div>
              )
            })}

            {streamingSession && (
              <button
                onClick={() => navigateTo('conversations', streamingSession.id)}
                className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left bg-transparent border-none
                  hover:bg-layer-1 transition-colors cursor-pointer w-full"
                style={{ fontFamily: 'inherit' }}
              >
                <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
                <span className="truncate text-[13px] font-600 text-text">
                  {streamingSession.name || 'Untitled chat'} · replying
                </span>
              </button>
            )}
          </div>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="mb-6 rounded-lg border border-line-subtle bg-surface p-5 sm:p-6">
          <SectionHeader
            label="Next 24 hours"
            action={{ label: 'View all →', onClick: () => navigateTo('schedules') }}
          />
          <div className="flex flex-col gap-1">
            {upcoming.map((sched) => {
              const agent = sched.agentId ? agents[sched.agentId] : null
              return (
                <div key={sched.id} className="flex items-center gap-2.5 rounded-md px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-600 text-text">{sched.name}</span>
                    <span className="text-[11px] text-text-3">{agent?.name || 'No agent'}</span>
                  </div>
                  <span className="shrink-0 text-[11px] text-text-3">
                    {new Date(sched.nextRunAt as number).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </>
  )
}
