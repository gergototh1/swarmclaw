'use client'

import { useState, type KeyboardEvent, type MouseEvent } from 'react'
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

/**
 * The tab strip. Each entry is a presentational wrapper holding two sibling
 * buttons -- the `role="tab"` label and the close button -- so no interactive
 * element sits inside another. The wrapper carries the tab's look and the drag.
 */
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

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Option+Arrow is the host's next/previous tab command, run by its window
    // key listener; acting here as well would move two tabs.
    if (e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
    onActivate(next.id)
  }

  const closeOnMiddleClick = (e: MouseEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 1) return
    e.preventDefault()
    onClose(id)
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
              role="presentation"
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
              className={`group flex items-center min-w-[110px] max-w-[220px] pr-1 rounded-t-md text-[12.5px] select-none border border-b-0 ${
                active ? 'bg-bg text-text border-line-subtle' : 'bg-transparent text-text-3 border-transparent hover:bg-layer-2 hover:text-text'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onActivate(tab.id)}
                onAuxClick={(e) => closeOnMiddleClick(e, tab.id)}
                onKeyDown={(e) => onTabKey(e, index)}
                className="flex items-center gap-1.5 flex-1 min-w-0 pl-2.5 pr-1.5 py-1.5 bg-transparent border-none text-inherit text-[12.5px] text-left cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                <span className="shrink-0 flex items-center"><TabIcon label={label} /></span>
                <span className="truncate flex-1">{title}</span>
                {failedIds.has(tab.id) && <span className="shrink-0 text-danger text-[11px]" aria-label="This tab did not load">!</span>}
              </button>
              <button
                type="button"
                aria-label={`Close ${title}`}
                tabIndex={active ? 0 : -1}
                onClick={() => onClose(tab.id)}
                onAuxClick={(e) => closeOnMiddleClick(e, tab.id)}
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
