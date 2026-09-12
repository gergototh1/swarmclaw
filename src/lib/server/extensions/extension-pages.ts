import type { ExtensionPageDefinition, ExtensionToolPanelDefinition } from '@/types/extension'

const PATH_RE = /^\/x\/[a-z0-9][a-z0-9-]*$/

/**
 * `entry` and `css` are workspace-relative and must start with `dist/`, because
 * `/api/extensions/<id>/assets/...` only ever serves out of `<workspace>/dist`.
 * Anything else (a bare `index.js`, a `build/` output dir) would validate but
 * could never be fetched, so it is rejected up front instead of 404ing later.
 */
const DIST_REL_RE = /^dist\/(?!\.)(?!.*\.\.)[A-Za-z0-9_./-]+\.(js|css)$/

const DIST_REL_HINT = 'must be a workspace-relative path starting with "dist/" (e.g. "dist/index.js"), with no ".." segments'

export type PagesValidation =
  | { ok: true; pages: ExtensionPageDefinition[] }
  | { ok: false; error: string }

export function validateExtensionPages(
  raw: unknown,
  takenPaths: Set<string>,
): PagesValidation {
  if (raw == null) return { ok: true, pages: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'ui.pages must be an array' }
  const seenPaths = new Set<string>()
  // Page ids only have to be unique per extension: the browser registry keys
  // pages on "<extensionId>:<pageId>", so two extensions may both ship a `main`.
  // Within one extension a repeated id is unresolvable, so it is rejected here.
  const seenIds = new Set<string>()
  const pages: ExtensionPageDefinition[] = []
  for (const p of raw as Array<Record<string, unknown>>) {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    const label = typeof p.label === 'string' ? p.label.trim() : ''
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    const entry = typeof p.entry === 'string' ? p.entry.trim() : ''
    const cssRaw = typeof p.css === 'string' ? p.css.trim() : undefined
    const css = cssRaw === '' ? undefined : cssRaw
    if (!id || !label) return { ok: false, error: 'ui.pages entries need id and label' }
    if (seenIds.has(id)) return { ok: false, error: `ui.pages id "${id}" declared twice by this extension` }
    if (!PATH_RE.test(path)) return { ok: false, error: `ui.pages path "${path}" must be /x/<slug>` }
    if (seenPaths.has(path)) return { ok: false, error: `ui.pages path "${path}" declared twice` }
    if (takenPaths.has(path)) return { ok: false, error: `ui.pages path "${path}" is already taken by another extension` }
    if (!DIST_REL_RE.test(entry)) return { ok: false, error: `ui.pages entry "${entry}" ${DIST_REL_HINT}` }
    if (css !== undefined && !DIST_REL_RE.test(css)) return { ok: false, error: `ui.pages css "${css}" ${DIST_REL_HINT}` }
    seenIds.add(id)
    seenPaths.add(path)
    pages.push({
      id,
      label,
      path,
      entry,
      css,
      icon: typeof p.icon === 'string' ? p.icon : undefined,
      section: typeof p.section === 'string' && p.section.trim() !== '' ? p.section.trim() : undefined,
      order: typeof p.order === 'number' && Number.isFinite(p.order) ? p.order : undefined,
      position: typeof p.position === 'string' ? p.position : 'end',
    })
  }
  return { ok: true, pages }
}

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export type ToolPanelsValidation =
  | { ok: true; panels: ExtensionToolPanelDefinition[] }
  | { ok: false; error: string }

export function validateExtensionToolPanels(raw: unknown): ToolPanelsValidation {
  if (raw == null) return { ok: true, panels: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'ui.toolPanels must be an array' }
  const seenIds = new Set<string>()
  const panels: ExtensionToolPanelDefinition[] = []
  for (const p of raw as Array<Record<string, unknown>>) {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    const label = typeof p.label === 'string' ? p.label.trim() : ''
    const entry = typeof p.entry === 'string' ? p.entry.trim() : ''
    const cssRaw = typeof p.css === 'string' ? p.css.trim() : undefined
    const css = cssRaw === '' ? undefined : cssRaw
    if (!id || !label) return { ok: false, error: 'ui.toolPanels entries need id and label' }
    if (seenIds.has(id)) return { ok: false, error: `ui.toolPanels id "${id}" declared twice by this extension` }
    if (!Array.isArray(p.tools) || p.tools.length === 0) {
      return { ok: false, error: `ui.toolPanels "${id}" needs a non-empty tools list` }
    }
    const tools: string[] = []
    for (const t of p.tools) {
      if (typeof t !== 'string' || !TOOL_NAME_RE.test(t)) {
        return { ok: false, error: `ui.toolPanels "${id}" tool name ${JSON.stringify(t)} is not a bare tool name` }
      }
      tools.push(t)
    }
    if (!DIST_REL_RE.test(entry)) return { ok: false, error: `ui.toolPanels entry "${entry}" ${DIST_REL_HINT}` }
    if (css !== undefined && !DIST_REL_RE.test(css)) return { ok: false, error: `ui.toolPanels css "${css}" ${DIST_REL_HINT}` }
    seenIds.add(id)
    panels.push({
      id,
      label,
      ...(typeof p.icon === 'string' ? { icon: p.icon } : {}),
      tools,
      entry,
      ...(css !== undefined ? { css } : {}),
    })
  }
  return { ok: true, panels }
}
