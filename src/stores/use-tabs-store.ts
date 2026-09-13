'use client'

import { create } from 'zustand'
import { safeStorageGetJson, safeStorageSet } from '@/lib/app/safe-storage'
import { newTabId, restoreTabsState, type TabsState } from '@/lib/app/tabs'

export const TABS_STORAGE_KEY = 'sc_tabs_v1'

interface TabsStore {
  state: TabsState | null
  /**
   * Restores the stored tabs and lands on the address the host window was
   * loaded at (`href`), or on Home when that is not a tabbable app path.
   */
  hydrate: (href: string, origin: string) => void
  apply: (change: (state: TabsState) => TabsState) => void
}

function persist(state: TabsState): void {
  safeStorageSet(TABS_STORAGE_KEY, JSON.stringify(state))
}

/**
 * Tabs, per device, like a browser's. Stored on every change; a stored value
 * that does not parse starts over with one Home tab rather than half-reading.
 */
export const useTabsStore = create<TabsStore>((set, get) => ({
  state: null,
  hydrate: (href, origin) => {
    if (get().state) return
    const state = restoreTabsState(safeStorageGetJson<unknown>(TABS_STORAGE_KEY, null), href, origin, newTabId)
    persist(state)
    set({ state })
  },
  apply: (change) => {
    const current = get().state
    if (!current) return
    const next = change(current)
    if (next === current) return
    persist(next)
    set({ state: next })
  },
}))
