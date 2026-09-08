import { cn } from '@/lib/utils'

/**
 * The one "how many are in this bucket" tile.
 *
 * Two surfaces had built their own and they agreed on nothing: the task board
 * used an 11px radius on the layer-1 overlay with the label as a tinted chip
 * and a 24px number, the schedule console an 18px radius on the card surface
 * with a plain label and a 26px number. Side by side they read as two
 * different applications, which is what they were.
 *
 * The colour is the bigger change. The task board painted all four tiles from
 * the red family -- red-300, rose-400, red-400, orange-400 -- so four buckets
 * that mean different things arrived as one wash of alarm, and none of those
 * four is a status colour this app defines. Here the number takes the ordinary
 * text colour and `tone` is opt-in, for the one or two buckets whose count
 * genuinely means something is wrong.
 *
 * Not the same thing as ui/stat-card.tsx, which is a passive metric with a
 * hint and a trend. This one is a filter you can press.
 */
interface CountTileProps {
  label: string
  value: number
  /** What the second line says. Usually differs when the count is zero. */
  caption?: string
  /** Opt in only where a non-zero count genuinely means trouble. */
  tone?: 'default' | 'danger' | 'accent'
  selected?: boolean
  onClick?: () => void
  className?: string
}

const TONES: Record<NonNullable<CountTileProps['tone']>, string> = {
  default: 'text-text',
  danger: 'text-danger',
  accent: 'text-accent-bright',
}

export function CountTile({
  label,
  value,
  caption,
  tone = 'default',
  selected,
  onClick,
  className,
}: CountTileProps) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      {...(onClick ? { onClick, type: 'button' as const } : {})}
      className={cn(
        'rounded-lg border px-4 py-4 text-left transition-colors',
        // Selection moves one step up the ladder and brightens the rule. There
        // is no shadow and no scale: this design has no lift.
        selected ? 'border-line-default bg-surface-2' : 'border-line-subtle bg-surface',
        onClick && 'cursor-pointer hover:bg-surface-2',
        className,
      )}
      style={{ fontFamily: 'inherit' }}
    >
      <div className="text-[11px] font-600 tracking-[0.01em] text-text-3">{label}</div>
      <div className={cn('mt-2 font-display text-[26px] font-700 tracking-[-0.02em]', TONES[tone])}>
        {value}
      </div>
      {caption && <p className="mt-1 text-[11px] text-text-3">{caption}</p>}
    </Tag>
  )
}
