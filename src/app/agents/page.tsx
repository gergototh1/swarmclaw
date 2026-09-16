'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { useMediaQuery } from '@/hooks/use-media-query'
import { getViewPath } from '@/lib/app/navigation'
import { AgentList } from '@/components/agents/agent-list'
import { EmptyState } from '@/components/shared/empty-state'
import { PageLoader } from '@/components/ui/page-loader'

export default function AgentsPage() {
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const router = useRouter()
  const agents = useAppStore((s) => s.agents)
  const appSettings = useAppStore((s) => s.appSettings)
  const redirected = useRef(false)

  const defaultAgent = appSettings.defaultAgentId && agents[appSettings.defaultAgentId]
    ? agents[appSettings.defaultAgentId]
    : Object.values(agents)[0] || null

  // On desktop, auto-redirect to the default (or first) agent's settings instead of showing a placeholder
  useEffect(() => {
    if (!isDesktop || redirected.current) return
    if (defaultAgent) {
      redirected.current = true
      router.replace(getViewPath('agents', defaultAgent.id))
    }
  }, [isDesktop, defaultAgent, router])

  if (!isDesktop) return <AgentList />

  if (Object.keys(agents).length === 0) {
    return (
      <EmptyState
        icon={
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        }
        title="No agents yet"
        subtitle="Create your first agent"
        action={{ label: '+ New Agent', onClick: () => router.push('/agents/new') }}
      />
    )
  }

  // Brief flash while redirecting
  return <PageLoader />
}
