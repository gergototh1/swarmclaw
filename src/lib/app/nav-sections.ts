import type { AppView } from '@/types'

export type NavSectionId = 'home' | 'chat' | 'work' | 'knowledge' | 'connect' | 'operations' | 'settings'

/**
 * The lucide icon names sidebar-rail.tsx's `SECTION_ICONS` maps to a
 * component. Kept as a plain string union here, not an import from
 * lucide-react, so this stays a pure data module that server code and tests
 * can import without pulling a client-only icon library in behind it; the
 * union is what turns a typo in a section's `icon` into a compile error
 * instead of a silent fallback to the Home icon.
 */
export type NavSectionIconName = 'Home' | 'MessageSquare' | 'Briefcase' | 'BookOpen' | 'Link2' | 'Activity' | 'Settings'

export interface NavSection {
  id: NavSectionId
  label: string
  icon: NavSectionIconName
  /** Views listed in this section's panel, in panel order. */
  views: readonly AppView[]
  /** A section that navigates straight to one view instead of opening a panel. */
  direct?: AppView
  /** Rendered below the rail's spacer rather than in the main run. */
  footer?: boolean
}

/**
 * The rail, in one place.
 *
 * This replaced twenty-six hardcoded <NavItem> elements in a 32 KB
 * sidebar-rail.tsx. Adding a view is a line here; the completeness test in
 * nav-sections.test.ts is what stops a new view from silently having no way
 * to reach it.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  { id: 'home', label: 'Home', icon: 'Home', views: [], direct: 'home' },
  { id: 'chat', label: 'Chat', icon: 'MessageSquare', views: ['agents', 'org_chart', 'inbox', 'chatrooms', 'protocols'] },
  { id: 'work', label: 'Work', icon: 'Briefcase', views: ['tasks', 'missions', 'schedules', 'projects'] },
  { id: 'knowledge', label: 'Knowledge', icon: 'BookOpen', views: ['memory', 'knowledge', 'skills'] },
  { id: 'connect', label: 'Connect', icon: 'Link2', views: ['connectors', 'mcp_servers', 'extensions', 'webhooks', 'providers', 'marketplace'] },
  { id: 'operations', label: 'Operations', icon: 'Activity', views: ['stream', 'usage', 'quality', 'autonomy'] },
  { id: 'settings', label: 'Settings', icon: 'Settings', views: ['settings', 'vault'], footer: true },
]

export const NAV_SECTION_IDS: readonly NavSectionId[] = NAV_SECTIONS.map((s) => s.id)

/**
 * Views that deliberately have no rail entry, each with the reason.
 *
 * The completeness test subtracts these; anything else missing from
 * NAV_SECTIONS fails it, so a view cannot lose its way into the app by
 * accident.
 */
export const NAV_EXEMPT_VIEWS: Record<string, string> = {
  swarmfeed: 'Reached as the Home page’s second tab (src/app/home/home-tabs.ts), not as its own rail entry.',
}

/** The section a view belongs to, or null when the view is exempt. */
export function sectionForView(view: AppView): NavSectionId | null {
  for (const section of NAV_SECTIONS) {
    if (section.direct === view || section.views.includes(view)) return section.id
  }
  return null
}
