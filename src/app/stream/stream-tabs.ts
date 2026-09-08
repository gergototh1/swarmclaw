/**
 * The three event views this route absorbed: run history, the entity audit
 * trail, and application logs. They were three routes with three copies of the
 * same header because they were never one page, not because they show
 * different things.
 */
export const STREAM_TABS = [
  { key: 'runs', label: 'Runs', href: '/stream?tab=runs' },
  { key: 'activity', label: 'Activity', href: '/stream?tab=activity' },
  { key: 'logs', label: 'Logs', href: '/stream?tab=logs' },
] as const

export type StreamTabKey = (typeof STREAM_TABS)[number]['key']

/** Resolve the `?tab=` parameter, defaulting to runs for anything unrecognised. */
export function streamTabFromSearch(param: string | null): StreamTabKey {
  const match = STREAM_TABS.find((t) => t.key === param)
  return match ? match.key : 'runs'
}

/**
 * Where each retired route now sends the reader.
 *
 * The stubs at /runs, /activity and /logs import from here rather than writing
 * the path out, so renaming a tab cannot leave a bookmark pointing at nothing.
 */
export const STREAM_REDIRECTS: Record<StreamTabKey, string> = {
  runs: '/stream?tab=runs',
  activity: '/stream?tab=activity',
  logs: '/stream?tab=logs',
}
