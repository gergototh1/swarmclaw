import type { AppView } from '@/types'
import type { RecentItem } from '@/lib/app/recent-items'
import { NAV_SECTIONS, sectionForView } from '@/lib/app/nav-sections'

export interface ResolvedRecentItem {
  view: AppView
  id: string | null
  label: string
}

export interface RecentLabelLookups {
  agentNames: Record<string, string>
  sessionTitles: Record<string, string>
  chatroomNames: Record<string, string>
}

/** Fallback names for views the rail reaches through a section, not a row. */
const VIEW_LABELS: Partial<Record<AppView, string>> = {
  home: 'Home',
  conversations: 'Chat',
  org_chart: 'Org Chart',
  mcp_servers: 'MCP Servers',
  swarmfeed: 'Feed',
}

function titleCase(view: AppView): string {
  return view.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function viewLabel(view: AppView): string {
  const direct = VIEW_LABELS[view]
  if (direct) return direct
  const section = NAV_SECTIONS.find((s) => s.direct === view)
  if (section) return section.label
  return titleCase(view)
}

function entityLabel(item: RecentItem, lookups: RecentLabelLookups): string | null {
  if (!item.id) return null
  if (item.view === 'agents') return lookups.agentNames[item.id] ?? null
  if (item.view === 'conversations') return lookups.sessionTitles[item.id] ?? null
  if (item.view === 'chatrooms') return lookups.chatroomNames[item.id] ?? null
  return null
}

/**
 * Turn stored targets into rows fit to render.
 *
 * An entry whose entity has since been deleted resolves to nothing and is
 * dropped, which is what keeps the list from offering a click into a 404. The
 * limit applies after that filter, so a deleted entity does not eat a slot.
 *
 * An entry with a view that is not registered in the navigation is also
 * dropped, protecting against corrupted or stale localStorage entries.
 */
export function resolveRecentItems(
  items: readonly RecentItem[],
  lookups: RecentLabelLookups,
  limit: number,
): ResolvedRecentItem[] {
  const out: ResolvedRecentItem[] = []
  for (const item of items) {
    if (out.length >= limit) break

    // Validate that the view is a real AppView registered in navigation
    if (sectionForView(item.view as AppView) === null) {
      continue
    }

    if (item.id) {
      const label = entityLabel(item, lookups)
      if (!label) continue
      out.push({ view: item.view as AppView, id: item.id, label })
      continue
    }
    out.push({ view: item.view as AppView, id: null, label: viewLabel(item.view as AppView) })
  }
  return out
}
