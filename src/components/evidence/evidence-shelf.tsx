'use client'

import { ExternalLink, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EvidenceArtifact } from '@/types'

function formatKind(kind: EvidenceArtifact['kind']): string {
  return kind.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function formatTimestamp(at: number | null | undefined): string {
  if (!at) return ''
  return new Date(at).toLocaleString()
}

export function EvidenceShelf({
  artifacts,
  loading = false,
  title = 'Evidence Shelf',
  emptyLabel = 'No linked evidence yet.',
  className,
}: {
  artifacts: EvidenceArtifact[]
  loading?: boolean
  title?: string
  emptyLabel?: string
  className?: string
}) {
  return (
    <section className={cn('section-band -line-subtle', className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-700 tracking-[0.03em] text-text-3">{title}</div>
          <div className="mt-1 text-[12px] text-text-3">{artifacts.length} linked artifact{artifacts.length === 1 ? '' : 's'}</div>
        </div>
      </div>
      {loading ? (
        <div className="rounded-sm border border-line-subtle bg-layer-1 px-3 py-3 text-[11px] text-text-3">
          Loading evidence...
        </div>
      ) : artifacts.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line-default bg-layer-1 px-3 py-3 text-[11px] text-text-3">
          {emptyLabel}
        </div>
      ) : (
        <div className="flex max-h-[280px] flex-col gap-2 overflow-y-auto">
          {artifacts.map((artifact) => {
            const href = artifact.url || artifact.href || null
            const content = (
              <>
                <span className="flex min-w-0 flex-1 items-start gap-2">
                  <FileText size={14} className="mt-0.5 shrink-0 text-text-3" />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[12px] font-700 text-text">{artifact.title}</span>
                      <span className="rounded-full bg-layer-2 px-2 py-0.5 text-[9px] font-700 tracking-[0.03em] text-text-3">
                        {formatKind(artifact.kind)}
                      </span>
                    </span>
                    {(artifact.description || artifact.preview) && (
                      <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-text-3">
                        {artifact.description || artifact.preview}
                      </span>
                    )}
                    <span className="mt-1 block text-[10px] text-text-3">
                      {artifact.source.label || artifact.source.id}
                      {artifact.createdAt ? ` - ${formatTimestamp(artifact.createdAt)}` : ''}
                    </span>
                  </span>
                </span>
                {href && <ExternalLink size={13} className="mt-0.5 shrink-0 text-text-3" />}
              </>
            )
            return href ? (
              <a
                key={`${artifact.kind}:${artifact.id}`}
                href={href}
                target={href.startsWith('/api/') || href.startsWith('http') ? '_blank' : undefined}
                rel={href.startsWith('http') ? 'noreferrer' : undefined}
                className="flex items-start gap-2 rounded-md border border-line-subtle bg-layer-1 px-3 py-2.5 transition-colors hover:bg-layer-2"
              >
                {content}
              </a>
            ) : (
              <div
                key={`${artifact.kind}:${artifact.id}`}
                className="flex items-start gap-2 rounded-md border border-line-subtle bg-layer-1 px-3 py-2.5"
              >
                {content}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
