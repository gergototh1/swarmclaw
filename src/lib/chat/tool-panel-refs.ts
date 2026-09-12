import type { MessageToolEvent } from '@/types'
import type { ExtensionToolPanel } from '@/types/extension'

/**
 * Cards for the things an assistant message's tools produced that an
 * extension can open in a panel.
 *
 * The host knows nothing about what a "doc" is. An extension declares, in
 * `ui.toolPanels`, which of its tools produce something openable, and the tool
 * says what it produced by putting `panel: { id, title }` in its answer. This
 * only matches the two up. A tool answer from before an extension added
 * `panel` still gets a card when it carries a string `id`, titled with the
 * panel's label.
 */
export interface ToolPanelRef {
  extensionId: string
  panelId: string
  refId: string
  title: string
  icon?: string
  entry: string
  css?: string
}

/**
 * A CLI provider records an MCP tool as `mcp__<server>__<tool>`; the
 * declaration names the bare tool, because the server name is whatever the
 * operator typed when registering it.
 */
export function bareToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const cut = name.indexOf('__', 5)
  return cut === -1 ? name : name.slice(cut + 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refOf(output: string | undefined): { id: string; title?: string } | null {
  if (typeof output !== 'string' || output.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.error) return null
  const panel = parsed.panel
  if (isRecord(panel) && typeof panel.id === 'string' && panel.id !== '') {
    return { id: panel.id, title: typeof panel.title === 'string' && panel.title.trim() !== '' ? panel.title : undefined }
  }
  if (typeof parsed.id === 'string' && parsed.id !== '') return { id: parsed.id }
  return null
}

export function findToolPanelRefs(
  toolEvents: readonly MessageToolEvent[] | undefined,
  panels: readonly ExtensionToolPanel[],
): ToolPanelRef[] {
  if (!toolEvents?.length || panels.length === 0) return []
  const byTool = new Map<string, ExtensionToolPanel>()
  for (const panel of panels) {
    for (const tool of panel.tools) if (!byTool.has(tool)) byTool.set(tool, panel)
  }
  const found = new Map<string, ToolPanelRef>()
  for (const event of toolEvents) {
    if (event.error) continue
    const panel = byTool.get(bareToolName(event.name))
    if (!panel) continue
    const ref = refOf(event.output)
    if (!ref) continue
    const key = `${panel.extensionId}\u0000${panel.id}\u0000${ref.id}`
    const previous = found.get(key)
    found.set(key, {
      extensionId: panel.extensionId,
      panelId: panel.id,
      refId: ref.id,
      title: ref.title ?? previous?.title ?? panel.label,
      ...(panel.icon ? { icon: panel.icon } : {}),
      entry: panel.entry,
      ...(panel.css ? { css: panel.css } : {}),
    })
  }
  return [...found.values()]
}
