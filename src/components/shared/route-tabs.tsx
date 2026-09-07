'use client'

import Link from 'next/link'

export interface RouteTab {
  key: string
  label: string
  href: string
}

/**
 * A tab strip whose tabs are real links.
 *
 * Route-backed rather than local state on purpose: every tab here replaced a
 * standalone route, so each one has to stay linkable and survive a reload.
 */
export function RouteTabs({ tabs, active }: { tabs: readonly RouteTab[]; active: string }) {
  return (
    <div className="flex items-center gap-1 px-6 border-b border-line-subtle shrink-0">
      {tabs.map((tab) => {
        const on = tab.key === active
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={on ? 'page' : undefined}
            className={`relative px-3 py-2.5 text-[12px] rounded-t-sm transition-colors ${
              on ? 'text-accent-bright font-600' : 'text-fg-3 hover:text-fg-2'
            }`}
          >
            {tab.label}
            {on && <span className="absolute left-2 right-2 -bottom-px h-0.5 rounded-sm bg-accent-bright" />}
          </Link>
        )
      })}
    </div>
  )
}
