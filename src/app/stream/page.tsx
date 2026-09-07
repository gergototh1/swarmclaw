'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { RouteTabs } from '@/components/shared/route-tabs'
import { MainContent } from '@/components/layout/main-content'
import { PageLoader } from '@/components/ui/page-loader'
import { RunList } from '@/components/runs/run-list'
import { LogList } from '@/components/logs/log-list'
import { ActivityList } from '@/components/operations/activity-list'
import { STREAM_TABS, streamTabFromSearch } from './stream-tabs'

function StreamBody() {
  const tab = streamTabFromSearch(useSearchParams().get('tab'))
  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
        <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] flex-1">Stream</h2>
      </div>
      <RouteTabs tabs={STREAM_TABS} active={tab} />
      {tab === 'runs' && <RunList />}
      {tab === 'activity' && <ActivityList />}
      {tab === 'logs' && <LogList />}
    </div>
  )
}

export default function StreamPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <MainContent>
      <Suspense fallback={<PageLoader />}>
        <StreamBody />
      </Suspense>
    </MainContent>
  )
}
