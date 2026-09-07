'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/app/api-client'
import type { Agent, DelegationJobRecord } from '@/types'

interface Props {
  parentAgent: Agent
  childAgent: Agent
  x: number
  y: number
  onClose: () => void
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'text-text-3 bg-layer-2' },
  running: { label: 'Running', cls: 'text-amber-400 bg-amber-400/10' },
  completed: { label: 'Completed', cls: 'text-emerald-400 bg-emerald-400/10' },
  failed: { label: 'Failed', cls: 'text-red-400 bg-red-400/10' },
  cancelled: { label: 'Cancelled', cls: 'text-text-3 bg-layer-2' },
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

export function OrgChartEdgePopover({ parentAgent, childAgent, x, y, onClose }: Props) {
  const [jobs, setJobs] = useState<DelegationJobRecord[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const all = await api<DelegationJobRecord[]>('GET', '/delegation-jobs')
      // Filter to jobs for this specific parent→child edge
      const filtered = all.filter((j) => j.agentId === childAgent.id)
      setJobs(filtered)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [childAgent.id])

  useEffect(() => { refresh() }, [refresh])

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-edge-popover]')) onClose()
    }
    // Delay to avoid closing immediately from the click that opened it
    const timer = setTimeout(() => document.addEventListener('click', handler), 50)
    return () => { clearTimeout(timer); document.removeEventListener('click', handler) }
  }, [onClose])

  return (
    <div
      data-edge-popover
      className="absolute z-50 rounded-md border border-line-default bg-[#12121e] shadow-2xl shadow-black/60 overflow-hidden"
      style={{ left: x, top: y, width: 320, maxHeight: 360, transform: 'translate(-50%, -50%)' }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line-subtle bg-layer-1">
        <span className="text-[11px] font-600 text-text truncate">{parentAgent.name}</span>
        <svg width="12" height="8" viewBox="0 0 12 8" fill="none" className="text-text-3/50 shrink-0">
          <path d="M0 4h9M7 1l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[11px] font-600 text-text truncate">{childAgent.name}</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="w-5 h-5 rounded-xs flex items-center justify-center text-text-3 hover:text-text hover:bg-layer-3 cursor-pointer border-none transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M1 1l8 8M9 1l-8 8" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="overflow-y-auto px-3 py-2 space-y-2" style={{ maxHeight: 310 }}>
        {loading && (
          <div className="text-[11px] text-text-3/50 text-center py-6">Loading...</div>
        )}
        {!loading && jobs.length === 0 && (
          <div className="text-[11px] text-text-3/40 text-center py-6">
            No recent delegation activity between these agents
          </div>
        )}
        {jobs.map((job) => {
          const badge = STATUS_BADGE[job.status] || STATUS_BADGE.queued
          return (
            <div key={job.id} className="rounded-sm border border-line-subtle bg-layer-1 p-2.5">
              {/* Status + time */}
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`text-[8px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-xs leading-none ${badge.cls}`}>
                  {badge.label}
                </span>
                <span className="text-[9px] text-text-3/40 ml-auto">{timeAgo(job.updatedAt || job.createdAt)}</span>
              </div>

              {/* Task */}
              <div className="text-[11px] text-text-2 leading-snug mb-1">
                <span className="text-text-3/50 font-500">Task: </span>
                {job.task.length > 120 ? job.task.slice(0, 120) + '...' : job.task}
              </div>

              {/* Result preview */}
              {job.resultPreview && (
                <div className="text-[10px] text-emerald-400/70 leading-snug mt-1">
                  <span className="text-text-3/50 font-500">Result: </span>
                  {job.resultPreview.length > 120 ? job.resultPreview.slice(0, 120) + '...' : job.resultPreview}
                </div>
              )}

              {/* Error */}
              {job.error && (
                <div className="text-[10px] text-red-400/70 leading-snug mt-1">
                  <span className="text-text-3/50 font-500">Error: </span>
                  {job.error.length > 120 ? job.error.slice(0, 120) + '...' : job.error}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
