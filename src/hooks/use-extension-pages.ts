'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useWs } from '@/hooks/use-ws'
import type { ExtensionPageDefinition } from '@/types/extension'

/** A page declared by an installed extension, tagged with the extension that owns it. */
export type ExtensionPage = ExtensionPageDefinition & { extensionId: string }

const AFTER_PREFIX = 'after:'

/**
 * Select the extension pages that belong in one nav slot.
 *
 * `view` is the built-in nav entry a page asked to sit after (an `AppView` value,
 * kept as a plain string here so extension positions never widen `AppView`).
 * Passing `null` selects the trailing slot: every page that did not ask for a
 * specific anchor, plus every page whose anchor is unrecognised, so a page can
 * never fall out of the rail entirely.
 */
export function splitPagesByPosition(pages: ExtensionPage[], view: string | null): ExtensionPage[] {
  if (view === null) {
    return pages.filter((p) => !p.position || !p.position.startsWith(AFTER_PREFIX))
  }
  return pages.filter((p) => p.position === `${AFTER_PREFIX}${view}`)
}

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPages(): ExtensionPage[] {
  const [pages, setPages] = useState<ExtensionPage[]>([])

  const refresh = useCallback(() => {
    api<ExtensionPage[]>('GET', '/extensions/ui?type=pages')
      .then((list) => { if (Array.isArray(list)) setPages(list) })
      .catch(() => {})
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useWs('extensions', refresh)

  return pages
}
