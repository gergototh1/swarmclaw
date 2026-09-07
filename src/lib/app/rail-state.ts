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
 * be deliberately exempt from the rail (`NAV_EXEMPT_VIEWS`); nothing is exempt
 * today. An extension page is not an `AppView` at all, so on `/x/...`
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

/**
 * The reader's last explicit click on the rail, closed over the route section
 * it was made against.
 *
 * `section: null` records a close rather than the absence of a pick — clicking
 * the section that is already open closes its panel, and that closed state has
 * to be distinguishable from "no one has clicked anything yet" so it can win
 * over `routeSection` on the very next render (see `resolveOpenSection`).
 */
export interface RailSectionPick {
  section: NavSectionId | null
  route: NavSectionId | null
}

/**
 * Which section's panel is open, combining the route-derived section with the
 * reader's last explicit pick (open, switch, or close).
 *
 * The pick only overrides the route while the route hasn't moved since the
 * pick was made — `pick.route === routeSection`. That single comparison
 * settles both halves of the close-vs-route tension:
 *
 * - An explicit close must survive its own render. Closing Work leaves
 *   `pick = { section: null, route: 'work' }`; the route stays 'work' as long
 *   as the reader hasn't navigated, so this keeps returning null instead of
 *   `routeSection` snapping the panel back open the instant it re-renders.
 *   Without the pick carrying `route`, there would be no way to tell "closed
 *   while on this route" apart from "never opened," and the toggle would look
 *   broken.
 * - The close does not outlive the route it was made on. The moment the route
 *   changes — clicking a link inside a different section, or a bookmark
 *   landing on /missions right after Work was closed — `pick.route` no longer
 *   matches `routeSection`, so this falls through to `routeSection` and
 *   surfaces whichever section the new route belongs to. A close is a
 *   statement about the section you were just looking at ("stop showing me
 *   this"), not a standing "never show me a panel" preference; treating it as
 *   the latter would strand a reader who navigates into Missions with no
 *   panel and no visible cue for where they landed.
 */
export function resolveOpenSection(
  routeSection: NavSectionId | null,
  pick: RailSectionPick | null,
): NavSectionId | null {
  if (pick && pick.route === routeSection) return pick.section
  return routeSection
}
