'use client'

import { useMemo, useState } from 'react'
import type { MissionTemplate, MissionTemplateCategory } from '@/types'

const CATEGORY_LABELS: Record<MissionTemplateCategory, string> = {
  research: 'Research',
  communication: 'Communication',
  monitoring: 'Monitoring',
  productivity: 'Productivity',
  support: 'Support',
}

interface Props {
  templates: MissionTemplate[]
  onInstall: (template: MissionTemplate) => void
}

export function MissionTemplateGallery({ templates, onInstall }: Props) {
  const [category, setCategory] = useState<'all' | MissionTemplateCategory>('all')

  const categories = useMemo(() => {
    const seen = new Set<MissionTemplateCategory>()
    for (const template of templates) seen.add(template.category)
    return Array.from(seen)
  }, [templates])

  const filtered = useMemo(() => {
    if (category === 'all') return templates
    return templates.filter((t) => t.category === category)
  }, [templates, category])

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-700 text-text">Start from a template</h2>
        <p className="text-[12px] text-text-3 mt-1">
          Pre-wired goals, budgets, and report schedules. Tweak anything before you install.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <FilterChip active={category === 'all'} onClick={() => setCategory('all')} label="All" />
        {categories.map((c) => (
          <FilterChip
            key={c}
            active={category === c}
            onClick={() => setCategory(c)}
            label={CATEGORY_LABELS[c]}
          />
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((template) => (
          <TemplateCard key={template.id} template={template} onInstall={() => onInstall(template)} />
        ))}
      </div>
    </div>
  )
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[11px] font-600 px-2.5 py-1 rounded-full border transition-colors ${
        active
          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
          : 'border-line-default bg-layer-1 text-text-3 hover:border-line-strong hover:text-text'
      }`}
    >
      {label}
    </button>
  )
}

function TemplateCard({ template, onInstall }: { template: MissionTemplate; onInstall: () => void }) {
  return (
    <button
      type="button"
      onClick={onInstall}
      className="text-left group flex flex-col gap-3 rounded-md border border-line-subtle bg-layer-1 px-4 py-4 transition-all hover:border-line-strong hover:bg-layer-2"
    >
      <div className="flex items-start gap-3">
        <span className="text-[22px] leading-none" aria-hidden>{template.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-700 text-text">{template.name}</div>
          <div className="text-[10px] uppercase tracking-wide text-text-3 mt-0.5">
            {CATEGORY_LABELS[template.category]}
          </div>
        </div>
      </div>
      <div className="text-[12px] text-text-3 leading-[1.55] line-clamp-3">{template.description}</div>
      <div className="flex items-center justify-between mt-auto">
        <div className="flex flex-wrap gap-1">
          {template.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[10px] text-text-3 px-1.5 py-0.5 rounded-xs border border-line-subtle bg-layer-1"
            >
              {tag}
            </span>
          ))}
        </div>
        <span className="text-[11px] font-600 text-emerald-300 group-hover:text-emerald-200">
          Install →
        </span>
      </div>
    </button>
  )
}
