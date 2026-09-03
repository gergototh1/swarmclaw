import type { AppView } from '@/types'

/** Every extension page path lives under this prefix. */
export const EXTENSION_PAGE_PATH_PREFIX = '/x/'

/** True when a router pathname points at a page contributed by an extension. */
export function isExtensionPagePath(pathname: string): boolean {
  return pathname.startsWith(EXTENSION_PAGE_PATH_PREFIX)
}

/**
 * Built-in rail entries that mount an anchored extension slot.
 *
 * An extension page asks to sit directly after one of these with
 * `position: 'after:<view>'`. Any other position, including an anchor naming a
 * view that is not listed here, falls to the trailing "Extension Pages" group,
 * so a page can never fall out of the rail entirely.
 *
 * Adding a value here is only half the change: `sidebar-rail.tsx` must also
 * render an `<ExtensionPagesAfter view="<view>" />` next to that built-in entry,
 * otherwise pages anchored there stop rendering anywhere.
 */
export const EXTENSION_NAV_ANCHORS = ['tasks'] as const satisfies readonly AppView[]

/** A built-in view an extension page may anchor itself after. */
export type ExtensionNavAnchor = (typeof EXTENSION_NAV_ANCHORS)[number]

/** The `position` string that anchors a page after `view`. */
export function anchorPosition(view: string): string {
  return `after:${view}`
}

/** True when `position` anchors a page after a rail entry that is actually mounted. */
export function isMountedAnchorPosition(position: string | undefined): boolean {
  if (!position) return false
  return EXTENSION_NAV_ANCHORS.some((view) => position === anchorPosition(view))
}

/**
 * Icon names an extension may put in a page declaration's `icon` field.
 *
 * Deliberately a curated list rather than lucide's full `icons` barrel: the rail
 * ships on every route, and the barrel would pull the whole icon set into that
 * bundle. Lives here rather than next to the rendering map so that server code
 * and documentation can read the key space without importing a client module.
 * A name outside this list renders the `Puzzle` fallback.
 */
export const EXTENSION_PAGE_ICON_NAMES = [
  'Activity', 'Bell', 'Bot', 'Boxes', 'Calendar', 'Compass', 'Database', 'FileText', 'Folder', 'Gauge',
  'Globe', 'Hash', 'Heart', 'Inbox', 'Layers', 'LineChart', 'Lightbulb', 'Link2', 'List', 'Mail', 'MapPin',
  'MessageSquare', 'Newspaper', 'Puzzle', 'Radar', 'Rss', 'Search', 'Send', 'Settings', 'Shield',
  'Sparkles', 'Star', 'Tag', 'Terminal', 'TrendingUp', 'Users', 'Workflow', 'Zap',
] as const

/** An icon name the rail knows how to render. */
export type ExtensionPageIconName = (typeof EXTENSION_PAGE_ICON_NAMES)[number]
