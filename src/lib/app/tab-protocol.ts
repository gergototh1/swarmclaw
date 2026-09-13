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

/**
 * Never actually reachable -- only used so a candidate app path can be run
 * through `new URL` and checked for normalisation without needing the app's
 * real origin.
 */
const PLACEHOLDER_ORIGIN = 'http://app.invalid'

/**
 * A percent-encoded slash or backslash can hide a path-segment boundary from
 * this string check while still being decoded into a real one by a server
 * that routes on the decoded path -- e.g. `/api%2ffiles/serve` does not
 * start with `/api/` here, but can still reach it server-side. Reject both,
 * case-insensitively, rather than trying to decode and re-check.
 */
function hasEncodedPathSeparator(pathname: string): boolean {
  return /%2f|%5c/i.test(pathname)
}

function isTabbablePath(pathname: string): boolean {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return false
  if (hasEncodedPathSeparator(pathname)) return false
  if (NOT_TABBABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  return !NOT_TABBABLE_PATHS.has(pathname)
}

/**
 * The one gate for "is this string a safe, already-canonical app path" --
 * used by both the `appUrl` zod schema below and `appUrlFromHref`.
 *
 * Resolves the candidate against a placeholder origin so a value that
 * changes the origin during parsing is rejected: `new URL` treats `\` as `/`
 * for http(s) URLs, so `/\evil.example` resolves to origin
 * `http://evil.example`, not the placeholder. It then re-serialises the
 * parsed result as `pathname + search + hash` and requires that to equal the
 * candidate exactly -- anything the parser normalised away (encoded or
 * literal dot segments, a stray backslash turned into a slash) means the
 * candidate was not already canonical, so it is refused rather than silently
 * rewritten. A literal backslash is also rejected outright, ahead of parsing.
 */
function isValidAppPath(candidate: string): boolean {
  if (candidate.includes('\\')) return false
  let url: URL
  try {
    url = new URL(candidate, PLACEHOLDER_ORIGIN)
  } catch {
    return false
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return false
  if (`${url.pathname}${url.search}${url.hash}` !== candidate) return false
  return isTabbablePath(url.pathname)
}

const appUrl = z.string().refine(isValidAppPath)

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
  if (href.includes('\\')) return null
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  const candidate = `${url.pathname}${url.search}${url.hash}`
  return isValidAppPath(candidate) ? candidate : null
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

const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
])

/**
 * True for an element that takes typed or pasted text: a textarea, a select, any
 * `contentEditable` element, or an input whose type is not one of the handful
 * that take no text (`checkbox`, `range`, `submit`, ...). An input with no
 * `type` attribute defaults to `text`, so it counts as editable too.
 */
export function isEditableElementLike(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName !== 'INPUT') return false
  return !NON_TEXT_INPUT_TYPES.has((el.type ?? 'text').toLowerCase())
}

/**
 * The tab command a keystroke means, if any.
 *
 * The browser reserves Cmd/Ctrl+T, W and Tab for itself, so the browser layout
 * is on Option/Alt and is read by `code` (Option+T types a dagger on a Mac, so
 * `key` is useless there). In the desktop app the Electron menu owns the tab
 * keys and delivers them itself, so only the palette is mapped here.
 *
 * `opts.editable` is true when the key landed in a text field: on Hungarian and
 * German Mac layouts, Option+digits and Option+letters type characters such as
 * `[ ] { } @`, and Option+Left/Right moves the caret by word on every Mac. So
 * inside a text field, only the Cmd/Ctrl+K palette command is taken; every
 * Option-based command is left for the field to handle.
 */
export function tabCommandForKey(e: KeyLike, platform: KeyPlatform, opts: { editable?: boolean } = {}): TabCommand | null {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') return { kind: 'palette' }
  if (opts.editable) return null
  if (platform === 'desktop-app') return null
  if (!e.altKey || e.metaKey || e.ctrlKey) return null
  if (e.code === 'KeyT') return e.shiftKey ? { kind: 'reopen' } : { kind: 'new' }
  if (e.code === 'KeyW' && !e.shiftKey) return { kind: 'close' }
  if (e.code === 'ArrowRight') return { kind: 'next' }
  if (e.code === 'ArrowLeft') return { kind: 'previous' }
  const digit = /^Digit([1-9])$/.exec(e.code)
  return digit ? { kind: 'goto', position: Number(digit[1]) } : null
}
