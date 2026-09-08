'use client'

import Link from 'next/link'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

export function RailTooltip({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}
        className="bg-raised border border-line-default text-text rounded-md px-3.5 py-2.5 max-w-[200px]">
        <div className="font-display text-[13px] font-600 mb-0.5">{label}</div>
        <div className="text-[11px] text-text-3 leading-[1.4]">{description}</div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Rail entry for a page contributed by an extension.
 *
 * Navigates to a raw `href` instead of an `AppView`, so extension paths never
 * have to be part of the `AppView` union. Only ever mounted inside a section's
 * indented list in the rail (`ExtensionPagesForSection`, called from
 * `SectionSubList` in sidebar-rail.tsx), which the rail draws only when it is
 * labelled — the 52px icon rail has no room for it — so this renders one row,
 * sized to match the built-in rows below it (`SectionSubList`'s own `<Link>`)
 * rather than the wider rail-button form.
 */
export function ExtensionNavItem({ href, label, isActive, onClick, children }: {
  href: string
  label: string
  isActive: boolean
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-sm text-[12.5px] transition-colors no-underline
        ${isActive
          ? 'bg-accent-soft text-accent-bright font-600'
          : 'text-text-2 hover:text-text hover:bg-layer-2'}`}
    >
      <span className="shrink-0 relative">{children}</span>
      <span className="truncate">{label}</span>
    </Link>
  )
}
