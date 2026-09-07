'use client'

import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { Agent } from '@/types'

interface Props {
  agent: Agent
  isRunning?: boolean
  isSelected?: boolean
  isDropTarget?: boolean
  isDragging?: boolean
  isDimmed?: boolean
  isLinkTarget?: boolean
  isTeamHighlighted?: boolean
  isDragGhost?: boolean
  childCount?: number
  delegationInfo?: { mode: 'all' | 'selected'; count: number } | null
  delegationGlow?: 'indigo' | 'emerald' | 'red' | null
  activeTask?: string | null
  projectName?: string | null
  lastError?: string | null
  onPointerDown?: (e: React.PointerEvent) => void
  onDragHandlePointerDown?: (e: React.PointerEvent) => void
  onPortDragStart?: (port: 'top' | 'bottom' | 'left' | 'right') => void
  onMenuClick?: (e: React.MouseEvent) => void
  onChatClick?: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
  onClick?: () => void
}

const ROLE_BADGE: Record<string, { label: string; cls: string }> = {
  coordinator: { label: 'Coordinator', cls: 'text-accent-bright bg-accent-bright/15' },
  worker: { label: 'Worker', cls: 'text-text-3 bg-layer-2' },
}

function truncateModel(model: string | undefined | null): string | null {
  if (!model) return null
  const parts = model.split('/')
  const name = parts[parts.length - 1]
  return name.length > 24 ? name.slice(0, 22) + '…' : name
}

