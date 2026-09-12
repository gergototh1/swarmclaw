import type { ExtensionPage } from '@/hooks/use-extension-pages'

/** One palette destination an extension page contributes. */
export interface PaletteNavTarget {
  id: string
  label: string
  description: string
  keywords: string[]
  href: string
}

/**
 * Extension pages as ⌘K destinations.
 *
 * The palette listed only built-in views, so a page reachable from the rail
 * alone became unreachable the moment the rail stopped showing it.
 */
export function extensionPageNavTargets(pages: readonly ExtensionPage[]): PaletteNavTarget[] {
  return [...pages]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((p) => ({
      id: `nav:x:${p.extensionId}:${p.id}`,
      label: `Go to ${p.label}`,
      description: 'Extension page',
      keywords: [p.label, p.extensionId, p.id],
      href: p.path,
    }))
}
