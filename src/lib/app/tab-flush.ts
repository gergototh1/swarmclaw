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

/** How long the host waits for a frame's `flushed` answer before counting it as false. */
export const FLUSH_TIMEOUT_MS = 3_000
/** How long the host waits before asking a frame that refused (or timed out) to sleep again. */
export const FLUSH_REFUSAL_COOLDOWN_MS = 15_000

export interface FlushRequestDeps {
  newRequestId: () => string
  /** Runs `fn` after `ms`; returns a function that cancels it. */
  schedule: (fn: () => void, ms: number) => () => void
  now: () => number
  timeoutMs?: number
  cooldownMs?: number
}

export interface FlushRequests {
  /**
   * Asks a tab to flush, calling `send` with the request id. A request made
   * while one is out for that tab joins it and gets the same answer. Every
   * request resolves: with the answer, or false on timeout, `retain` or `dispose`.
   */
  request(tabId: string, send: (requestId: string) => void): Promise<boolean>
  /** A `flushed` answer; ignored unless it names the request that is out. */
  answer(tabId: string, requestId: string, ok: boolean): void
  isPending(tabId: string): boolean
  /** True within the cooldown after the tab's last flush came back false. */
  refusedRecently(tabId: string): boolean
  /** Forgets every tab not in `tabIds`: pending requests resolve false, refusals are dropped. */
  retain(tabIds: ReadonlySet<string>): void
  /** Settles every pending request as false and cancels its timer. */
  dispose(): void
}

interface PendingFlush {
  requestId: string
  cancelTimer: () => void
  resolvers: Array<(ok: boolean) => void>
}

/** The host's side of flush requests, one tracker per host. */
export function createFlushRequests(deps: FlushRequestDeps): FlushRequests {
  const timeoutMs = deps.timeoutMs ?? FLUSH_TIMEOUT_MS
  const cooldownMs = deps.cooldownMs ?? FLUSH_REFUSAL_COOLDOWN_MS
  const pending = new Map<string, PendingFlush>()
  const refusedAt = new Map<string, number>()

  const settle = (tabId: string, ok: boolean, remember: boolean) => {
    const entry = pending.get(tabId)
    if (!entry) return
    pending.delete(tabId)
    entry.cancelTimer()
    if (remember) {
      if (ok) refusedAt.delete(tabId)
      else refusedAt.set(tabId, deps.now())
    }
    for (const resolve of entry.resolvers) resolve(ok)
  }

  return {
    request(tabId, send) {
      return new Promise<boolean>((resolve) => {
        const existing = pending.get(tabId)
        if (existing) {
          existing.resolvers.push(resolve)
          return
        }
        const requestId = deps.newRequestId()
        const cancelTimer = deps.schedule(() => settle(tabId, false, true), timeoutMs)
        pending.set(tabId, { requestId, cancelTimer, resolvers: [resolve] })
        send(requestId)
      })
    },
    answer(tabId, requestId, ok) {
      if (pending.get(tabId)?.requestId === requestId) settle(tabId, ok, true)
    },
    isPending: (tabId) => pending.has(tabId),
    refusedRecently(tabId) {
      const at = refusedAt.get(tabId)
      return at !== undefined && deps.now() - at < cooldownMs
    },
    retain(tabIds) {
      for (const tabId of [...pending.keys()]) if (!tabIds.has(tabId)) settle(tabId, false, false)
      for (const tabId of [...refusedAt.keys()]) if (!tabIds.has(tabId)) refusedAt.delete(tabId)
    },
    dispose() {
      for (const tabId of [...pending.keys()]) settle(tabId, false, false)
    },
  }
}
