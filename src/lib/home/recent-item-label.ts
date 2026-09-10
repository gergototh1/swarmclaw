import type { AppView } from '@/types'
import type { RecentItem } from '@/lib/app/recent-items'
import { VIEW_LABELS } from '@/lib/app/view-constants'

export interface ResolvedRecentItem {
  view: AppView
  id: string | null
  label: string
}

export interface RecentLabelLookups {
  agentNames: Record<string, string>
  sessionTitles: Record<string, string>
  chatroomNames: Record<string, string>
  taskTitles: Record<string, string>
}

function viewLabel(view: AppView): string {
  return VIEW_LABELS[view]
}

function entityLabel(item: RecentItem, lookups: RecentLabelLookups): string | null {
  if (!item.id) return null
  if (item.view === 'agents') return lookups.agentNames[item.id] ?? null
  if (item.view === 'conversations') return lookups.sessionTitles[item.id] ?? null
  if (item.view === 'chatrooms') return lookups.chatroomNames[item.id] ?? null
  if (item.view === 'tasks') return lookups.taskTitles[item.id] ?? null
  return null
}

/**
 * Turn stored targets into rows fit to render.
 *
 * An entry whose entity has since been deleted resolves to nothing and is
 * dropped, which is what keeps the list from offering a click into a 404. The
 * limit applies after that filter, so a deleted entity does not eat a slot.
 *
 * An entry with a view that is not a valid AppView is also dropped, protecting
 * against corrupted or stale localStorage entries. Validity is determined by
 * checking against VIEW_LABELS, the exhaustive compiler-enforced map over all
 * AppView kinds, not by navigation registry membership (which could exempt views
 * that are still legitimate app surfaces).
 */
export function resolveRecentItems(
  items: readonly RecentItem[],
  lookups: RecentLabelLookups,
  limit: number,
): ResolvedRecentItem[] {
  const out: ResolvedRecentItem[] = []
  for (const item of items) {
    if (out.length >= limit) break

    // Validate that the view is a real AppView
    const view = item.view as AppView
    if (!(view in VIEW_LABELS)) {
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
