'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Clock, PlugZap, RadioTower, RefreshCw } from 'lucide-react'
import { api } from '@/lib/app/api-client'
import { cn } from '@/lib/utils'
import { filterPulseActions } from '@/lib/home/pulse-partition'
import type { OperationPulse, OperationPulseAction, OperationPulseActionKind, OperationPulseRange, OperationPulseSeverity } from '@/types'

const SEVERITY_CLASS: Record<OperationPulseSeverity, string> = {
 high: 'border-rose-500/20 bg-rose-500/[0.06] text-rose-200',
 medium: 'border-amber-500/20 bg-amber-500/[0.06] text-amber-200',
 low: 'border-line-subtle bg-layer-1 text-text-2',
}

function formatRelative(at: number | null, generatedAt: number): string {
 if (!at) return 'recent'
 const diff = Math.max(0, generatedAt - at)
 if (diff < 60_000) return 'just now'
 if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
 if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
 return `${Math.round(diff / 86_400_000)}d ago`
}

function kpiTone(value: number, danger = false): string {
 if (value <= 0) return 'text-text'
 return danger ? 'text-rose-300' : 'text-amber-300'
}

function Kpi({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
 return (
 <div className="min-w-[110px] rounded-md border border-line-subtle bg-layer-1 px-3 py-2">
 <div className="text-[10px] font-700 tracking-[0.03em] text-text-3">{label}</div>
 <div className={cn('mt-1 font-display text-[22px] font-700 tracking-normal', kpiTone(value, danger))}>{value}</div>
 </div>
 )
}

function actionIcon(action: OperationPulseAction) {
 if (action.severity === 'high') return <AlertTriangle size={15} />
 if (action.kind === 'connector') return <PlugZap size={15} />
 if (action.kind === 'gateway') return <RadioTower size={15} />
 if (action.kind === 'mission') return <Clock size={15} />
 return <CheckCircle2 size={15} />
}

export function OperationsPulsePanel({
 defaultRange = '24h',
 className,
 compact = false,
 kinds,
}: {
 defaultRange?: OperationPulseRange
 className?: string
 compact?: boolean
 /** Restrict which action kinds render. Omitted means all of them, which is
  *  what the /operations view wants; the home page passes a subset. */
 kinds?: readonly OperationPulseActionKind[]
}) {
 const router = useRouter()
 const [range, setRange] = useState<OperationPulseRange>(defaultRange)
 const [pulse, setPulse] = useState<OperationPulse | null>(null)
 const [loading, setLoading] = useState(true)
 const [refreshing, setRefreshing] = useState(false)

 const loadPulse = useCallback(async (nextRange = range, silent = false) => {
 if (silent) setRefreshing(true)
 else setLoading(true)
 try {
 const next = await api<OperationPulse>('GET', `/operations/pulse?range=${nextRange}`)
 setPulse(next)
 } catch {
 setPulse(null)
 } finally {
 setLoading(false)
 setRefreshing(false)
 }
 }, [range])

 useEffect(() => {
 void loadPulse(range)
 }, [loadPulse, range])

 const actions = useMemo(() => filterPulseActions(pulse?.actions || [], kinds), [pulse, kinds])
 const stable = useMemo(() => {
 if (!pulse) return false
 return pulse.kpis.failedRuns === 0
 && pulse.kpis.pendingApprovals === 0
 && pulse.kpis.connectorAttention === 0
 && pulse.kpis.gatewayAttention === 0
 && pulse.kpis.budgetWarnings === 0
 }, [pulse])

 return (
 <section className={cn('section-band ', className)}>
 <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
 <div>
 <div className="text-[10px] font-700 tracking-[0.03em] text-accent-bright/70">Operations Pulse</div>
 <h2 className="mt-1 font-display text-[16px] font-700 tracking-normal text-text">What needs operator attention next</h2>
 <p className="mt-1 max-w-[680px] text-[12px] leading-relaxed text-text-3">
 Missions, runs, approvals, connector readiness, OpenClaw gateways, and budget pressure rolled into one triage queue.
 </p>
 </div>
 <div className="flex flex-wrap items-center gap-2">
 {(['24h', '7d'] as const).map((item) => (
 <button
 key={item}
 type="button"
 onClick={() => setRange(item)}
 className={cn(
 'rounded-sm px-2.5 py-1.5 text-[11px] font-700 transition-colors',
 range === item ? 'bg-accent-soft text-accent-bright' : 'bg-layer-2 text-text-3 hover:bg-layer-3 hover:text-text-2',
 )}
 >
 {item}
 </button>
 ))}
 <button
 type="button"
 onClick={() => void loadPulse(range, true)}
 className="inline-flex items-center gap-1.5 rounded-sm border border-line-default bg-layer-2 px-2.5 py-1.5 text-[11px] font-700 text-text-2 hover:bg-layer-3"
 >
 <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
 Refresh
 </button>
 </div>
 </div>

 {loading ? (
 <div className="mt-4 rounded-lg border border-line-subtle bg-surface px-3 py-4 text-[12px] text-text-3">
 Loading pulse...
 </div>
 ) : !pulse ? (
 <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-3 py-3 text-[12px] text-rose-200">
 Operations pulse is unavailable.
 </div>
 ) : (
 <>
 <div className={cn('mt-4 grid gap-2', compact ? 'grid-cols-2 md:grid-cols-4 xl:grid-cols-7' : 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-7')}>
 <Kpi label="Missions" value={pulse.kpis.activeMissions} />
 <Kpi label="Running" value={pulse.kpis.runningRuns} />
 <Kpi label="Failed" value={pulse.kpis.failedRuns} danger />
 <Kpi label="Approvals" value={pulse.kpis.pendingApprovals} />
 <Kpi label="Connectors" value={pulse.kpis.connectorAttention} danger />
 <Kpi label="Gateways" value={pulse.kpis.gatewayAttention} danger />
 <Kpi label="Budgets" value={pulse.kpis.budgetWarnings} />
 </div>

 <div className="mt-4">
 {stable || actions.length === 0 ? (
 <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.05] px-3 py-3 text-[12px] text-emerald-200">
 No current blockers in the selected window.
 </div>
 ) : (
 <div className="grid gap-2 lg:grid-cols-2">
 {actions.map((action) => (
 <button
 key={action.id}
 type="button"
 onClick={() => router.push(action.href)}
 className={cn('rounded-lg border px-3 py-3 text-left transition-colors hover:bg-layer-2', SEVERITY_CLASS[action.severity])}
 >
 <div className="flex items-start gap-2">
 <span className="mt-0.5 shrink-0">{actionIcon(action)}</span>
 <span className="min-w-0 flex-1">
 <span className="flex items-center justify-between gap-3">
 <span className="truncate text-[12px] font-700 text-text">{action.title}</span>
 <span className="shrink-0 text-[10px] text-text-3">{formatRelative(action.createdAt, pulse.generatedAt)}</span>
 </span>
 <span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed text-text-3">{action.summary}</span>
 {action.evidence.length > 0 && (
 <span className="mt-2 flex flex-wrap gap-1.5">
 {action.evidence.slice(0, 2).map((item) => (
 <span key={item} className="rounded-full bg-layer-2 px-2 py-0.5 text-[10px] font-700 text-text-3">
 {item}
 </span>
 ))}
 </span>
 )}
 </span>
 </div>
 </button>
 ))}
 </div>
 )}
 </div>
 </>
 )}
 </section>
 )
}
