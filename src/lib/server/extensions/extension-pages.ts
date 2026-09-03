import type { ExtensionPageDefinition } from '@/types/extension'

const PATH_RE = /^\/x\/[a-z0-9][a-z0-9-]*$/
const REL_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9_./-]+\.(js|css)$/

export type PagesValidation =
  | { ok: true; pages: ExtensionPageDefinition[] }
  | { ok: false; error: string }

export function validateExtensionPages(
  raw: unknown,
  takenPaths: Set<string>,
): PagesValidation {
  if (raw == null) return { ok: true, pages: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'ui.pages must be an array' }
  const seen = new Set<string>()
  const pages: ExtensionPageDefinition[] = []
  for (const p of raw as Array<Record<string, unknown>>) {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    const label = typeof p.label === 'string' ? p.label.trim() : ''
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    const entry = typeof p.entry === 'string' ? p.entry.trim() : ''
    const css = typeof p.css === 'string' ? p.css.trim() : undefined
    if (!id || !label) return { ok: false, error: 'ui.pages entries need id and label' }
    if (!PATH_RE.test(path)) return { ok: false, error: `ui.pages path "${path}" must be /x/<slug>` }
    if (seen.has(path)) return { ok: false, error: `ui.pages path "${path}" declared twice` }
    if (takenPaths.has(path)) return { ok: false, error: `ui.pages path "${path}" is already taken by another extension` }
    if (!REL_RE.test(entry)) return { ok: false, error: `ui.pages entry "${entry}" must be a relative .js path without ".."` }
    if (css !== undefined && !REL_RE.test(css)) return { ok: false, error: `ui.pages css "${css}" must be a relative .css path without ".."` }
    seen.add(path)
    pages.push({
      id,
      label,
      path,
      entry,
      css,
      icon: typeof p.icon === 'string' ? p.icon : undefined,
      position: typeof p.position === 'string' ? p.position : 'end',
    })
  }
  return { ok: true, pages }
}
