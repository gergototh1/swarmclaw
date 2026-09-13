'use client'

import { usePathname } from 'next/navigation'
import {
  Activity, Bell, Bot, Boxes, Calendar, Compass, Database, FileText, Folder, Gauge,
  Globe, Hash, Heart, Inbox, Layers, LineChart, Lightbulb, Link2, List, Mail, MapPin,
  MessageSquare, Newspaper, Puzzle, Radar, Rss, Search, Send, Settings, Shield,
  Sparkles, Star, Tag, Terminal, TrendingUp, Users, Workflow, Zap,
} from 'lucide-react'
import { ExtensionNavItem } from '@/components/layout/nav-item'
import { pagesForSection, useExtensionPages, type ExtensionPage } from '@/hooks/use-extension-pages'
import type { NavSectionId } from '@/lib/app/nav-sections'
import type { PanelIntent } from '@/lib/app/tab-protocol'
import type { ExtensionPageIconName } from '@/lib/extension-page-nav'

/**
 * The components behind the icon names an extension may declare.
 *
 * The key space itself lives in `@/lib/extension-page-nav` as
 * `EXTENSION_PAGE_ICON_NAMES` so server code and docs can read it without
 * importing this client module; typing the map by that union keeps the two in
 * lockstep. Names outside it fall back to `Puzzle`.
 */
const PAGE_ICONS: Record<ExtensionPageIconName, React.ComponentType<{ size?: number }>> = {
  Activity, Bell, Bot, Boxes, Calendar, Compass, Database, FileText, Folder, Gauge,
  Globe, Hash, Heart, Inbox, Layers, LineChart, Lightbulb, Link2, List, Mail, MapPin,
  MessageSquare, Newspaper, Puzzle, Radar, Rss, Search, Send, Settings, Shield,
  Sparkles, Star, Tag, Terminal, TrendingUp, Users, Workflow, Zap,
}

/** Widened view of `PAGE_ICONS`, so an unknown extension-supplied name is a lookup miss, not a type error. */
const ICON_BY_NAME: Record<string, React.ComponentType<{ size?: number }> | undefined> = PAGE_ICONS

export function PageIcon({ name, size = 18 }: { name?: string; size?: number }) {
  const Icon = (name && ICON_BY_NAME[name]) || Puzzle
  return <Icon size={size} />
}

function ExtensionPageLinks({ pages, onNavigate, panel }: {
  pages: ExtensionPage[]
  onNavigate?: () => void
  panel?: PanelIntent
}) {
  const pathname = usePathname()
  return (
    <>
      {pages.map((p) => (
        <ExtensionNavItem
          key={`${p.extensionId}:${p.id}`}
          href={p.path}
          label={p.label}
          isActive={pathname === p.path || pathname.startsWith(`${p.path}/`)}
          onClick={onNavigate}
          panel={panel}
        >
          <PageIcon name={p.icon} />
        </ExtensionNavItem>
      ))}
    </>
  )
}

/**
 * The extension pages of one rail section, above that section's built-in entries.
 *
 * Renders nothing when the section has none, hairline included — a section with
 * no extension pages must not open with a rule across the top of its list.
 *
 * Placement comes entirely from `pagesForSection`, which asks
 * `resolvePageSection` where each page belongs. No anchor list, and no reader
 * of the legacy `position` field: the rail used to mount exactly one slot
 * ('after:tasks') and sweep everything else into a trailing group below every
 * built-in entry, which is how the CRM page ended up at the very bottom of the
 * rail for no reason its own extension declared.
 */
export function ExtensionPagesForSection({ section, onNavigate, panel }: {
  section: NavSectionId
  onNavigate?: () => void
  /** Passed to each link for the tab host; see `ExtensionNavItem`. */
  panel?: PanelIntent
}) {
  const pages = pagesForSection(useExtensionPages(), section)
  if (pages.length === 0) return null
  return (
    <>
      <ExtensionPageLinks pages={pages} onNavigate={onNavigate} panel={panel} />
      <div className="my-2 mx-2 h-px bg-line-subtle" />
    </>
  )
}