export function OrgChartNode({
  agent,
  isRunning,
  isSelected,
  isDropTarget,
  isDragging,
  isDimmed,
  isLinkTarget,
  isTeamHighlighted,
  isDragGhost,
  childCount,
  delegationInfo,
  delegationGlow,
  activeTask,
  projectName,
  lastError,
  onPointerDown,
  onDragHandlePointerDown,
  onPortDragStart,
  onMenuClick,
  onChatClick,
  onContextMenu,
  onClick,
}: Props) {
  const role = agent.role || 'worker'
  const badge = ROLE_BADGE[role] || ROLE_BADGE.worker
  const disabled = !!agent.disabled
  const modelLabel = truncateModel(agent.model)
  const teamColor = agent.orgChart?.teamColor
  const teamLabel = agent.orgChart?.teamLabel
  const providerLabel = agent.provider && agent.provider !== 'ollama' ? agent.provider : null
  const glowShadow = delegationGlow === 'indigo'
    ? '0 0 18px rgba(99,102,241,0.35), 0 0 4px rgba(99,102,241,0.2)'
    : delegationGlow === 'emerald'
      ? '0 0 18px rgba(52,211,153,0.35), 0 0 4px rgba(52,211,153,0.2)'
      : delegationGlow === 'red'
        ? '0 0 18px rgba(244,63,94,0.35), 0 0 4px rgba(244,63,94,0.2)'
        : undefined
  const glowBorder = delegationGlow === 'indigo'
    ? 'rgba(99,102,241,0.4)'
    : delegationGlow === 'emerald'
      ? 'rgba(52,211,153,0.4)'
      : delegationGlow === 'red'
        ? 'rgba(244,63,94,0.4)'
        : undefined
  const description = agent.description?.slice(0, 60) || null
  const tools = (agent.tools || []).slice(0, 4)

  return (
    <div className="group relative">
      <div
        className={`
          select-none
          rounded-md border px-3 py-2.5 transition-all duration-150
          ${disabled ? 'opacity-40' : ''}
          ${isDimmed ? 'opacity-30 pointer-events-none' : ''}
          ${isDragging ? 'opacity-80 scale-105 shadow-lg shadow-black/30 z-50' : ''}
          ${isDropTarget ? 'ring-2 ring-accent-bright/50 border-accent-bright/30' : ''}
          ${isLinkTarget ? 'ring-2 ring-emerald-400/50 border-emerald-400/30 cursor-pointer' : ''}
          ${isSelected ? 'ring-2 ring-accent-bright/40 border-accent-bright/25' : ''}
          ${isTeamHighlighted && teamColor ? 'ring-1 ring-opacity-40' : ''}
          ${role === 'coordinator' ? 'border-accent-bright/20 bg-raised' : 'border-line-subtle bg-raised'}
        `}
        style={{
          width: 200,
          minHeight: 100,
          ...(glowShadow ? { boxShadow: glowShadow, borderColor: glowBorder, animation: 'delegation-glow-pulse 2s ease-in-out infinite' } : {}),
          ...(isTeamHighlighted && teamColor && !glowShadow ? { boxShadow: `0 0 0 1px ${teamColor}40` } : {}),
        }}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        onClick={onClick}
      >
        {/* Row 1: Avatar + Name + Status */}
        <div className="flex items-center gap-2 mb-1.5">
          {!isDragGhost && (
            <div
              className="cursor-grab active:cursor-grabbing shrink-0 flex flex-col gap-[2px] py-1 px-0.5 rounded hover:bg-layer-2 transition-colors"
              onPointerDown={(e) => { e.stopPropagation(); onDragHandlePointerDown?.(e) }}
            >
              <svg width="6" height="10" viewBox="0 0 6 10" className="text-text-3/40">
                <circle cx="1.5" cy="1.5" r="1" fill="currentColor" />
                <circle cx="4.5" cy="1.5" r="1" fill="currentColor" />
                <circle cx="1.5" cy="5" r="1" fill="currentColor" />
                <circle cx="4.5" cy="5" r="1" fill="currentColor" />
                <circle cx="1.5" cy="8.5" r="1" fill="currentColor" />
                <circle cx="4.5" cy="8.5" r="1" fill="currentColor" />
              </svg>
            </div>
          )}
          <AgentAvatar
            seed={agent.avatarSeed || null}
            avatarUrl={agent.avatarUrl}
            name={agent.name}
            size={28}
          />
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-600 text-text truncate leading-tight">{agent.name}</div>
            {modelLabel && (
              <div className="text-[9px] text-text-3/50 truncate leading-tight mt-0.5">{modelLabel}</div>
            )}
          </div>
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              lastError
                ? 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]'
                : isRunning
                  ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
                  : disabled
                    ? 'bg-red-400/60'
                    : 'bg-layer-3'
            }`}
            style={isRunning ? { animation: 'pulse-subtle 2s ease-in-out infinite' } : undefined}
          />
          {lastError && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[8px] font-700 flex items-center justify-center" title={lastError}>!</span>
          )}
        </div>

        {/* Row 2: Description */}
        {description && (
          <div className="text-[10px] text-text-3/60 leading-snug mb-1.5 line-clamp-2">{description}</div>
        )}

        {/* Row 3: Badges — role, team, children */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className={`text-[9px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-xs leading-none ${badge.cls}`}>
            {badge.label}
          </span>
          {agent.orchestratorEnabled && (
            <span className="text-[9px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-xs leading-none text-amber-400 bg-amber-400/15">
              Orchestrator
            </span>
          )}
          {teamLabel && (
            <span
              className="text-[9px] font-500 px-1.5 py-0.5 rounded-xs leading-none border"
              style={{
                color: teamColor || '#6366F1',
                backgroundColor: (teamColor || '#6366F1') + '18',
                borderColor: (teamColor || '#6366F1') + '30',
              }}
            >
              {teamLabel}
            </span>
          )}
          {childCount != null && childCount > 0 && (
            <span className="text-[9px] font-500 text-text-3/60 px-1 py-0.5 rounded-xs bg-layer-2 leading-none">+{childCount}</span>
          )}
          {providerLabel && (
            <span className="text-[9px] text-text-3/40 px-1 py-0.5 leading-none">{providerLabel}</span>
          )}
        </div>

        {/* Row 4: Tools */}
        {tools.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {tools.map((p) => (
              <span
                key={p}
                className="text-[8px] text-text-3/50 bg-layer-1 border border-line-subtle rounded-xs px-1 py-[1px] leading-none"
              >
                {p}
              </span>
            ))}
            {(agent.tools || []).length > 4 && (
              <span className="text-[8px] text-text-3/30 leading-none py-[1px]">+{(agent.tools || []).length - 4}</span>
            )}
          </div>
        )}

        {/* Delegation indicator */}
        {delegationInfo && (
          <div className="text-[9px] text-accent-bright/60 mt-1 truncate leading-tight">
            → {delegationInfo.mode === 'all' ? 'all workers' : `${delegationInfo.count} worker${delegationInfo.count !== 1 ? 's' : ''}`}
          </div>
        )}

        {/* Active task progress */}
        {isRunning && (
          <div className="mt-1.5 h-0.5 rounded-full bg-emerald-400/30 overflow-hidden">
            <div className="h-full w-1/3 bg-emerald-400/60 rounded-full" style={{ animation: 'shimmer-bar 1.5s ease-in-out infinite' }} />
          </div>
        )}
        {activeTask && (
          <div className="text-[9px] text-amber-400/80 mt-0.5 truncate leading-tight">{activeTask}</div>
        )}
        {projectName && (
          <div className="text-[9px] text-text-3/50 mt-0.5 truncate leading-tight">{projectName}</div>
        )}
      </div>

      {/* Hover action buttons — chat + menu */}
      {!isDragGhost && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className="w-[18px] h-[18px] rounded-xs flex items-center justify-center
              bg-layer-2 hover:bg-accent-bright/20 cursor-pointer border-none text-text-3 hover:text-accent-bright transition-colors"
            onClick={(e) => { e.stopPropagation(); onChatClick?.(e) }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Chat with agent"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2l3 2v-2h5a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H2zm1.5 3h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1 0-1zm0 3h6a.5.5 0 0 1 0 1h-6a.5.5 0 0 1 0-1z" />
            </svg>
          </button>
          <button
            className="w-[18px] h-[18px] rounded-xs flex items-center justify-center
              bg-layer-2 hover:bg-layer-3 cursor-pointer border-none text-text-3 hover:text-text transition-colors"
            onClick={(e) => { e.stopPropagation(); onMenuClick?.(e) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <circle cx="2.5" cy="6" r="1.2" />
              <circle cx="6" cy="6" r="1.2" />
              <circle cx="9.5" cy="6" r="1.2" />
            </svg>
          </button>
        </div>
      )}

      {/* Connection ports — appear on hover or during linking mode */}
      {!isDragGhost && (
        <>
          <div
            className={`absolute left-1/2 -translate-x-1/2 w-[10px] h-[10px] rounded-full border
              transition-opacity cursor-pointer
              ${isLinkTarget ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
              bg-white/10 border-white/20 hover:bg-accent-bright/60`}
            style={{ top: -5 }}
            onPointerDown={(e) => { e.stopPropagation(); onPortDragStart?.('top') }}
          />
          <div
            className={`absolute left-1/2 -translate-x-1/2 w-[10px] h-[10px] rounded-full border
              transition-opacity cursor-pointer
              ${isLinkTarget ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
              bg-white/10 border-white/20 hover:bg-accent-bright/60`}
            style={{ bottom: -5 }}
            onPointerDown={(e) => { e.stopPropagation(); onPortDragStart?.('bottom') }}
          />
          <div
            className={`absolute top-1/2 -translate-y-1/2 w-[10px] h-[10px] rounded-full border
              transition-opacity cursor-pointer
              ${isLinkTarget ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
              bg-white/10 border-white/20 hover:bg-accent-bright/60`}
            style={{ left: -5 }}
            onPointerDown={(e) => { e.stopPropagation(); onPortDragStart?.('left') }}
          />
          <div
            className={`absolute top-1/2 -translate-y-1/2 w-[10px] h-[10px] rounded-full border
              transition-opacity cursor-pointer
              ${isLinkTarget ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
              bg-white/10 border-white/20 hover:bg-accent-bright/60`}
            style={{ right: -5 }}
            onPointerDown={(e) => { e.stopPropagation(); onPortDragStart?.('right') }}
          />
        </>
      )}
    </div>
  )
}
