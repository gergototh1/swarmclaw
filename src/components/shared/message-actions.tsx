'use client'

import type { ReactNode, CSSProperties } from 'react'

/* ------------------------------------------------------------------ */
/*  MessageActions — hover-reveal container for message action buttons */
/* ------------------------------------------------------------------ */

interface MessageActionsProps {
  /** 'bubble' = below the message (agent chat), 'inline' = right side (chatroom) */
  layout: 'bubble' | 'inline'
  /** Alignment for bubble layout */
  align?: 'start' | 'end'
  /** Keep actions visible regardless of hover (e.g. when a picker is open) */
  forceVisible?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}

export function MessageActions({
  layout,
  align,
  forceVisible,
  className,
  style,
  children,
}: MessageActionsProps) {
  const base =
    layout === 'bubble'
      ? `flex items-center gap-1 mt-1.5 px-1 ${align === 'end' ? 'justify-end' : ''}`
      : 'relative shrink-0 mt-0.5 flex items-start gap-1'

  const hover = forceVisible
    ? 'opacity-100'
    : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all duration-200'

  const slide =
    layout === 'bubble' && !forceVisible
      ? 'translate-y-2 md:group-hover:translate-y-0'
      : ''

  return (
    <div className={`${base} ${hover} ${slide} ${className || ''}`.trim()} style={style}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  ActionButton — individual action button with two visual variants  */
/* ------------------------------------------------------------------ */

interface ActionButtonProps {
  onClick: () => void
  icon: ReactNode
  /** Text label (shown in ghost variant) */
  label?: string
  title?: string
  /** Active/highlighted state */
  active?: boolean
  /** Classes applied when active */
  activeClassName?: string
  /** 'ghost' = transparent text button (agent chat), 'outlined' = bordered icon-only (chatroom) */
  variant?: 'ghost' | 'outlined'
  className?: string
}

export function ActionButton({
  onClick,
  icon,
  label,
  title,
  active,
  activeClassName,
  variant = 'ghost',
  className,
}: ActionButtonProps) {
  if (variant === 'outlined') {
    return (
      <button
        onClick={onClick}
        className={`w-7 h-7 rounded-sm border border-line-subtle bg-layer-1 flex items-center justify-center hover:bg-layer-3 transition-all cursor-pointer ${active ? activeClassName || '' : ''} ${className || ''}`.trim()}
        title={title}
      >
        {icon}
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      aria-label={title}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-sm border-none bg-transparent text-[11px] font-600 text-text-3 cursor-pointer hover:text-text-2 hover:bg-layer-2 transition-all justify-center md:justify-start ${active ? activeClassName || '' : ''} ${className || ''}`.trim()}
      style={{ fontFamily: 'inherit' }}
    >
      {icon}
      {label}
    </button>
  )
}
