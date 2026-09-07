'use client'

import type { ProviderDiagnosticStep } from '@/types'

const STATUS_CLASSES: Record<ProviderDiagnosticStep['status'], string> = {
  pass: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
  fail: 'border-red-500/25 bg-red-500/10 text-red-300',
}

const STATUS_LABELS: Record<ProviderDiagnosticStep['status'], string> = {
  pass: 'Pass',
  warn: 'Warn',
  fail: 'Fail',
}

export function ProviderDiagnosticsList({
  diagnostics,
  className = '',
}: {
  diagnostics?: ProviderDiagnosticStep[] | null
  className?: string
}) {
  if (!diagnostics?.length) return null

  return (
    <div className={`mt-3 border-t border-line-subtle pt-3 ${className}`}>
      <div className="mb-2 text-[11px] font-700 uppercase tracking-[0.1em] text-text-3/70">
        Diagnostics
      </div>
      <ol className="space-y-2">
        {diagnostics.map((step) => (
          <li key={step.id} className="grid gap-1 text-left sm:grid-cols-[64px_minmax(0,1fr)] sm:gap-3">
            <div>
              <span className={`inline-flex min-w-[54px] items-center justify-center rounded-[999px] border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.08em] ${STATUS_CLASSES[step.status]}`}>
                {STATUS_LABELS[step.status]}
              </span>
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12px] font-650 text-text-2">{step.label}</span>
                {typeof step.durationMs === 'number' && (
                  <span className="text-[11px] text-text-3">{step.durationMs} ms</span>
                )}
              </div>
              {step.target && (
                <div className="mt-0.5 break-all font-mono text-[11px] text-text-3">{step.target}</div>
              )}
              {step.detail && (
                <div className="mt-0.5 text-[11px] leading-relaxed text-text-3">{step.detail}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
