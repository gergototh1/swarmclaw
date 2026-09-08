import { cn } from '@/lib/utils'

interface FilterPillProps {
  label: string
  active?: boolean
  onClick: () => void
  className?: string
}

export function FilterPill({ label, active, onClick, className }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-sm text-[10px] font-700 uppercase tracking-[0.03em] border transition-all cursor-pointer bg-transparent',
        active
          ? 'bg-accent-soft border-accent-bright/15 text-accent-bright'
          : 'border-line-subtle text-text-3/70 hover:bg-layer-1 hover:text-text-2',
        className,
      )}
      style={{ fontFamily: 'inherit' }}
    >
      {label}
    </button>
  )
}
