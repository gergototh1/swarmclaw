'use client'

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { HintTip } from '@/components/shared/hint-tip'
import { inputClass } from '@/components/shared/form-styles'
import type { Connector, Mission, MissionReportFormat } from '@/types'
import { toast } from 'sonner'

const EDITABLE_STATUSES: Mission['status'][] = ['draft', 'running', 'paused']
const REPORT_FORMATS: MissionReportFormat[] = ['markdown', 'slack', 'discord', 'email', 'audio']

export function isMissionEditable(status: Mission['status']): boolean {
  return EDITABLE_STATUSES.includes(status)
}

interface EditSheetProps {
  mission: Mission | null
  onClose: () => void
  onSaved: (updated: Mission) => void
}

function numOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number.parseFloat(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}

function intOrNull(value: string): number | null {
  const n = numOrNull(value)
  return n == null ? null : Math.round(n)
}

function renderCap(value: number | null | undefined): string {
  return value == null ? '' : String(value)
}

export function MissionEditSheet({ mission, onClose, onSaved }: EditSheetProps) {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [criteriaText, setCriteriaText] = useState('')
  const [maxUsd, setMaxUsd] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [maxWallclockSec, setMaxWallclockSec] = useState('')
  const [maxTurns, setMaxTurns] = useState('')
  const [maxToolCalls, setMaxToolCalls] = useState('')
  const [reportsEnabled, setReportsEnabled] = useState(false)
  const [reportIntervalMin, setReportIntervalMin] = useState('60')
  const [reportFormat, setReportFormat] = useState<MissionReportFormat>('markdown')
  const [reportConnectorIds, setReportConnectorIds] = useState<string[]>([])
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!mission) return
    setTitle(mission.title)
    setGoal(mission.goal)
    setCriteriaText(mission.successCriteria.join('\n'))
    setMaxUsd(renderCap(mission.budget.maxUsd))
    setMaxTokens(renderCap(mission.budget.maxTokens))
    setMaxWallclockSec(renderCap(mission.budget.maxWallclockSec))
    setMaxTurns(renderCap(mission.budget.maxTurns))
    setMaxToolCalls(renderCap(mission.budget.maxToolCalls))
    const schedule = mission.reportSchedule
    setReportsEnabled(Boolean(schedule?.enabled))
    setReportIntervalMin(schedule ? String(Math.max(1, Math.round(schedule.intervalSec / 60))) : '60')
    setReportFormat(schedule?.format ?? 'markdown')
    setReportConnectorIds(mission.reportConnectorIds)
  }, [mission])

  useEffect(() => {
    if (!mission) return
    let cancelled = false
    api<Record<string, Connector>>('GET', '/connectors')
      .then((map) => {
        if (!cancelled) setConnectors(map ? Object.values(map) : [])
      })
      .catch(() => { if (!cancelled) setConnectors([]) })
    return () => { cancelled = true }
  }, [mission])

  const canEdit = useMemo(() => (mission ? isMissionEditable(mission.status) : false), [mission])

  if (!mission) return null

  const toggleConnector = (id: string) => {
    setReportConnectorIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submit = async () => {
    if (!title.trim() || !goal.trim()) {
      toast.error('Title and goal are required')
      return
    }
    const intervalMin = Number.parseFloat(reportIntervalMin)
    if (reportsEnabled && (!Number.isFinite(intervalMin) || intervalMin <= 0)) {
      toast.error('Report interval must be a positive number')
      return
    }
    setBusy(true)
    try {
      const successCriteria = criteriaText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      const payload = {
        title: title.trim(),
        goal: goal.trim(),
        successCriteria,
        budget: {
          maxUsd: numOrNull(maxUsd),
          maxTokens: intOrNull(maxTokens),
          maxWallclockSec: intOrNull(maxWallclockSec),
          maxTurns: intOrNull(maxTurns),
          maxToolCalls: intOrNull(maxToolCalls),
        },
        reportSchedule: reportsEnabled
          ? {
              intervalSec: Math.max(60, Math.round(intervalMin * 60)),
              format: reportFormat,
              enabled: true,
            }
          : null,
        reportConnectorIds,
      }
      const updated = await api<Mission>('PUT', `/missions/${mission.id}`, payload)
      onSaved(updated)
      onClose()
      toast.success('Mission updated')
    } catch (error) {
      toast.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-md border border-line-default bg-bg shadow-[0_24px_64px_rgba(0,0,0,0.6)] p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[14px] font-600 text-text mb-1">Edit mission</div>
        <div className="text-[11px] text-text-3 mb-4">
          Adjust the goal, budget, or reporting schedule. Changes apply to the next turn.
        </div>

        {!canEdit && (
          <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 text-amber-200 px-3 py-2 text-[11px]">
            This mission is {mission.status}. Only draft, running, or paused missions can be edited.
          </div>
        )}

        <fieldset disabled={!canEdit || busy} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-3">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-3 inline-flex items-center gap-1">
              Goal <HintTip text="The natural-language objective. The team works toward this until budget or success criteria are hit." />
            </span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              className={`${inputClass} resize-none`}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-3 inline-flex items-center gap-1">
              Success criteria <HintTip text="One per line. Used in reports and final verification." />
            </span>
            <textarea
              value={criteriaText}
              onChange={(e) => setCriteriaText(e.target.value)}
              rows={4}
              className={`${inputClass} resize-none`}
            />
          </label>

          <div className="rounded-sm border border-line-subtle bg-layer-1 px-3 py-2.5">
            <div className="text-[11px] font-600 text-text-3 uppercase tracking-wide mb-2">
              Budget <HintTip text="Leave any field blank to remove that cap." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-3">Max USD</span>
                <input
                  value={maxUsd}
                  onChange={(e) => setMaxUsd(e.target.value)}
                  className={inputClass}
                  inputMode="decimal"
                  placeholder="No cap"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-3">Max tokens</span>
                <input
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  className={inputClass}
                  inputMode="numeric"
                  placeholder="No cap"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-3">Max wallclock (sec)</span>
                <input
                  value={maxWallclockSec}
                  onChange={(e) => setMaxWallclockSec(e.target.value)}
                  className={inputClass}
                  inputMode="numeric"
                  placeholder="No cap"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-3">Max turns</span>
                <input
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                  className={inputClass}
                  inputMode="numeric"
                  placeholder="No cap"
                />
              </label>
              <label className="flex flex-col gap-1 col-span-2">
                <span className="text-[11px] text-text-3">Max tool calls</span>
                <input
                  value={maxToolCalls}
                  onChange={(e) => setMaxToolCalls(e.target.value)}
                  className={inputClass}
                  inputMode="numeric"
                  placeholder="No cap"
                />
              </label>
            </div>
          </div>

          <div className="rounded-sm border border-line-subtle bg-layer-1 px-3 py-2.5">
            <div className="text-[11px] font-600 text-text-3 uppercase tracking-wide mb-2">Periodic reports</div>
            <label className="flex items-center gap-2 flex-wrap mb-2">
              <input
                type="checkbox"
                checked={reportsEnabled}
                onChange={(e) => setReportsEnabled(e.target.checked)}
              />
              <span className="text-[11px] text-text-3">Send a report every</span>
              <input
                disabled={!reportsEnabled}
                value={reportIntervalMin}
                onChange={(e) => setReportIntervalMin(e.target.value)}
                className={`${inputClass} w-16`}
                inputMode="numeric"
              />
              <span className="text-[11px] text-text-3">minutes in</span>
              <select
                disabled={!reportsEnabled}
                value={reportFormat}
                onChange={(e) => setReportFormat(e.target.value as MissionReportFormat)}
                className={`${inputClass} w-28`}
              >
                {REPORT_FORMATS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <span className="text-[11px] text-text-3">format</span>
            </label>

            {reportsEnabled && (
              <div>
                <div className="text-[11px] text-text-3 mb-1 inline-flex items-center gap-1">
                  Deliver via connectors <HintTip text="Reports post to the selected connector channels. Leave empty to keep reports in-app only." />
                </div>
                {connectors.length === 0 ? (
                  <div className="text-[11px] text-text-3/60">No connectors configured.</div>
                ) : (
                  <div className="flex flex-col gap-1 max-h-[160px] overflow-y-auto">
                    {connectors.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-[11px] text-text">
                        <input
                          type="checkbox"
                          checked={reportConnectorIds.includes(c.id)}
                          onChange={() => toggleConnector(c.id)}
                        />
                        <span className="font-600">{c.name}</span>
                        <span className="text-text-3/60">({c.platform})</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </fieldset>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="text-[12px] px-3 py-1.5 rounded border border-line-default hover:bg-layer-2"
            disabled={busy}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !canEdit}
            className="text-[12px] font-600 px-3 py-1.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-40"
          >
            {busy ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
