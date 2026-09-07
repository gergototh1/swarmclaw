export function relativeDate(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatHeartbeatInterval(intervalSec?: number | null): string {
  if (!intervalSec || intervalSec <= 0) return 'Manual'
  if (intervalSec % 3600 === 0) return `${intervalSec / 3600}h`
  if (intervalSec % 60 === 0) return `${intervalSec / 60}m`
  return `${intervalSec}s`
}

export const STATUS_STYLES: Record<string, string> = {
  backlog: 'bg-layer-2 text-text-3',
  queued: 'bg-amber-500/15 text-amber-400',
  running: 'bg-sky-500/15 text-sky-400',
  completed: 'bg-emerald-500/15 text-emerald-400',
  failed: 'bg-red-500/15 text-red-400',
  archived: 'bg-layer-2 text-text-3/50',
}
