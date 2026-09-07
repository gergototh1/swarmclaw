import { NAV_SECTION_IDS, type NavSectionId } from '@/lib/app/nav-sections'

/** Every extension page path lives under this prefix. */
export const EXTENSION_PAGE_PATH_PREFIX = '/x/'

/** True when a router pathname points at a page contributed by an extension. */
export function isExtensionPagePath(pathname: string): boolean {
  return pathname.startsWith(EXTENSION_PAGE_PATH_PREFIX)
}

/** Where a page lands when it declares nothing, or declares something unknown. */
const DEFAULT_PAGE_SECTION: NavSectionId = 'work'

/** Where a page sits among its section's extension pages when it declares no order. */
const DEFAULT_PAGE_ORDER = 100

/**
 * The rail section a page belongs to.
 *
 * `section` is the field extensions declare now. `position` is what they
 * declared before: 'after:tasks' was the single anchor the rail ever mounted,
 * and 'end' put the page in a trailing group at the very bottom — which is
 * where the CRM page sat, below every built-in entry, for no reason a reader
 * of that extension could see. Every legacy value resolves to Work, so the
 * installed pages move without being edited.
 */
export function resolvePageSection(page: { section?: string; position?: string }): NavSectionId {
  const declared = page.section
  if (declared && (NAV_SECTION_IDS as readonly string[]).includes(declared)) {
    return declared as NavSectionId
  }
  return DEFAULT_PAGE_SECTION
}

/** A page's sort key within its section. Ties break on label, in the caller. */
export function resolvePageOrder(page: { order?: number }): number {
  const declared = page.order
  return typeof declared === 'number' && Number.isFinite(declared) ? declared : DEFAULT_PAGE_ORDER
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
