import { useProtocolTemplatesQuery } from '@/features/protocols/queries'
import { useRouter } from 'next/navigation'
import type { ProtocolTemplate } from '@/types'

type Props = {
  templates?: ProtocolTemplate[]
}

export function TemplateGallery({ templates: providedTemplates }: Props) {
  const { data: queriedTemplates } = useProtocolTemplatesQuery({ enabled: !providedTemplates })
  const router = useRouter()
  const templates = providedTemplates ?? queriedTemplates ?? []

  const builtInTemplates = templates.filter((t) => t.builtIn)
  const customTemplates = templates.filter((t) => !t.builtIn)

  const renderCard = (template: ProtocolTemplate) => (
    <button
      key={template.id}
      onClick={() => router.push(`/protocols/builder/${template.id}`)}
      className="rounded-lg border border-line-subtle bg-layer-1 p-4 text-left transition-all hover:border-accent-bright/20 hover:bg-layer-2 cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-[14px] font-display font-700 text-text">{template.name}</div>
        <span className="rounded-full border border-line-default bg-layer-2 px-2 py-1 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3">
          {template.builtIn ? 'Built-in' : 'Custom'}
        </span>
      </div>
      <div className="mt-2 text-[12px] leading-relaxed text-text-3 line-clamp-3">
        {template.description}
      </div>
      {template.tags && template.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {template.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="rounded-full border border-line-default bg-layer-1 px-2 py-1 text-[10px] text-text-2">
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  )

  return (
    <div className="space-y-4">
      {builtInTemplates.length > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-700 uppercase tracking-[0.12em] text-text-3">Built-in</h4>
          <div className="grid gap-3 md:grid-cols-2">{builtInTemplates.map(renderCard)}</div>
        </div>
      )}
      {customTemplates.length > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-700 uppercase tracking-[0.12em] text-text-3">Custom</h4>
          <div className="grid gap-3 md:grid-cols-2">{customTemplates.map(renderCard)}</div>
        </div>
      )}
    </div>
  )
}
