'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface ComposerShellProps {
  children: ReactNode
  footer: ReactNode
  top?: ReactNode
  hint?: ReactNode
  className?: string
  shellClassName?: string
  hintClassName?: string
}

export function ComposerShell({
  children,
  footer,
  top,
  hint,
  className,
  shellClassName,
  hintClassName,
}: ComposerShellProps) {
  return (
    <div className={className}>
      <div
        className={cn(
          'glass rounded-lg overflow-hidden shadow-[0_4px_32px_rgba(0,0,0,0.3)] focus-within:border-border-focus focus-within:shadow-[0_0_0_3px_var(--color-accent-glow)] transition-all duration-300',
          shellClassName,
        )}
      >
        {top}
        {children}
        {footer}
      </div>
      {hint ? (
        <p className={cn('mt-1.5 px-1 text-[10px] text-text-3 select-none', hintClassName)}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}
