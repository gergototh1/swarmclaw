'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { useState, useSyncExternalStore } from 'react'
import { LiveQuerySync } from '@/components/layout/live-query-sync'
import { ReplyNotifier } from '@/components/layout/reply-notifier'
import { tabIdFromWindow } from '@/lib/app/shell-mode'
import { createAppQueryClient } from '@/lib/query/client'

const noSubscription = () => () => {}

export function AppQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createAppQueryClient)
  // The host window notifies once; a tab doing it as well would ring once per
  // open tab. Server snapshot false, so hydration matches.
  const inTab = useSyncExternalStore(noSubscription, () => tabIdFromWindow(window) !== null, () => false)

  return (
    <QueryClientProvider client={queryClient}>
      <LiveQuerySync />
      {!inTab && <ReplyNotifier />}
      {children}
    </QueryClientProvider>
  )
}
