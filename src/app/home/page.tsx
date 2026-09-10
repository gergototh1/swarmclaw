'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { HomeLaunchpad } from '@/components/home/home-launchpad'
import { useMountedRef } from '@/hooks/use-mounted-ref'
import { api } from '@/lib/app/api-client'
import { useNavigate } from '@/lib/app/navigation'
import { safeStorageGet, safeStorageRemove } from '@/lib/app/safe-storage'
import { DEFAULT_BUILDER_ROUTE, deriveHomeMode, HOME_LAUNCHPAD_AFTER_SETUP_KEY } from '@/lib/home-launchpad'
import { RouteTabs } from '@/components/shared/route-tabs'
import { MainContent } from '@/components/layout/main-content'
import { PageLoader } from '@/components/ui/page-loader'
import { TierAct } from '@/components/home/tier-act'
import { TierLive } from '@/components/home/tier-live'
import { TierContext } from '@/components/home/tier-context'
import { HOME_TABS } from './home-tabs'

export default function HomePage() {
  const router = useRouter()
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const tasks = useAppStore((s) => s.tasks)
  const connectors = useAppStore((s) => s.connectors)
  const schedules = useAppStore((s) => s.schedules)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const navigateTo = useNavigate()
  const [todayCost, setTodayCost] = useState(0)
  const [costTrend, setCostTrend] = useState<{ cost: number; bucket: string }[]>([])
  const [pageReady, setPageReady] = useState(false)
  const [launchpadFlag, setLaunchpadFlag] = useState(false)
  const launchpadFlagConsumedRef = useRef(false)
  const mountedRef = useMountedRef()

  useEffect(() => {
    if (launchpadFlagConsumedRef.current) return
    const hasFlag = safeStorageGet(HOME_LAUNCHPAD_AFTER_SETUP_KEY) === '1'
    if (!hasFlag) return
    launchpadFlagConsumedRef.current = true
    setLaunchpadFlag(true)
    safeStorageRemove(HOME_LAUNCHPAD_AFTER_SETUP_KEY)
  }, [])

  const allAgents = Object.values(agents).filter((a) => !a.trashedAt)
  const firstAgent = allAgents[0] || null

  // Quick stats
  const agentCount = allAgents.length
  const sessionCount = Object.keys(sessions).length
  const allTasks = Object.values(tasks)
  const totalTaskCount = allTasks.length
  const allConnectors = Object.values(connectors)
  const connectorCount = allConnectors.length
  const scheduleCount = Object.keys(schedules).length

  // Load data on mount
  useEffect(() => {
    let cancelled = false
    void loadSchedules()
    const connectorTimer = window.setTimeout(() => {
      if (!cancelled) void loadConnectors()
    }, 1200)
    api<{ records: Array<{ estimatedCost: number }>; timeSeries: Array<{ cost: number; bucket: string }> }>('GET', '/usage?range=7d')
      .then((data) => {
        if (cancelled || !mountedRef.current) return
        const series = (data.timeSeries || []).map((pt: { cost: number; bucket?: string }) => ({ cost: pt.cost, bucket: pt.bucket || '' }))
        setCostTrend(series)
        const todayBucket = new Date().toISOString().slice(0, 10)
        const todayPt = series.find((pt) => pt.bucket === todayBucket)
        setTodayCost(todayPt?.cost || 0)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled && mountedRef.current) setPageReady(true) })
    return () => {
      cancelled = true
      window.clearTimeout(connectorTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountedRef])

  if (!pageReady) {
    return (
      <MainContent>
        <RouteTabs tabs={HOME_TABS} active="home" />
        <PageLoader label="Loading dashboard..." />
      </MainContent>
    )
  }

  const homeMode = deriveHomeMode({
    hasLaunchpadFlag: launchpadFlag,
    agentCount,
    sessionCount,
    taskCount: totalTaskCount,
    scheduleCount,
    connectorCount,
    todayCost,
  })

  const openFirstAgent = () => {
    if (firstAgent) {
      navigateTo('agents', firstAgent.id)
      return
    }
    navigateTo('agents')
  }

  const openBuilder = () => {
    router.push(DEFAULT_BUILDER_ROUTE)
  }

  const openMissionTemplate = (templateId: string) => {
    router.push(`/missions?template=${encodeURIComponent(templateId)}`)
  }

  if (homeMode === 'launchpad') {
    return (
      <MainContent>
        <RouteTabs tabs={HOME_TABS} active="home" />
        <div className="flex-1 overflow-y-auto">
          <HomeLaunchpad
            firstAgent={firstAgent}
            agentCount={agentCount}
            sessionCount={sessionCount}
            taskCount={totalTaskCount}
            scheduleCount={scheduleCount}
            connectorCount={connectorCount}
            todayCost={todayCost}
            onOpenFirstAgent={openFirstAgent}
            onOpenProtocols={() => navigateTo('protocols')}
            onOpenBuilder={openBuilder}
            onOpenConnectors={() => navigateTo('connectors')}
            onOpenUsage={() => navigateTo('usage')}
            onRunEvalSuite={() => navigateTo('quality')}
            onReviewApprovals={() => navigateTo('quality')}
            onInspectFailedRuns={() => navigateTo('quality')}
            onStartReleaseQaMission={() => openMissionTemplate('release-candidate-qa')}
            onStartLaunchSprintMission={() => openMissionTemplate('launch-week-growth-sprint')}
            onStartCostAuditMission={() => openMissionTemplate('agent-cost-audit')}
            onStartConnectorSmokeMission={() => openMissionTemplate('connector-smoke-test')}
          />
        </div>
      </MainContent>
    )
  }

  return (
    <MainContent>
      <RouteTabs tabs={HOME_TABS} active="home" />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[800px] mx-auto px-6 py-10">
          <TierAct />
          <TierLive />
          <TierContext todayCost={todayCost} costTrend={costTrend} />
        </div>
      </div>
    </MainContent>
  )
}
