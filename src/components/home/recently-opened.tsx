'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useNavigate } from '@/lib/app/navigation'
import { readRecentItems, RECENT_ITEMS_KEY, type RecentItem } from '@/lib/app/recent-items'
import { safeStorageGet } from '@/lib/app/safe-storage'
import { resolveRecentItems } from '@/lib/home/recent-item-label'
import { SectionHeader } from '@/components/ui/section-header'

const VISIBLE = 8

const EMPTY_ITEMS: RecentItem[] = []

/*
 * `readRecentItems()` returns a fresh array reference on every call, which
 * `useSyncExternalStore` cannot tolerate (it would read as "changed" forever
 * and never settle). Cache by the raw localStorage string instead, and only
 * re-parse when that string actually moved.
 */
let cachedRaw: string | null | undefined
let cachedSnapshot: RecentItem[] = EMPTY_ITEMS

function getRecentItemsSnapshot(): RecentItem[] {
  const raw = safeStorageGet(RECENT_ITEMS_KEY)
  if (raw === cachedRaw) return cachedSnapshot
  cachedRaw = raw
  cachedSnapshot = readRecentItems()
  return cachedSnapshot
}

function getRecentItemsServerSnapshot(): RecentItem[] {
  return EMPTY_ITEMS
}

/*
 * There is no in-tab event for a localStorage write (the `storage` event only
 * fires in OTHER tabs), so this subscription only catches cross-tab changes.
 * Same-tab freshness instead comes from `useSyncExternalStore` re-invoking
 * `getSnapshot` on every render — this component remounts whenever the route
 * returns to /home, which is exactly when a same-tab write needs picking up.
 */
function subscribeToRecentItems(onStoreChange: () => void): () => void {
  window.addEventListener('storage', onStoreChange)
  return () => window.removeEventListener('storage', onStoreChange)
}

export function RecentlyOpened() {
  const navigateTo = useNavigate()
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const loadChatrooms = useChatroomStore((s) => s.loadChatrooms)
  const items = useSyncExternalStore(subscribeToRecentItems, getRecentItemsSnapshot, getRecentItemsServerSnapshot)

  /*
   * Unlike `agents` and `sessions` (hydrated app-wide by useAppBootstrap),
   * `chatrooms` in the store is only populated by visiting /chatrooms — there
   * is no global loader for it. Without this, a chatroom the user opened
   * would silently vanish from this list forever, because
   * `resolveRecentItems` drops any entry it cannot name. Fetch once per
   * mount, and skip it if another view already hydrated the store this
   * session (the payload includes full message history, so it is not free).
   */
  const chatroomsFetchedRef = useRef(false)
  useEffect(() => {
    if (chatroomsFetchedRef.current) return
    chatroomsFetchedRef.current = true
    if (Object.keys(useChatroomStore.getState().chatrooms).length > 0) return
    void loadChatrooms()
  }, [loadChatrooms])

  const resolved = resolveRecentItems(
    items,
    {
      agentNames: Object.fromEntries(Object.values(agents).map((a) => [a.id, a.name])),
      sessionTitles: Object.fromEntries(Object.values(sessions).map((s) => [s.id, s.name || 'Untitled chat'])),
      chatroomNames: Object.fromEntries(Object.values(chatrooms).map((c) => [c.id, c.name])),
    },
    VISIBLE,
  )

  if (resolved.length === 0) return null

  return (
    <section className="mb-8">
      <SectionHeader label="Recently opened" />
      <div className="flex flex-wrap gap-2">
        {resolved.map((item) => (
          <button
            key={`${item.view}:${item.id ?? ''}`}
            onClick={() => navigateTo(item.view, item.id)}
            className="rounded-md border border-line-subtle bg-layer-1 px-3 py-2 text-[12px] font-600 text-text
              transition-colors hover:bg-layer-2 cursor-pointer"
            style={{ fontFamily: 'inherit' }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </section>
  )
}
