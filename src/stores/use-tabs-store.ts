'use client'

import { create } from 'zustand'
import { safeStorageGetJson, safeStorageSet } from '@/lib/app/safe-storage'
import { initialTabsState, landOnUrl, newTabId, tabsStateFromStorage, type TabsState } from '@/lib/app/tabs'

export const TABS_STORAGE_KEY = 'sc_tabs_v1'

interface TabsStore {
  state: TabsState | null
  /** Restores the stored tabs and lands on the URL the host window was loaded at. */
  hydrate: (url: string) => void
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
  hydrate: (url) => {
    if (get().state) return
    const stored = tabsStateFromStorage(safeStorageGetJson<unknown>(TABS_STORAGE_KEY, null))
    const state = stored ? landOnUrl(stored, url, newTabId) : initialTabsState(newTabId, url)
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
