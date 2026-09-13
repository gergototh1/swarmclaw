'use client'

import { useState, type KeyboardEvent } from 'react'
import { Home, Plus, X } from 'lucide-react'
import { PageIcon } from '@/components/layout/extension-nav-items'
import { SECTION_ICONS } from '@/components/layout/sidebar-rail'
import { NAV_SECTIONS } from '@/lib/app/nav-sections'
import type { TabLabel } from '@/lib/app/tab-label'
import type { Tab } from '@/lib/app/tabs'

function TabIcon({ label }: { label: TabLabel | undefined }) {
  if (label?.extensionIcon) return <PageIcon name={label.extensionIcon} size={13} />
  const section = NAV_SECTIONS.find((s) => s.id === label?.sectionId)
  const Icon = section ? SECTION_ICONS[section.icon] : Home
  return <Icon size={13} />
}

export function TabStrip({ tabs, activeId, labels, failedIds, onActivate, onClose, onNew, onMove }: {
  tabs: readonly Tab[]
  activeId: string
  labels: ReadonlyMap<string, TabLabel>
  failedIds: ReadonlySet<string>
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onMove: (id: string, toIndex: number) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>, id: string, index: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onActivate(id)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
      onActivate(next.id)
    }
  }

  return (
    <div className="flex items-end gap-1 px-2 pt-1.5 border-b border-line-subtle bg-raised shrink-0 min-w-0">
      <div role="tablist" aria-label="Open tabs" className="flex items-end gap-1 overflow-x-auto min-w-0">
        {tabs.map((tab, index) => {
          const label = labels.get(tab.id)
          const title = label?.title ?? tab.url
          const active = tab.id === activeId
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={title}
              draggable
              onDragStart={(e) => { setDragId(tab.id); e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={(e) => { if (dragId) e.preventDefault() }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dragId !== tab.id) onMove(dragId, index)
                setDragId(null)
              }}
              onDragEnd={() => setDragId(null)}
              onClick={() => onActivate(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id) } }}
              onKeyDown={(e) => onTabKey(e, tab.id, index)}
              className={`group flex items-center gap-1.5 min-w-[110px] max-w-[220px] pl-2.5 pr-1 py-1.5 rounded-t-md text-[12.5px] cursor-pointer select-none border border-b-0 ${
                active ? 'bg-bg text-text border-line-subtle' : 'bg-transparent text-text-3 border-transparent hover:bg-layer-2 hover:text-text'
              }`}
            >
              <span className="shrink-0 flex items-center"><TabIcon label={label} /></span>
              <span className="truncate flex-1">{title}</span>
              {failedIds.has(tab.id) && <span className="shrink-0 text-danger text-[11px]" aria-label="This tab did not load">!</span>}
              <button
                type="button"
                aria-label={`Close ${title}`}
                onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
                className="shrink-0 w-5 h-5 rounded-sm flex items-center justify-center border-none bg-transparent text-text-3 hover:text-text hover:bg-layer-2 cursor-pointer"
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        onClick={onNew}
        className="shrink-0 mb-1 w-7 h-7 rounded-sm flex items-center justify-center border-none bg-transparent text-text-3 hover:text-text hover:bg-layer-2 cursor-pointer"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
