'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import type { Connector } from '@/types'
import { getConnectorReadiness, hasConnectorCredentials } from '@/lib/connectors/connector-readiness'
import {
  ConnectorPlatformIcon,
  ConnectorPlatformBadge,
  getConnectorPlatformLabel,
  resolveConnectorPlatformMeta,
} from '@/components/shared/connector-platform-icon'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { PageLoader } from '@/components/ui/page-loader'
import { StatusDot } from '@/components/ui/status-dot'
import { useConnectorsQuery, useConnectorActionMutation } from '@/features/connectors/queries'
import { useAgentsQuery } from '@/features/agents/queries'
import { useChatroomsQuery } from '@/features/chatrooms/queries'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const d = new Date(ts)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

type ConnectorGroup = 'needs-setup' | 'attention' | 'healthy'

function getConnectorGroup(connector: Connector): ConnectorGroup {
  const readiness = getConnectorReadiness(connector)
  if (readiness.state === 'needs_setup') return 'needs-setup'
  return readiness.state
}

export function ConnectorList({ inSidebar }: { inSidebar?: boolean }) {
  const setConnectorSheetOpen = useAppStore((s) => s.setConnectorSheetOpen)
  const setEditingConnectorId = useAppStore((s) => s.setEditingConnectorId)
  const connectorsQuery = useConnectorsQuery()
  const agentsQuery = useAgentsQuery()
  const chatroomsQuery = useChatroomsQuery()
  const connectorActionMutation = useConnectorActionMutation()
  const connectors = useMemo(() => connectorsQuery.data ?? {}, [connectorsQuery.data])
  const agents = agentsQuery.data ?? {}
  const chatrooms = chatroomsQuery.data ?? {}
  const [toggling, setToggling] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [groupFilter, setGroupFilter] = useState<'all' | ConnectorGroup>('all')
  const openConnector = useCallback((id: string | null) => {
    setEditingConnectorId(id)
    setConnectorSheetOpen(true)
  }, [setEditingConnectorId, setConnectorSheetOpen])

  // Auto-clear error after 5s
  useEffect(() => {
    if (error) { const t = setTimeout(() => setError(null), 5000); return () => clearTimeout(t) }
  }, [error])

  const handleToggle = async (e: React.MouseEvent, c: Connector) => {
    e.stopPropagation()
    const action = c.status === 'running' ? 'stop' : 'start'
    setToggling(c.id)
    setError(null)
    try {
      await connectorActionMutation.mutateAsync({ id: c.id, action })
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message ? err.message : `Failed to ${action}`
      setError(msg)
    } finally {
      setToggling(null)
    }
  }

  const handleReconnect = async (e: React.MouseEvent, c: Connector) => {
    e.stopPropagation()
    setReconnecting(c.id)
    setError(null)
    try {
      try {
        await connectorActionMutation.mutateAsync({ id: c.id, action: 'stop' })
      } catch {
        // Connector may already be stopped.
      }
      await connectorActionMutation.mutateAsync({ id: c.id, action: 'start' })
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message ? err.message : 'Failed to reconnect'
      setError(msg)
    } finally {
      setReconnecting(null)
    }
  }

  const list = useMemo(() => (
    (Object.values(connectors) as Connector[]).sort((a, b) => {
      const groupOrder: Record<ConnectorGroup, number> = {
        'needs-setup': 0,
        attention: 1,
        healthy: 2,
      }
      const diff = groupOrder[getConnectorGroup(a)] - groupOrder[getConnectorGroup(b)]
      if (diff !== 0) return diff
      return a.name.localeCompare(b.name)
    })
  ), [connectors])

  const groupedConnectors = useMemo(() => {
    const groups: Record<ConnectorGroup, Connector[]> = {
      'needs-setup': [],
      attention: [],
      healthy: [],
    }
    for (const connector of list) {
      groups[getConnectorGroup(connector)].push(connector)
    }
    return groups
  }, [list])

  const groupMeta: Record<ConnectorGroup, { label: string; description: string; tone: string }> = {
    'needs-setup': {
      label: 'Needs Setup',
      description: 'Missing credentials, QR scan, or routing target',
      tone: 'text-amber-400',
    },
    attention: {
      label: 'Attention',
      description: 'Configured, but stopped or reporting errors',
      tone: 'text-red-400',
    },
    healthy: {
      label: 'Healthy',
      description: 'Connected and routed correctly',
      tone: 'text-emerald-400',
    },
  }

  if (connectorsQuery.isPending || agentsQuery.isPending || chatroomsQuery.isPending) {
    return <PageLoader label="Loading connectors..." />
  }

  if (!list.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        <p className="text-[13px] text-text-3">No connectors configured yet.</p>
        <button
          onClick={() => openConnector(null)}
          className="mt-3 text-[13px] text-accent-bright hover:underline cursor-pointer bg-transparent border-none"
        >
          + Add Connector
        </button>
      </div>
    )
  }

  // Sidebar: compact list layout
  if (inSidebar) {
    return (
      <div className="flex-1 overflow-y-auto pb-20">
        {error && (
          <div className="mx-4 mt-2 mb-1 px-3 py-2 rounded-sm bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] leading-snug">
            {error}
          </div>
        )}
        {list.map((c, idx) => {
          const agent = c.agentId ? agents[c.agentId] : null
          const chatroom = c.chatroomId ? chatrooms[c.chatroomId] : null
          const isRunning = c.status === 'running'
          const meta = resolveConnectorPlatformMeta(c.platform)
          const group = getConnectorGroup(c)
          return (
            <button
              key={c.id}
              onClick={() => openConnector(c.id)}
              className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-layer-1 transition-colors cursor-pointer bg-transparent border-none text-left"
              style={{
                animation: 'fade-up 0.4s var(--ease-spring) both',
                animationDelay: `${idx * 0.03}s`
              }}
            >
              <ConnectorPlatformIcon platform={c.platform} size={16} />
              <div className="flex-1 min-w-0">
                <span className="text-[13px] font-600 text-text truncate block">{c.name}</span>
                <span className="text-[11px] text-text-3 truncate block">
                  {chatroom ? chatroom.name : agent?.name || meta?.label}
                </span>
              </div>
              <StatusDot
                status={group === 'healthy' ? 'online' : group === 'attention' ? 'offline' : 'warning'}
                pulse={isRunning}
              />
            </button>
          )
        })}
      </div>
    )
  }

  // Main view: card grid
  return (
    <div className="flex-1 overflow-y-auto pb-20 px-5 pt-2">
      {error && (
        <div className="mb-3 px-3 py-2 rounded-sm bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] leading-snug">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {(Object.entries(groupMeta) as Array<[ConnectorGroup, { label: string; description: string; tone: string }]>).map(([group, meta]) => (
          <button
            key={group}
            onClick={() => setGroupFilter((current) => (current === group ? 'all' : group))}
            className={`rounded-md border px-4 py-3 text-left transition-all cursor-pointer ${
              groupFilter === group
                ? 'border-line-default bg-layer-2'
                : 'border-line-subtle bg-layer-1 hover:bg-layer-2'
            }`}
            style={{ fontFamily: 'inherit' }}
          >
            <div className={`text-[11px] font-700 tracking-[0.03em] ${meta.tone}`}>{meta.label}</div>
            <div className={`mt-2 text-[24px] font-display font-700 tracking-[-0.03em] ${meta.tone}`}>{groupedConnectors[group].length}</div>
            <p className="text-[11px] text-text-3 mt-1 leading-relaxed">{meta.description}</p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {(['all', 'needs-setup', 'attention', 'healthy'] as const).map((group) => (
          <button
            key={group}
            onClick={() => setGroupFilter(group)}
            className={`px-3 py-1.5 rounded-sm text-[11px] font-600 transition-all cursor-pointer border-none ${
              groupFilter === group
                ? 'bg-accent-soft text-accent-bright'
                : 'bg-layer-2 text-text-3 hover:bg-layer-3 hover:text-text-2'
            }`}
            style={{ fontFamily: 'inherit' }}
          >
            {group === 'all' ? 'All connectors' : groupMeta[group].label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-6">
        {(Object.entries(groupMeta) as Array<[ConnectorGroup, { label: string; description: string; tone: string }]>)
          .filter(([group]) => groupFilter === 'all' || groupFilter === group)
          .map(([group, meta]) => {
            const connectorsForGroup = groupedConnectors[group]
            if (connectorsForGroup.length === 0) return null
            return (
              <section key={group}>
                <div className="flex items-end justify-between gap-3 mb-3">
                  <div>
                    <h2 className={`text-[12px] font-700 tracking-[0.03em] ${meta.tone}`}>{meta.label}</h2>
                    <p className="text-[12px] text-text-3 mt-1">{meta.description}</p>
                  </div>
                  <span className="text-[11px] text-text-3">{connectorsForGroup.length} connector{connectorsForGroup.length === 1 ? '' : 's'}</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {connectorsForGroup.map((c, idx) => {
                    const platformLabel = getConnectorPlatformLabel(c.platform)
                    const agent = c.agentId ? agents[c.agentId] : null
                    const chatroom = c.chatroomId ? chatrooms[c.chatroomId] : null
                    const isRunning = c.status === 'running'
                    const isToggling = toggling === c.id
                    const hasCredentials = hasConnectorCredentials(c)
                    const lastMsg = c.presence?.lastMessageAt
                    const readiness = getConnectorReadiness(c)
                    const issues = readiness.checks
                      .filter((check) => check.status !== 'ready')
                      .map((check) => ({
                        label: check.label,
                        detail: check.detail,
                        tone: check.status === 'error' ? 'text-red-400 bg-red-500/10' : 'text-amber-300 bg-amber-500/10',
                      }))

                    return (
                      <div
                        key={c.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openConnector(c.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openConnector(c.id)
                          }
                        }}
                        className={`group relative flex flex-col rounded-md border p-4 cursor-pointer transition-all hover:border-line-default hover:bg-layer-1 hover:scale-[1.01] text-left w-full ${
                          group === 'healthy'
                            ? 'border-emerald-500/15 bg-emerald-500/[0.03]'
                            : group === 'attention'
                              ? 'border-red-500/15 bg-red-500/[0.03]'
                              : 'border-amber-500/15 bg-amber-500/[0.03]'
                        }`}
                        style={{
                          fontFamily: 'inherit',
                          animation: 'spring-in 0.5s var(--ease-spring) both',
                          animationDelay: `${idx * 0.05}s`
                        }}
                      >
                        <div className="flex items-start gap-3 mb-3">
                          <ConnectorPlatformBadge platform={c.platform} size={40} iconSize={20} roundedClassName="rounded-sm" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[14px] font-600 text-text truncate">{c.name}</span>
                              <StatusDot
                                status={group === 'healthy' ? 'online' : group === 'attention' ? 'offline' : 'warning'}
                                pulse={isRunning}
                                className={c.status === 'error' && !isRunning ? 'animate-[ai-shake_0.5s]' : undefined}
                              />
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <span className={`px-1.5 py-0.5 rounded-xs text-[10px] font-700 tracking-[0.03em] ${meta.tone} bg-layer-2`}>
                                {meta.label}
                              </span>
                              <span className="text-[11px] text-text-3">
                                {isRunning ? 'Connected' : c.status === 'error' ? 'Error' : c.status === 'starting' ? 'Starting' : 'Stopped'}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2.5 mb-3 px-0.5">
                          {chatroom ? (
                            <>
                              <div className="w-6 h-6 rounded-full bg-layer-2 flex items-center justify-center shrink-0">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3">
                                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                </svg>
                              </div>
                              <div className="flex-1 min-w-0">
                                <span className="text-[12px] font-600 text-text-2 block truncate">{chatroom.name}</span>
                                <span className="text-[10px] text-text-3 block">
                                  Room · {chatroom.agentIds.length} agent{chatroom.agentIds.length !== 1 ? 's' : ''}
                                </span>
                              </div>
                            </>
                          ) : agent ? (
                            <>
                              <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={24} />
                              <div className="flex-1 min-w-0">
                                <span className="text-[12px] font-600 text-text-2 block truncate">{agent.name}</span>
                                <span className="text-[10px] text-text-3 block">Agent route</span>
                              </div>
                            </>
                          ) : (
                            <span className="text-[11px] text-amber-300">No routing target yet</span>
                          )}
                        </div>

                        {issues.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5 mb-3">
                            {issues.map((issue) => (
                              <span key={issue.label} title={issue.detail} className={`px-2 py-1 rounded-xs text-[10px] font-700 ${issue.tone}`}>
                                {issue.label}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="text-[11px] text-text-3 mb-3">
                            {platformLabel} routed to {chatroom ? 'chatroom' : agent ? 'agent' : 'connector'}.
                          </div>
                        )}

                        <div className="mb-3 rounded-sm border border-line-subtle bg-layer-1 px-3 py-2">
                          <div className="text-[10px] font-700 tracking-[0.03em] text-text-3">Readiness</div>
                          <div className="mt-1 text-[11px] text-text-2">{readiness.summary}</div>
                          <div className="mt-2 flex flex-col gap-1">
                            {readiness.checks.slice(0, 3).map((check) => (
                              <div key={check.id} className="flex items-start justify-between gap-2 text-[10px]">
                                <span className="text-text-3">{check.label}</span>
                                <span className={`max-w-[150px] break-words text-right ${check.status === 'ready' ? 'text-emerald-300' : check.status === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
                                  {check.detail}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 mt-auto pt-2 border-t border-line-subtle">
                          {c.lastError ? (
                            <span className="text-[10px] text-red-400 truncate flex-1">
                              {c.lastError.slice(0, 50)}{c.lastError.length > 50 ? '...' : ''}
                            </span>
                          ) : lastMsg ? (
                            <span className="text-[10px] text-text-3 flex-1">Last message {relativeTime(lastMsg)}</span>
                          ) : (
                            <span className="text-[10px] text-text-3 flex-1">No messages yet</span>
                          )}

                          <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <a
                              href={readiness.doctorHref}
                              target="_blank"
                              rel="noreferrer"
                              className="px-2 py-1 rounded-xs text-[10px] font-600 transition-all opacity-0 group-hover:opacity-100 bg-layer-2 text-text-3 hover:bg-layer-3 hover:text-text-2"
                            >
                              Doctor
                            </a>
                            {c.status === 'error' && hasCredentials && (
                              <button
                                onClick={(e) => handleReconnect(e, c)}
                                disabled={reconnecting === c.id}
                                title="Reconnect"
                                className="px-2 py-1 rounded-xs text-[10px] font-600 transition-all cursor-pointer border-none opacity-0 group-hover:opacity-100 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 disabled:opacity-50"
                              >
                                {reconnecting === c.id ? '...' : 'Reconnect'}
                              </button>
                            )}
                            {hasCredentials && (
                              <button
                                onClick={(e) => handleToggle(e, c)}
                                disabled={isToggling}
                                title={isRunning ? 'Stop' : 'Start'}
                                className={`w-7 h-7 rounded-xs flex items-center justify-center transition-all cursor-pointer border-none ${
                                  isToggling ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                                } ${isRunning
                                  ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                                  : 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                                } disabled:opacity-50`}
                              >
                                {isToggling ? (
                                  <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                                ) : isRunning ? (
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
                                ) : (
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 21,12 6,21" /></svg>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
      </div>
    </div>
  )
}
