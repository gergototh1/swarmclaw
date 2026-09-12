'use client'

import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  children: ReactNode
  /**
   * Where the menu positions itself.
   *
   * - `'viewport'` (default): `fixed top-12 right-3`, anchored to the corner
   *   of the viewport. This is the original, only behaviour every existing
   *   caller was built against, so it stays the default -- adding this prop
   *   must not move anyone's menu.
   * - `'trigger'`: `absolute right-0 top-[calc(100%+4px)]`, anchored to the
   *   nearest positioned ancestor instead -- typically a `position: relative`
   *   wrapper the caller puts around the button that opens the menu. Use this
   *   when the trigger itself can sit anywhere on the page (e.g. a middle
   *   column of a variable-width layout) so the menu tracks it instead of
   *   floating at a fixed screen corner.
   */
  anchor?: 'viewport' | 'trigger'
}

export function Dropdown({ open, onClose, children, anchor = 'viewport' }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open, onClose])

  if (!open) return null

  const positionClassName = anchor === 'trigger' ? 'absolute right-0 top-[calc(100%+4px)]' : 'fixed top-12 right-3'

  return (
    <div
      ref={ref}
      className={`${positionClassName} bg-raised border border-line-subtle rounded-md
        p-1.5 z-90 min-w-[200px]
        backdrop-blur-xl`}
      style={{ animation: 'fade-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)' }}
    >
      {children}
    </div>
  )
}

export function DropdownItem({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3.5 py-2.5 border-none bg-transparent text-[13px] font-600
        text-left cursor-pointer rounded-md transition-all duration-150
        hover:bg-layer-2 active:bg-layer-3
        ${danger ? 'text-danger' : 'text-text-2 hover:text-text'}`}
      style={{ fontFamily: 'inherit' }}
    >
      {children}
    </button>
  )
}

export function DropdownSep() {
  return <div className="h-px bg-layer-2 my-1 mx-2" />
}
