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

/**
 * Icons an extension may name in its page declaration.
 *
 * Deliberately a curated list rather than lucide's full `icons` barrel: the rail
 * ships on every route, and the barrel would pull the whole icon set into that
 * bundle. Unknown names fall back to `Puzzle`.
 */
const PAGE_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  Activity, Bell, Bot, Boxes, Calendar, Compass, Database, FileText, Folder, Gauge,
  Globe, Hash, Heart, Inbox, Layers, LineChart, Lightbulb, Link2, List, Mail, MapPin,
  MessageSquare, Newspaper, Puzzle, Radar, Rss, Search, Send, Settings, Shield,
  Sparkles, Star, Tag, Terminal, TrendingUp, Users, Workflow, Zap,
}

function PageIcon({ name }: { name?: string }) {
  const Icon = (name && PAGE_ICONS[name]) || Puzzle
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
 * `view` names that built-in entry, or `null` for the trailing slot. It is a plain
 * string on purpose: an extension path is not an `AppView` and must not be widened
 * into one.
 */
export function ExtensionPagesAfter({ view, expanded, onNavigate }: {
  view: string | null
  expanded: boolean
  onNavigate?: () => void
}) {
  const pages = useExtensionPages()
  const slice = splitPagesByPosition(pages, view)
  if (slice.length === 0) return null
  return <ExtensionPageLinks pages={slice} expanded={expanded} onNavigate={onNavigate} />
}

/**
 * Trailing rail group for extension pages that did not ask for an anchor.
 *
 * Renders the same group chrome as the built-in sections, and nothing at all when
 * no extension contributes a page.
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
