'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ExtensionPagesForSection } from '@/components/layout/extension-nav-items'
import { getViewPath } from '@/lib/app/navigation'
import { VIEW_LABELS } from '@/lib/app/view-constants'
import type { NavSection } from '@/lib/app/nav-sections'
import type { AppView } from '@/types'

/**
 * The second column: what is inside the section the rail has selected.
 *
 * Extension pages come first, above a hairline, because on this install they
 * are the surfaces the operator opens; the built-in entries follow.
 *
 * `isViewEnabled` is not decoration — /webhooks is switched off with the `http`
 * extension, and the old rail dropped its entry outright rather than offering a
 * link into a view that redirects straight back to /home. `onSelectView` is the
 * rail's own click handling, which decides whether the route's panel sidebar
 * opens; a bare Link here would leave `sidebarOpen` set from whatever the last
 * view wanted.
 */
export function NavSectionPanel({ section, isViewEnabled, badges, onSelectView, onExtensionNavigate }: {
  section: NavSection
  isViewEnabled: (view: AppView) => boolean
  badges?: Partial<Record<AppView, number>>
  onSelectView?: (view: AppView) => void
  onExtensionNavigate?: () => void
}) {
  const pathname = usePathname()
  return (
    <div className="w-[186px] min-w-0 bg-raised border-r border-line-subtle flex flex-col h-full min-h-0 overflow-y-auto overscroll-contain py-3 px-2.5">
      <h2 className="font-display text-[13px] font-600 text-fg-1 tracking-[-0.01em] px-2 pb-2.5">{section.label}</h2>
      <ExtensionPagesForSection section={section.id} onNavigate={onExtensionNavigate} />
      {section.views.filter(isViewEnabled).map((view) => {
        const href = getViewPath(view)
        const on = pathname === href || pathname.startsWith(`${href}/`)
        const badge = badges?.[view]
        return (
          <Link
            key={view}
            href={href}
            onClick={() => onSelectView?.(view)}
            aria-current={on ? 'page' : undefined}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-sm text-[11.5px] transition-colors no-underline ${
              on ? 'bg-accent-soft text-accent-bright font-600' : 'text-fg-2 hover:bg-layer-2 hover:text-fg-1'
            }`}
          >
            <span className="truncate">{VIEW_LABELS[view]}</span>
            {!!badge && (
              <span className="ml-auto shrink-0 min-w-[16px] h-[16px] rounded-full bg-amber-500 text-black text-[9px] font-700 flex items-center justify-center px-1">
                {badge}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
