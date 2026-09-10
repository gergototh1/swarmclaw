'use client'

import { useState } from 'react'
import type { SwarmPanelData } from './swarm-panel'

type SwarmAgentEntry = SwarmPanelData['agents'][number]

/**
 * Azonosítja, melyik gyerek-subagentre vonatkozik egy tag.
 *
 * A job id a spawn indításakor rögtön létrejön -- a valós job-rekordokban
 * (lásd swarm-panel.test.ts "real ... job record" fixtúrái) ugyanaz az
 * érték marad a `running` eseménytől a terminálisig, míg a gyerek session
 * id néhány spawn-alakzatnál (pl. induló batch) még nem létezik. A job id
 * ezért az elsődleges kulcs -- ez az, ami a running és a terminális sort
 * ugyanahhoz a taghoz köti. Ha egy tagnak nincs job id-ja (pl. egy kész
 * batch-eredmény, aminek csak session id-ja van), a session id a
 * másodlagos kulcs. Ha egyik sincs -- csak egy helykitöltő "Agent N" tag
 * egy épp induló batch/swarmból --, az esemény- és tag-index adja az
 * utolsó, esemény-lokális azonosítót, hogy két különböző, valóban
 * azonosítatlan tag véletlenül ne olvadjon eggyé.
 */
function subagentMemberKey(agent: SwarmAgentEntry, eventIndex: number, agentIndex: number): string {
  if (agent.jobId) return `job:${agent.jobId}`
  if (agent.sessionId) return `session:${agent.sessionId}`
  return `idx:${eventIndex}:${agentIndex}`
}

/**
 * Egyetlen üzeneten belül több `spawn_subagent` tool-esemény ugyanarra a
 * gyerek-subagentre mutathat: egy spawn tipikusan egy `running` és egy
 * később érkező terminális (completed/failed/...) eseményt is ír a
 * transzkriptbe. Enélkül a merge nélkül a message-bubble minden eseményhez
 * külön `SubagentRow`-t rendelne, így ugyanaz a subagent kétszer jelenne
 * meg, és a `running` sor örökre "dolgozik…"-ot mutatna a mellette lévő,
 * ugyanahhoz a joborz tartozó terminális sor mellett.
 *
 * Ez a függvény a job id (session id fallback) szerint egyesíti a tagokat,
 * és minden azonosítóhoz a LEGKÉSŐBB kapott eseményt tartja meg -- egy
 * terminális státusz így mindig felülírja a korábbi "running"-ot. A
 * csoportokon belüli sorrend nem változik (az első előfordulás pozíciója
 * marad), csak az adott tag adatai frissülnek a legutolsó eseményre.
 *
 * Csak EGY üzenet `displayToolEvents` tömbjére hívható -- az üzenetek közti
 * összevonás (két különböző assistant-forduló) szándékosan nem ennek a
 * függvénynek a dolga.
 */
export function mergeSubagentEvents(events: readonly SwarmPanelData[]): SwarmPanelData | null {
  const order: string[] = []
  const byKey = new Map<string, SwarmAgentEntry>()

  events.forEach((data, eventIndex) => {
    data.agents.forEach((agent, agentIndex) => {
      const key = subagentMemberKey(agent, eventIndex, agentIndex)
      if (!byKey.has(key)) order.push(key)
      byKey.set(key, agent)
    })
  })

  if (order.length === 0) return null

  const agents = order.map((key) => byKey.get(key) as SwarmAgentEntry)
  const completed = agents.filter((a) => a.status === 'completed').length
  const failed = agents.filter((a) => a.status === 'failed' || a.status === 'cancelled' || a.status === 'timed_out').length
  const running = agents.filter((a) => a.status === 'running').length
  const status: SwarmPanelData['status'] =
    running > 0 ? 'running'
      : failed > 0 && completed > 0 ? 'partial'
      : failed > 0 ? 'failed'
      : 'completed'
  const totalDurationMs = agents.reduce((sum, a) => sum + (a.durationMs || 0), 0)
  const jobIds = agents.map((a) => a.jobId).filter((id): id is string => Boolean(id))

  return {
    kind: agents.length > 1 ? 'batch' : 'single',
    status,
    agents,
    completed,
    failed,
    totalDurationMs,
    jobIds,
  }
}

/**
 * Amit a transzkript mutat egy `spawn_subagent` hívásból.
 *
 * Nem a válaszokat -- azokat a szülő ügynök úgyis összefoglalja a következő
 * üzenetében. Ez a sor azt mondja meg, KI dolgozott és hol van a
 * beszélgetése, hogy a felhasználó oda tudjon nyúlni.
 *
 * A `sessionId` nélküli tag nem kattintható: egy még el nem indult spawnnak
 * nincs sessionje, amit meg lehetne nyitni.
 */
export function SubagentRow({
  data,
  onOpen,
}: {
  data: SwarmPanelData
  onOpen: (sessionId: string, agentName: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (data.agents.length === 0) return null

  const names = data.agents.map((a) => a.agentName).join(', ')

  return (
    <div className="my-2" data-testid="subagent-row">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[12.5px] text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer px-1 py-0.5 rounded-xs hover:bg-layer-1 transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round"
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>{data.agents.length} subagent</span>
        <span aria-hidden="true">·</span>
        <span className="truncate max-w-[260px]">{names}</span>
      </button>

      {open && (
        <div className="mt-1 ml-4 flex flex-col gap-0.5">
          {data.agents.map((agent, i) => {
            const canOpen = !!agent.sessionId
            return (
              <button
                key={agent.jobId || `${agent.agentName}-${i}`}
                type="button"
                disabled={!canOpen}
                onClick={() => agent.sessionId && onOpen(agent.sessionId, agent.agentName)}
                className={`flex items-center gap-2 text-left text-[12.5px] px-2 py-1 rounded-xs border-none bg-transparent transition-colors ${
                  canOpen ? 'cursor-pointer hover:bg-layer-1 text-text-2' : 'cursor-default text-text-3'
                }`}
                title={canOpen ? 'Beszélgetés megnyitása' : 'Ez a subagent még nem indult el'}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    agent.status === 'running' ? 'bg-amber-400 animate-pulse'
                      : agent.status === 'completed' ? 'bg-emerald-400'
                      : 'bg-rose-400'
                  }`}
                />
                <span className="truncate">{agent.agentName}</span>
                <span className="text-text-3 shrink-0">
                  {agent.status === 'running'
                    ? 'dolgozik…'
                    : agent.durationMs
                      ? `${Math.round(agent.durationMs / 1000)} mp`
                      : agent.status}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
