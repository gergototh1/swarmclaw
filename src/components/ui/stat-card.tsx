import { cn } from '@/lib/utils'
import { HintTip } from '@/components/shared/hint-tip'

interface StatCardProps {
  label: string
  value: string | number
  accent?: boolean
  hint?: string
  trend?: React.ReactNode
  index?: number
  className?: string
}

export function StatCard({ label, value, accent, hint, trend, index = 0, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'px-4 py-3 rounded-md bg-layer-1 border border-line-subtle hover:bg-layer-2 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-default',
        className,
      )}
      style={{
        animation: 'spring-in 0.6s var(--ease-spring) both',
        animationDelay: `${0.1 + index * 0.05}s`,
      }}
    >
      <p className="text-[11px] font-600 text-text-3 tracking-[0.03em] mb-1 flex items-center gap-1.5">
        {label}
        {hint && <HintTip text={hint} />}
      </p>
      <div className="flex items-end gap-2">
        <p className={cn('font-display text-[20px] font-700 tracking-[-0.02em]', accent ? 'text-accent-bright' : 'text-text')}>
          {value}
        </p>
        {trend}
      </div>
    </div>
  )
}
