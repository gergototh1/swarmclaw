'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useWs } from '@/hooks/use-ws'
import { anchorPosition, isMountedAnchorPosition } from '@/lib/extension-page-nav'
import type { ExtensionPageDefinition } from '@/types/extension'

/** A page declared by an installed extension, tagged with the extension that owns it. */
export type ExtensionPage = ExtensionPageDefinition & { extensionId: string }

/**
 * Select the extension pages that belong in one nav slot.
 *
 * `view` is the built-in nav entry a page asked to sit after (an `AppView` value,
 * kept as a plain string here so extension positions never widen `AppView`), and
 * selects the pages anchored at exactly that view.
 *
 * Passing `null` selects the trailing slot, which takes every page that is not
 * anchored at one of `EXTENSION_NAV_ANCHORS`: pages with no position, pages that
 * asked for `end`, and pages whose anchor names a view the rail does not mount a
 * slot for (a typo, or a view that was later renamed). So a page can never fall
 * out of the rail entirely.
 *
 * The two slots only stay disjoint because the rail passes anchors from
 * `EXTENSION_NAV_ANCHORS` and nothing else, which `ExtensionPagesAfter`'s prop
 * type enforces.
 */
export function splitPagesByPosition(pages: ExtensionPage[], view: string | null): ExtensionPage[] {
  if (view === null) {
    return pages.filter((p) => !isMountedAnchorPosition(p.position))
  }
  const wanted = anchorPosition(view)
  return pages.filter((p) => p.position === wanted)
}

export interface ExtensionPagesState {
  pages: ExtensionPage[]
  /**
   * False only until the first fetch settles. An empty list and a list that has
   * not arrived yet are the same value, so anything that decides a page does not
   * exist (the `/x/<slug>` route, which would otherwise flash "no such page" on
   * every load) has to wait for this. The rail does not care: it renders nothing
   * either way. Stays true across later refreshes, so a websocket-driven reload
   * never blanks a page that is already mounted.
   */
  loaded: boolean
}

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPagesState(): ExtensionPagesState {
  const [state, setState] = useState<ExtensionPagesState>({ pages: [], loaded: false })

  const refresh = useCallback(() => {
    api<ExtensionPage[]>('GET', '/extensions/ui?type=pages')
      .then((list) => { setState({ pages: Array.isArray(list) ? list : [], loaded: true }) })
      // A failed fetch still counts as settled: retrying forever behind a spinner
      // hides the failure, and the next extensions event refreshes anyway.
      .catch(() => { setState((prev) => ({ pages: prev.pages, loaded: true })) })
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useWs('extensions', refresh)

  return state
}

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPages(): ExtensionPage[] {
  return useExtensionPagesState().pages
}
