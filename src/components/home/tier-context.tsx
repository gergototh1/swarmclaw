'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { OPERATIONS_PULSE_KINDS } from '@/lib/home/pulse-partition'
import { OperationsPulsePanel } from '@/components/operations/operations-pulse-panel'
import CostTrendChart from '@/components/home/cost-trend-chart'
import { AdvancedSettingsSection } from '@/components/shared/advanced-settings-section'
import { SectionHeader } from '@/components/ui/section-header'
import type { AppNotification } from '@/types'

const SOFT_NOTICE_DOT: Record<AppNotification['type'], string> = {
  info: 'bg-sky-400',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  // Unused here -- unlinked errors are promoted to Tier 1 -- but keeping the
  // map exhaustive over every AppNotification type means a fifth type added
  // to the union is a compile error here instead of a silently uncolored dot.
  error: 'bg-red-400',
}

export function TierContext({ todayCost, costTrend }: {
  todayCost: number
  costTrend: { cost: number; bucket: string }[]
}) {
  const navigateTo = useNavigate()
  const agents = useAppStore((s) => s.agents)
  const notifications = useAppStore((s) => s.notifications)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const [open, setOpen] = useState(false)

  const pinned = Object.values(agents).filter((a) => a.pinned)
  const softNotices = notifications.filter(
    (n) => !n.read && !n.entityId && (n.type === 'warning' || n.type === 'info' || n.type === 'success'),
  )

  const openAgent = async (id: string) => {
    await setCurrentAgent(id)
    navigateTo('agents')
  }

  return (
    <>
      {pinned.length > 0 && (
        <section className="mb-6 rounded-lg border border-line-subtle bg-surface p-5 sm:p-6">
          <SectionHeader label="Pinned agents" />
          <div className="flex flex-wrap gap-2">
            {pinned.map((agent) => (
              <button
                key={agent.id}
                onClick={() => void openAgent(agent.id)}
                className="rounded-md border border-line-subtle bg-layer-1 px-3 py-2 text-[12px] font-600 text-text
                  transition-colors hover:bg-layer-2 cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                {agent.name}
              </button>
            ))}
          </div>
        </section>
      )}

      <AdvancedSettingsSection
        variant="card"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        title="Details"
        description="Operations health and today's spend, out of the way until you need them."
        summary={`$${todayCost.toFixed(2)} spent today`}
      >
        <div>
          <OperationsPulsePanel className="!py-0 mb-6" kinds={OPERATIONS_PULSE_KINDS} />

          {/* Unlinked warning/info/success notices live here; unlinked errors
              are promoted to Tier 1 so nothing urgent hides behind the
              collapse. Between the two filters, every AppNotification type is
              now claimed by exactly one tier. */}
          {softNotices.length > 0 && (
            <div className="mb-8 flex flex-col gap-1">
              {softNotices.map((n) => (
                <div key={n.id} className="flex items-center gap-2.5 rounded-md px-3 py-2">
                  <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${SOFT_NOTICE_DOT[n.type]}`} />
                  <span className="text-[12px] font-600 text-text">{n.title}</span>
                  {n.message && <span className="truncate text-[11px] text-text-3">{n.message}</span>}
                </div>
              ))}
            </div>
          )}

          {costTrend.length > 1 && <CostTrendChart costTrend={costTrend} />}
        </div>
      </AdvancedSettingsSection>
    </>
  )
}
