'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { LiveQuerySync } from '@/components/layout/live-query-sync'
import { ReplyNotifier } from '@/components/layout/reply-notifier'
import { createAppQueryClient } from '@/lib/query/client'

export function AppQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createAppQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <LiveQuerySync />
      <ReplyNotifier />
      {children}
    </QueryClientProvider>
  )
}
