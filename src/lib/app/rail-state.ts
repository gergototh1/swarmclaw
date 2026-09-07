import { sectionForView, type NavSectionId } from '@/lib/app/nav-sections'
import { isExtensionPagePath, resolvePageSection } from '@/lib/extension-page-nav'
import type { AppView } from '@/types'

/** localStorage key for whether the rail shows labels. */
export const RAIL_EXPANDED_KEY = 'sc_rail_expanded'

/**
 * Whether the rail starts labelled, from whatever localStorage holds.
 *
 * Defaults to labelled: a first-time reader should see the section names, and
 * the 52px icon rail is something you opt into once you know them. Anything
 * that is not exactly 'false' counts as labelled, so a corrupted value cannot
 * leave someone with a rail of unexplained icons.
 */
export function railExpandedFromStorage(stored: string | null): boolean {
  return stored !== 'false'
}

/** The minimum of an extension page declaration the rail needs to place a route. */
export interface RailPlaceablePage {
  path: string
  section?: string
  position?: string
}

/**
 * The rail section a pathname sits in, or null when none should light up.
 *
 * Three cases, and the third is the one worth stating. A recognized route
 * answers through its `AppView` — which may still be null, because a view can
 * be deliberately exempt from the rail (`NAV_EXEMPT_VIEWS`), and /swarmfeed is
 * exactly that. An extension page is not an `AppView` at all, so on `/x/...`
 * the section comes from the page's own declaration; a bookmark or a reload
 * lands there with no prior state, and without this it would light up whichever
 * section happened to be open last, or none. Everything else — /s/<token>, and
 * any route added later that is not a view — gets null rather than a section,
 * because `resolvePageSection` answers 'work' for an object it knows nothing
 * about, and running an unrecognized path through it would silently light up
 * Work on pages that have nothing to do with Work.
 */
export function railSectionForPath(
  pathname: string,
  activeView: AppView | null,
  pages: readonly RailPlaceablePage[],
): NavSectionId | null {
  if (activeView) return sectionForView(activeView)
  if (!isExtensionPagePath(pathname)) return null
  const page = pages.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`))
  return resolvePageSection(page ?? {})
}
