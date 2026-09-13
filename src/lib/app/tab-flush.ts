import { hmrSingleton } from '@/lib/shared-utils'

type FlushHandler = () => Promise<boolean>

const handlers = hmrSingleton('tabFlush_handlers', () => new Set<FlushHandler>())

/**
 * Something in this window holds edits that must be saved before the window
 * goes away: the host asks before it puts a tab to sleep or closes it, and
 * removing an iframe runs neither `pagehide` nor React cleanup reliably.
 */
export function onTabFlushRequest(handler: FlushHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/** True only when every handler saved everything; a handler that throws counts as false. */
export async function runTabFlushHandlers(): Promise<boolean> {
  const results = await Promise.all([...handlers].map((handler) => handler().catch(() => false)))
  return results.every(Boolean)
}
