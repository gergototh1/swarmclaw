interface Props {
  children: React.ReactNode
  className?: string
}

export function SectionLabel({ children, className = '' }: Props) {
  return (
    <label className={`block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.03em] mb-3 ${className}`}>
      {children}
    </label>
  )
}
