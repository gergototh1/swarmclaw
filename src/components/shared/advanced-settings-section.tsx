'use client'

import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

interface Props {
 open: boolean
 onToggle: () => void
 summary?: string | null
 badges?: string[]
 /** Heading text. Defaults to the settings wording this started life with. */
 title?: string
 /** Subhead under the title. Defaults to the settings wording this started life with. */
 description?: string
 /**
  * 'band' is the settings pages: a flattened run of sections divided by hair
  * rules, never a card. 'card' matches the surrounding block idiom instead --
  * what the home page needs so this sits on the same edges as the cards above
  * it rather than spanning past them.
  */
 variant?: 'band' | 'card'
 children: ReactNode
}

export function AdvancedSettingsSection({
 open,
 onToggle,
 summary,
 badges = [],
 title = 'Advanced Settings',
 description = 'Power-user controls for routing, runtime behavior, and expert overrides.',
 variant = 'band',
 children,
}: Props) {
 return (
 <section className={variant === 'card'
  ? 'mb-6 overflow-hidden rounded-lg border border-line-subtle bg-surface'
  : 'section-band mb-8 '}>
 <button
 type="button"
 onClick={onToggle}
 className={`flex w-full items-start justify-between gap-4 rounded-lg bg-transparent text-left transition-all hover:bg-layer-1 ${variant === 'card' ? 'px-4 py-4 sm:px-5' : 'px-5 py-5 sm:px-6'}`}
 style={{ fontFamily: 'inherit' }}
 >
 <div className="min-w-0">
 <div className="flex flex-wrap items-center gap-2">
 <h3 className="font-display text-[17px] font-700 tracking-[-0.02em] text-text">{title}</h3>
 {summary && (
 <span className="rounded-full border border-line-default bg-layer-1 px-2.5 py-1 text-[10px] font-700 tracking-[0.03em] text-text-3">
 {summary}
 </span>
 )}
 </div>
 <p className="mt-1 text-[13px] leading-[1.6] text-text-3">
 {description}
 </p>
 {badges.length > 0 && (
 <div className="mt-3 flex flex-wrap gap-2">
 {badges.slice(0, 5).map((badge) => (
 <span
 key={badge}
 className="rounded-sm border border-line-default bg-layer-1 px-2.5 py-1 text-[11px] font-600 text-text-3"
 >
 {badge}
 </span>
 ))}
 </div>
 )}
 </div>
 <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line-subtle bg-layer-1 text-text-3">
 <ChevronDown className={`size-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
 </span>
 </button>
 {open && (
 <div className={`border-t border-line-subtle ${variant === 'card' ? 'px-4 pb-6 pt-6 sm:px-5' : 'px-5 pb-5 pt-4 sm:px-6 sm:pb-6'}`}>
 {children}
 </div>
 )}
 </section>
 )
}
