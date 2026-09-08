'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '@/lib/app/api-client'
import { useWs } from '@/hooks/use-ws'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { PageLoader } from '@/components/ui/page-loader'
import { safeStorageGetJson, safeStorageSet } from '@/lib/app/safe-storage'

interface LogEntry {
  time: string
  level: string
  tag: string
  message: string
  data?: string
}

const LEVEL_COLORS: Record<string, string> = {
  ERROR: 'text-red-400',
  WARN: 'text-amber-400',
  INFO: 'text-blue-400',
  DEBUG: 'text-text-3',
}

const LEVEL_BG: Record<string, string> = {
  ERROR: 'bg-red-500/10',
  WARN: 'bg-amber-500/10',
  INFO: 'bg-blue-500/10',
  DEBUG: 'bg-layer-1',
}

export function LogList() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState<string[]>([])
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [selected, setSelected] = useState<LogEntry | null>(null)
  const [creatingTask, setCreatingTask] = useState(false)
  const [taskAgentId, setTaskAgentId] = useState('')
  const [savedFilters, setSavedFilters] = useState<Array<{ name: string; levels: string[]; search: string }>>(
    () => safeStorageGetJson<Array<{ name: string; levels: string[]; search: string }>>('sc_log_filters', []),
  )
  const scrollRef = useRef<HTMLDivElement>(null)

  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const loadTasks = useAppStore((s) => s.loadTasks)

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ lines: '300' })
      if (levelFilter.length) params.set('level', levelFilter.join(','))
      if (search) params.set('search', search)
      const res = await api('GET', `/logs?${params}`) as { entries: LogEntry[]; total: number }
      setEntries(res.entries || [])
      setTotal(res.total || 0)
    } catch (err) {
      console.error('Failed to fetch logs:', err)
    } finally {
      setLoading(false)
    }
  }, [levelFilter, search])

  useEffect(() => {
    fetchLogs()
    loadAgents()
  }, [fetchLogs, loadAgents])

  useWs('logs', fetchLogs, autoRefresh ? 3000 : undefined)

  const clearLogs = async () => {
    try {
      await api('DELETE', '/logs')
      setEntries([])
      setTotal(0)
    } catch (err) {
      console.error('Failed to clear logs:', err)
    }
  }

  const toggleLevel = (level: string) => {
    setLevelFilter((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]
    )
  }

  const formatTime = (iso: string) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch {
      return iso.slice(11, 19)
    }
  }

  const formatFullTime = (iso: string) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' })
    } catch {
      return iso
    }
  }

  const handleCreateTask = async () => {
    if (!selected) return
    setCreatingTask(true)
    try {
      const title = `[${selected.level}] ${selected.tag}: ${selected.message}`.slice(0, 120)
      const description = [
        `**Log Level:** ${selected.level}`,
        `**Source:** ${selected.tag}`,
        `**Time:** ${selected.time}`,
        `**Message:** ${selected.message}`,
        selected.data ? `\n**Data:**\n\`\`\`\n${selected.data}\n\`\`\`` : '',
      ].filter(Boolean).join('\n')

      await api('POST', '/tasks', {
        title,
        description,
        status: 'backlog',
        agentId: taskAgentId || undefined,
      })
      await loadTasks()
      setSelected(null)
    } catch (err) {
      console.error('Failed to create task:', err)
    } finally {
      setCreatingTask(false)
    }
  }

  if (loading) {
    return <PageLoader label="Loading logs..." />
  }

  const agentList = Object.values(agents)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Controls */}
      <div className="px-5 py-2 space-y-2 shrink-0">
        {/* Search */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search logs..."
          className="w-full px-3 py-2 rounded-md bg-layer-2 border border-line-subtle text-[12px] text-text placeholder:text-text-3 outline-none focus:border-accent/30"
        />
        {/* Saved filters */}
        {savedFilters.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {savedFilters.map((f, i) => (
              <button
                key={i}
                onClick={() => { setLevelFilter(f.levels); setSearch(f.search) }}
                className="group flex items-center gap-1 px-2 py-1 rounded-xs text-[10px] font-600 cursor-pointer transition-all border-none bg-accent-soft text-accent-bright hover:bg-accent-bright/15"
              >
                {f.name}
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    const next = savedFilters.filter((_, j) => j !== i)
                    safeStorageSet('sc_log_filters', JSON.stringify(next))
                    setSavedFilters(next)
                  }}
                  className="text-accent-bright/50 hover:text-red-400 ml-0.5"
                >
                  x
                </span>
              </button>
            ))}
          </div>
        )}
        {/* Level filters + controls */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {['ERROR', 'WARN', 'INFO', 'DEBUG'].map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              className={`px-2 py-1 rounded-xs text-[10px] font-700 uppercase tracking-[0.03em] cursor-pointer transition-all border-none ${
                levelFilter.length === 0 || levelFilter.includes(level)
                  ? `${LEVEL_BG[level]} ${LEVEL_COLORS[level]}`
                  : 'bg-layer-1 text-text-3/70'
              }`}
            >
              {level}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-2 py-1 rounded-xs text-[10px] font-600 cursor-pointer transition-all border-none ${
              autoRefresh ? 'bg-green-500/10 text-green-400' : 'bg-layer-2 text-text-3'
            }`}
            title={autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
          >
            {autoRefresh ? 'LIVE' : 'PAUSED'}
          </button>
          <button
            onClick={clearLogs}
            className="px-2 py-1 rounded-xs text-[10px] font-600 cursor-pointer transition-all border-none bg-layer-2 text-text-3 hover:text-red-400 hover:bg-red-500/10"
            title="Clear all logs"
          >
            CLEAR
          </button>
          <button
            onClick={() => {
              const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `swarmclaw-logs-${new Date().toISOString().slice(0, 10)}.json`
              a.click()
              URL.revokeObjectURL(url)
            }}
            className="px-2 py-1 rounded-xs text-[10px] font-600 cursor-pointer transition-all border-none bg-layer-2 text-text-3 hover:text-accent-bright hover:bg-accent-soft"
            title="Export logs as JSON"
          >
            EXPORT
          </button>
          <button
            onClick={() => {
              const name = prompt('Filter name:')
              if (!name?.trim()) return
              const filter = { name: name.trim(), levels: levelFilter, search }
              const existing = safeStorageGetJson<Array<{ name: string; levels: string[]; search: string }>>('sc_log_filters', [])
              existing.push(filter)
              safeStorageSet('sc_log_filters', JSON.stringify(existing))
              setSavedFilters(existing)
            }}
            className="px-2 py-1 rounded-xs text-[10px] font-600 cursor-pointer transition-all border-none bg-layer-2 text-text-3 hover:text-accent-bright hover:bg-accent-soft"
            title="Save current filter"
          >
            SAVE
          </button>
        </div>
      </div>

      {/* Total count */}
      <div className="px-5 py-1 text-[10px] text-text-3">
        {entries.length} of {total} entries
      </div>

      {/* Log entries */}
      <div ref={scrollRef} className="page-shell">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-text-3 text-[12px]">
            No log entries
          </div>
        ) : (
          entries.map((entry, i) => (
            <button
              key={i}
              onClick={() => { setSelected(entry); setTaskAgentId('') }}
              className={`w-full text-left px-2 py-1.5 rounded-xs hover:bg-layer-1 transition-colors cursor-pointer bg-transparent border-none block
                ${entry.level === 'ERROR' ? 'hover:bg-red-500/[0.04]' : ''}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-text-3 font-mono shrink-0 mt-[1px] w-[58px]">
                  {formatTime(entry.time)}
                </span>
                <span className={`text-[9px] font-700 tracking-[0.03em] shrink-0 mt-[2px] w-[36px] ${LEVEL_COLORS[entry.level] || 'text-text-3'}`}>
                  {entry.level}
                </span>
                <span className="text-[10px] font-600 text-accent/60 shrink-0 mt-[1px]">
                  {entry.tag}
                </span>
                <span className="text-[11px] text-text-2 truncate flex-1">
                  {entry.message}
                </span>
                {/* Arrow indicator */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0 mt-[2px]">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Log Detail Sheet */}
      <BottomSheet open={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-3">
                <span className={`text-[11px] font-700 tracking-[0.03em] px-2.5 py-1 rounded-xs ${LEVEL_BG[selected.level]} ${LEVEL_COLORS[selected.level]}`}>
                  {selected.level}
                </span>
                <span className="text-[12px] font-600 text-accent/80 font-mono">{selected.tag}</span>
              </div>
              <h2 className="font-display text-[22px] font-700 tracking-[-0.02em] mb-2 leading-snug">
                {selected.message}
              </h2>
              <p className="text-[12px] text-text-3 font-mono">{formatFullTime(selected.time)}</p>
            </div>

            {/* Data payload */}
            {selected.data && (
              <div className="mb-8">
                <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-3">Details</label>
                <pre className="text-[11px] text-text-3 font-mono whitespace-pre-wrap break-all bg-surface rounded-lg p-4 max-h-[300px] overflow-auto border border-line-subtle">
                  {selected.data}
                </pre>
              </div>
            )}

            {/* Create as Task */}
            <div className="pt-4 border-t border-line-subtle">
              <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-3">
                Create as Task
              </label>
              <p className="text-[12px] text-text-3 mb-3">
                Turn this log entry into a task and optionally assign it to an agent to investigate.
              </p>
              <div className="flex gap-2">
                <select
                  value={taskAgentId}
                  onChange={(e) => setTaskAgentId(e.target.value)}
                  className="flex-1 px-4 py-3 rounded-lg border border-line-subtle bg-surface text-text text-[14px] outline-none appearance-none cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  <option value="">Unassigned</option>
                  {agentList.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <button
                  onClick={handleCreateTask}
                  disabled={creatingTask}
                  className="px-5 py-3 rounded-md border-none bg-accent-bright text-accent-fg text-[14px] font-600
                    cursor-pointer active:scale-[0.97] disabled:opacity-40 transition-all
                    hover:brightness-110 shrink-0"
                  style={{ fontFamily: 'inherit' }}
                >
                  {creatingTask ? 'Creating...' : 'Create Task'}
                </button>
              </div>
            </div>
          </>
        )}
      </BottomSheet>
    </div>
  )
}
