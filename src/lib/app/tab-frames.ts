import { isValidAppPath } from '@/lib/app/tab-protocol'
import type { TabsState } from '@/lib/app/tabs'

/**
 * The tab host's frame bookkeeping, as pure functions, so the rules the host
 * relies on for safety and for not losing edits can be tested without a DOM.
 */

export interface MountedFrame {
  id: string
  src: string
  /** Bumped to force a fresh load of the same URL. */
  generation: number
}

/**
 * The frames that follow from a tab change: a closed tab loses its frame at
 * once (closing already flushed), and the active tab always has one, loaded
 * from its URL. Frames over the live cap are left for the flush-then-sleep
 * effect. Returns `current` itself when nothing changed.
 */
export function reconcileFrames(current: MountedFrame[], state: TabsState): MountedFrame[] {
  const known = new Set(state.tabs.map((t) => t.id))
  let next = current.every((f) => known.has(f.id)) ? current : current.filter((f) => known.has(f.id))
  const active = state.tabs.find((t) => t.id === state.activeId)
  if (active && !next.some((f) => f.id === active.id)) next = [...next, { id: active.id, src: active.url, generation: 0 }]
  return next
}

export interface MessageEventLike {
  origin: string
  source: unknown
}

/**
 * Whether a message claiming to come from tab `tabId` really does.
 *
 * Both halves are required. The origin must be the app's own, AND the sending
 * window must be the content window of the iframe the host itself created for
 * that tab id. A same-origin window that is not that frame -- a chat preview
 * iframe, a popup, another tab's frame naming someone else's id -- is refused,
 * and so is a frame that navigated away to another origin.
 */
export function isOwnFrameMessage(
  event: MessageEventLike,
  expectedOrigin: string,
  tabId: string,
  frames: ReadonlyMap<string, { contentWindow: unknown }>,
): boolean {
  if (event.origin !== expectedOrigin) return false
  const contentWindow = frames.get(tabId)?.contentWindow
  if (!contentWindow) return false
  return event.source === contentWindow
}

/**
 * The URL the host's address bar should be replaced with so it shows the
 * active tab, or null when it already does -- or when the active tab's URL is
 * not a valid app path, which `history.replaceState` could throw on (a
 * `/\evil.example` resolves to another origin).
 */
export function addressBarUpdate(state: TabsState | null, currentUrl: string): string | null {
  const active = state?.tabs.find((t) => t.id === state.activeId)
  if (!active || active.url === currentUrl || !isValidAppPath(active.url)) return null
  return active.url
}
