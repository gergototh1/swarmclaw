'use client'

import { useState } from 'react'
import type { SwarmPanelData } from './swarm-panel'

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
