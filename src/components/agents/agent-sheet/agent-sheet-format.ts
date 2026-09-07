export const HB_PRESETS = [1800, 3600, 7200, 21600, 43200] as const

export function formatHbDuration(sec: number): string {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
  }
  if (sec >= 60) return `${Math.floor(sec / 60)}m`
  return `${sec}s`
}

/** Parse a stored heartbeatInterval string or heartbeatIntervalSec number to a select-friendly string of seconds */
export function parseDurationToSec(interval: string | number | null | undefined, intervalSec: number | null | undefined): string {
  if (intervalSec != null && Number.isFinite(intervalSec) && intervalSec > 0) {
    // Snap to nearest preset if close, otherwise use raw value
    const closest = HB_PRESETS.find((p) => p === Math.round(intervalSec))
    if (closest) return String(closest)
  }
  if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
    return String(Math.round(interval))
  }
  if (interval != null && typeof interval === 'string' && interval.trim()) {
    const t = interval.trim().toLowerCase()
    const n = Number(t)
    if (Number.isFinite(n) && n > 0) return String(Math.round(n))
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/)
    if (m && (m[1] || m[2] || m[3])) {
      const total = (m[1] ? parseInt(m[1]) * 3600 : 0) + (m[2] ? parseInt(m[2]) * 60 : 0) + (m[3] ? parseInt(m[3]) : 0)
      if (total > 0) return String(total)
    }
  }
  return '' // default
}

export function formatIdentityList(value: string[] | null | undefined): string {
  return Array.isArray(value) ? value.join('\n') : ''
}

export function parseIdentityList(value: string): string[] {
  const seen = new Set<string>()
  return value
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false
      const key = line.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function formatGatewayTagList(value: string[] | null | undefined): string {
  return Array.isArray(value) ? value.join(', ') : ''
}

export function parseGatewayTagList(value: string): string[] {
  const seen = new Set<string>()
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry) return false
      const key = entry.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
