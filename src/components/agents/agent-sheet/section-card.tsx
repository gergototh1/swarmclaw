'use client'

export function SectionCard({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`mb-8 rounded-lg border border-line-subtle bg-surface/70 p-5 sm:p-6 ${className}`}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-[17px] font-700 tracking-[-0.02em] text-text">{title}</h3>
          {description && (
            <p className="mt-1 text-[13px] leading-[1.6] text-text-3">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * Shown when a tab's every section is hidden — usually for this agent's
 * provider (Behavior, Memory, Tools, Advanced all gate on `workerOnly` and
 * similar provider checks), but Network also gates its note on `!editing`, an
 * agent-exists condition, not a provider one. The old single scroll simply
 * had nothing there, and a tab has to say so rather than open on a blank
 * panel.
 */
export function TabEmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line-subtle bg-layer-1 px-5 py-6 text-[13px] leading-[1.6] text-text-3">
      {children}
    </div>
  )
}
