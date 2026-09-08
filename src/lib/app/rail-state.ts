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

/** localStorage key for whether the reader has closed the section panel. */
export const PANEL_CLOSED_KEY = 'sc_panel_closed'

/**
 * Whether the section panel starts closed, from whatever localStorage holds.
 *
 * Defaults to open (the pre-existing behaviour: the panel follows the route)
 * unless the value is exactly 'true'. This is one global flag, not one per
 * section -- see the note on `resolveOpenSection` for why a single "the panel
 * stays closed until I open one" preference is the right size for this,
 * rather than remembering a closed/open bit per section.
 */
export function panelClosedFromStorage(stored: string | null): boolean {
  return stored === 'true'
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
 * Which section's panel is open, combining the route-derived section, the
 * reader's last explicit pick (open, switch, or close) made *this render
 * session*, and the persisted `closed` preference that survives navigation
 * and reloads (backed by `PANEL_CLOSED_KEY`, the same way `railExpanded` is
 * backed by `RAIL_EXPANDED_KEY`).
 *
 * The owner asked for one thing: once the section panel is closed, it stays
 * closed across navigation and reloads. That collides with the pre-existing
 * anti-stranding rule below (a close must not outlive the route it was made
 * on) unless the two are separated into different lifetimes:
 *
 * - `pick` is transient, scoped to the current mount, and answers "did the
 *   reader just click something, right now, on this exact route." It is what
 *   makes clicking a section instantaneous (open/close/switch all resolve on
 *   the same render) and what lets a reader open a *different* section's
 *   panel while standing still on one route (open Knowledge while on
 *   /tasks) without that being read as a close.
 * - `closed` is durable. It is not "Work is closed"; it is one global "the
 *   reader does not want an autopilot panel to be showing" flag — see the
 *   doc on `panelClosedFromStorage` for why one flag rather than one per
 *   section. It is what makes the close survive a navigation the transient
 *   `pick` cannot: the moment the route moves, `pick.route` stops matching
 *   `routeSection` and falls out of the picture, but `closed` keeps applying.
 *
 * `pick` still wins over `closed` whenever it applies (`pick.route ===
 * routeSection`), so an explicit click always wins on the render it happens:
 *
 * - An explicit close must survive its own render. Closing Work leaves
 *   `pick = { section: null, route: 'work' }`; the route stays 'work' as long
 *   as the reader hasn't navigated, so this keeps returning null instead of
 *   `routeSection` snapping the panel back open the instant it re-renders.
 * - Clicking any section while closed must open it (otherwise the rail looks
 *   dead) — a click always produces a fresh `pick` with a non-null section,
 *   and that pick applies on this same render regardless of `closed`.
 *
 * Once the route moves and `pick` falls away, the decision is the caller's
 * persisted preference: closed stays closed (`null`), open follows the new
 * route the way it always has. This is the deliberate departure from the old
 * rule ("a route change always overrides a stale close") — that rule existed
 * only because the old close was itself transient and had no way to mean
 * anything beyond the route it was made on. Now that a close is a standing
 * preference the reader set on purpose, letting navigation override it would
 * make the persistence pointless: every link click would silently undo it.
 * Losing the panel is not losing orientation — see `resolveHighlightedSection`,
 * which keeps the rail's own highlight tracking the true current section
 * independent of whether its panel is open, so the reader is never left not
 * knowing where they are, only without the panel's list open.
 */
export function resolveOpenSection(
  routeSection: NavSectionId | null,
  pick: RailSectionPick | null,
  closed: boolean,
): NavSectionId | null {
  if (pick && pick.route === routeSection) return pick.section
  return closed ? null : routeSection
}

/**
 * Which section the rail should highlight as "you are here," independent of
 * whether that section's panel is currently open.
 *
 * Before persistence, `openSection` doubled as the highlight target, because
 * a close could not outlive its own route — the two only ever disagreed for
 * one render. Once `closed` can persist indefinitely, reusing `openSection`
 * for the highlight would leave every rail icon dark whenever the panel is
 * closed, which is exactly the "no cue where they are" problem the old
 * anti-stranding rule in `resolveOpenSection` existed to prevent.
 *
 * The fix is to fall back to `routeSection` whenever nothing is open, rather
 * than showing no highlight at all: closing the panel hides its contents, not
 * the reader's location. This is what makes the rail's own highlight, on its
 * own, enough orientation for the "closed and I followed a link into a
 * different section" case: the icon for the section you landed in lights up
 * exactly as it always did, only the list below it stays collapsed.
 *
 * When `openSection` names a section — because it is genuinely open, whether
 * that is the routed one or one the reader explicitly switched to while
 * standing still (open Knowledge from /tasks) — that is a more specific
 * answer than the plain route, so it wins.
 */
export function resolveHighlightedSection(
  routeSection: NavSectionId | null,
  openSection: NavSectionId | null,
): NavSectionId | null {
  return openSection ?? routeSection
}
