import { z } from 'zod'

/**
 * What the tab host and the frames it hosts say to each other.
 *
 * Both sides validate everything they receive: a message is only acted on when
 * it parses here AND came from the expected window on the app's own origin
 * (the components check the window). URLs are app paths only -- never another
 * origin, never an API route or asset, never an auth page, which belongs to the
 * host window, not to a tab.
 */

export const TAB_WINDOW_NAME_PREFIX = 'sc-tab:'

const NOT_TABBABLE_PREFIXES = ['/api/', '/_next/']
const NOT_TABBABLE_PATHS = new Set(['/login', '/setup', '/user'])

function isTabbablePath(pathname: string): boolean {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return false
  if (NOT_TABBABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  return !NOT_TABBABLE_PATHS.has(pathname)
}

const appUrl = z.string().refine((value) => isTabbablePath(value.split(/[?#]/)[0]))

const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new') }),
  z.object({ kind: z.literal('close') }),
  z.object({ kind: z.literal('reopen') }),
  z.object({ kind: z.literal('next') }),
  z.object({ kind: z.literal('previous') }),
  z.object({ kind: z.literal('goto'), position: z.number().int().min(1).max(9) }),
  z.object({ kind: z.literal('palette') }),
])

export type TabCommand = z.infer<typeof commandSchema>

const fromTab = { source: z.literal('sc-tab'), tabId: z.string().min(1) }

const frameMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...fromTab, type: z.literal('ready') }),
  z.object({ ...fromTab, type: z.literal('location'), url: appUrl }),
  z.object({ ...fromTab, type: z.literal('title'), text: z.string().nullable() }),
  z.object({ ...fromTab, type: z.literal('open-tab'), url: appUrl, activate: z.boolean() }),
  z.object({ ...fromTab, type: z.literal('command'), command: commandSchema }),
  z.object({ ...fromTab, type: z.literal('auth-required') }),
  z.object({ ...fromTab, type: z.literal('flushed'), requestId: z.string().min(1), ok: z.boolean() }),
])

export type FrameMessage = z.infer<typeof frameMessageSchema>

const hostMessageSchema = z.discriminatedUnion('type', [
  z.object({ source: z.literal('sc-host'), type: z.literal('navigate'), href: appUrl }),
  z.object({ source: z.literal('sc-host'), type: z.literal('flush'), requestId: z.string().min(1) }),
])

export type HostMessage = z.infer<typeof hostMessageSchema>

export function parseFrameMessage(data: unknown): FrameMessage | null {
  const parsed = frameMessageSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export function parseHostMessage(data: unknown): HostMessage | null {
  const parsed = hostMessageSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export function parseTabCommand(data: unknown): TabCommand | null {
  const parsed = commandSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** The app path a link points at, when it is on this origin and belongs in a tab. */
export function appUrlFromHref(href: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin || !isTabbablePath(url.pathname)) return null
  return `${url.pathname}${url.search}${url.hash}`
}

export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type KeyPlatform = 'desktop-app' | 'browser'

/**
 * The tab command a keystroke means, if any.
 *
 * The browser reserves Cmd/Ctrl+T, W and Tab for itself, so the browser layout
 * is on Option/Alt and is read by `code` (Option+T types a dagger on a Mac, so
 * `key` is useless there). In the desktop app the Electron menu owns the tab
 * keys and delivers them itself, so only the palette is mapped here.
 */
export function tabCommandForKey(e: KeyLike, platform: KeyPlatform): TabCommand | null {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') return { kind: 'palette' }
  if (platform === 'desktop-app') return null
  if (!e.altKey || e.metaKey || e.ctrlKey) return null
  if (e.code === 'KeyT') return e.shiftKey ? { kind: 'reopen' } : { kind: 'new' }
  if (e.code === 'KeyW' && !e.shiftKey) return { kind: 'close' }
  if (e.code === 'ArrowRight') return { kind: 'next' }
  if (e.code === 'ArrowLeft') return { kind: 'previous' }
  const digit = /^Digit([1-9])$/.exec(e.code)
  return digit ? { kind: 'goto', position: Number(digit[1]) } : null
}
