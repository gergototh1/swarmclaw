'use client'

import { useAppStore } from '@/stores/use-app-store'
import { PageHeader } from '@/components/layout/page-header'
import { ScheduleConsole } from '@/components/schedules/schedule-console'

export default function SchedulesPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <PageHeader
        title="Schedules"
        createLabel="Schedule"
        onNew={() => useAppStore.getState().setScheduleSheetOpen(true)}
      />
      <ScheduleConsole />
    </div>
  )
}
