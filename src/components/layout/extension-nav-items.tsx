'use client'

import { usePathname } from 'next/navigation'
import {
  Activity, Bell, Bot, Boxes, Calendar, Compass, Database, FileText, Folder, Gauge,
  Globe, Hash, Heart, Inbox, Layers, LineChart, Lightbulb, Link2, List, Mail, MapPin,
  MessageSquare, Newspaper, Puzzle, Radar, Rss, Search, Send, Settings, Shield,
  Sparkles, Star, Tag, Terminal, TrendingUp, Users, Workflow, Zap,
} from 'lucide-react'
import { ExtensionNavItem } from '@/components/layout/nav-item'
import { splitPagesByPosition, useExtensionPages, type ExtensionPage } from '@/hooks/use-extension-pages'
import type { ExtensionNavAnchor, ExtensionPageIconName } from '@/lib/extension-page-nav'

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

function PageIcon({ name }: { name?: string }) {
  const Icon = (name && ICON_BY_NAME[name]) || Puzzle
  return <Icon size={18} />
}

function ExtensionPageLinks({ pages, expanded, onNavigate }: {
  pages: ExtensionPage[]
  expanded: boolean
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  return (
    <>
      {pages.map((p) => (
        <ExtensionNavItem
          key={`${p.extensionId}:${p.id}`}
          href={p.path}
          label={p.label}
          expanded={expanded}
          isActive={pathname === p.path || pathname.startsWith(`${p.path}/`)}
          onClick={onNavigate}
        >
          <PageIcon name={p.icon} />
        </ExtensionNavItem>
      ))}
    </>
  )
}

/**
 * Extension-contributed rail entries anchored directly after a built-in entry.
 *
 * `view` names that built-in entry, or `null` for the trailing slot. It is limited
 * to `EXTENSION_NAV_ANCHORS` so the rail cannot mount a slot the trailing group
 * does not know to skip, which would render those pages twice. An extension path
 * is still never an `AppView` and must not be widened into one.
 */
export function ExtensionPagesAfter({ view, expanded, onNavigate }: {
  view: ExtensionNavAnchor | null
  expanded: boolean
  onNavigate?: () => void
}) {
  const pages = useExtensionPages()
  const slice = splitPagesByPosition(pages, view)
  if (slice.length === 0) return null
  return <ExtensionPageLinks pages={slice} expanded={expanded} onNavigate={onNavigate} />
}

/**
 * Trailing rail group for every extension page the rail does not anchor elsewhere.
 *
 * That covers pages with no position, pages that asked for `end`, and pages whose
 * anchor names a view outside `EXTENSION_NAV_ANCHORS`. Renders the same group
 * chrome as the built-in sections, and nothing at all when no extension
 * contributes a page.
 */
export function ExtensionPagesEndGroup({ expanded, onNavigate }: {
  expanded: boolean
  onNavigate?: () => void
}) {
  const pages = useExtensionPages()
  const slice = splitPagesByPosition(pages, null)
  if (slice.length === 0) return null
  return (
    <div className={`flex flex-col gap-0.5 ${expanded ? '' : 'items-center'}`}>
      {expanded ? (
        <div className="px-3 pb-1 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/45">Extension Pages</div>
      ) : (
        <div className="my-1 h-px w-6 bg-white/[0.06]" />
      )}
      <ExtensionPageLinks pages={slice} expanded={expanded} onNavigate={onNavigate} />
    </div>
  )
}
