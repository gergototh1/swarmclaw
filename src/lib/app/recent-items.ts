'use client'

import type { AppView } from '@/types'
import { parseViewPath } from './navigation'
import { safeStorageGetJson, safeStorageSet } from './safe-storage'

/**
 * What the user opened, most recent first.
 *
 * Deliberately stores no label. The display name is resolved at render time
 * from the store, so a renamed agent shows its new name and a deleted one
 * drops out of the list on its own rather than offering a click into a 404.
 */
export interface RecentItem {
  view: AppView
  id: string | null
  at: number
}

export const RECENT_ITEMS_KEY = 'sc_recent_items_v1'
export const RECENT_ITEMS_CAP = 20

function sameTarget(a: RecentItem, b: RecentItem): boolean {
  return a.view === b.view && a.id === b.id
}

/** Pure MRU push: newest first, deduplicated by target, capped. */
export function pushRecentItem(list: readonly RecentItem[], next: RecentItem): RecentItem[] {
  return [next, ...list.filter((item) => !sameTarget(item, next))].slice(0, RECENT_ITEMS_CAP)
}

export function readRecentItems(): RecentItem[] {
  const raw = safeStorageGetJson<RecentItem[]>(RECENT_ITEMS_KEY, [])
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is RecentItem =>
    !!item
    && typeof item.view === 'string'
    && (item.id === null || typeof item.id === 'string')
    && typeof item.at === 'number',
  )
}

export function recordRecentItem(view: AppView, id: string | null = null, at: number = Date.now()): void {
  const next = pushRecentItem(readRecentItems(), { view, id, at })
  safeStorageSet(RECENT_ITEMS_KEY, JSON.stringify(next))
}

/** Record whatever view a pathname addresses. Unknown paths are ignored. */
export function recordRecentPath(pathname: string, at: number = Date.now()): void {
  const parsed = parseViewPath(pathname)
  if (!parsed) return
  recordRecentItem(parsed.view, parsed.id, at)
}
