import { parseViewPath } from '@/lib/app/navigation'
import { sectionForView, type NavSectionId } from '@/lib/app/nav-sections'
import { VIEW_LABELS } from '@/lib/app/view-constants'
import { resolvePageSection } from '@/lib/extension-page-nav'
import type { AppView } from '@/types'

export interface TabLabelLookups {
  agentNames: Record<string, string>
  sessionTitles: Record<string, string>
  chatroomNames: Record<string, string>
  extensionPages: ReadonlyArray<{ path: string; label: string; icon?: string; section?: string }>
}

export interface TabLabel {
  title: string
  sectionId: NavSectionId | null
  extensionIcon: string | null
}

function entityName(view: AppView, id: string, lookups: TabLabelLookups): string | null {
  if (view === 'agents') return lookups.agentNames[id] ?? null
  if (view === 'conversations') return lookups.sessionTitles[id] ?? null
  if (view === 'chatrooms') return lookups.chatroomNames[id] ?? null
  return null
}

/**
 * What a tab is called, resolved at render time from its URL.
 *
 * Nothing is stored but the raw title an extension page reported: an agent
 * renamed since shows its new name, and a deleted one falls back to the view's
 * name instead of a broken label. A raw title only applies on an extension
 * page -- a built-in view is always named from its URL.
 */
export function tabLabel(url: string, rawTitle: string | null, lookups: TabLabelLookups): TabLabel {
  const pathname = url.split(/[?#]/)[0] || '/'
  const page = lookups.extensionPages
    .filter((p) => pathname === p.path || pathname.startsWith(`${p.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const raw = rawTitle?.trim() || null
  if (page) return { title: raw ?? page.label, sectionId: resolvePageSection(page), extensionIcon: page.icon ?? null }
  const parsed = parseViewPath(pathname)
  if (!parsed) return { title: raw ?? pathname, sectionId: null, extensionIcon: null }
  const entity = parsed.id ? entityName(parsed.view, parsed.id, lookups) : null
  return { title: entity ?? VIEW_LABELS[parsed.view], sectionId: sectionForView(parsed.view), extensionIcon: null }
}
