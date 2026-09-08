'use client'

import { HintTip } from '@/components/shared/hint-tip'
import { SectionLabel } from '@/components/shared/section-label'
import { AgentPickerList } from '@/components/shared/agent-picker-list'
import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import { isOrchestratorProviderEligible } from '@/lib/orchestrator-config'
import type { Agent } from '@/types'
import { SectionCard, TabEmptyNote } from './section-card'
import { HB_PRESETS, formatHbDuration } from './agent-sheet-format'
import type { AgentTabProps } from './agent-draft'

interface Props extends AgentTabProps {
  inputClass: string
  canDelegateToAgents: boolean
  agentOptions: Agent[]
  toggleAgent: (id: string) => void
  voiceControlsAvailable: boolean
  voicePlaybackEnabled: boolean
  effectiveVoiceId: string
  effectiveVoiceSource: string
}

/** Role & Autonomy, Behavior, Voice & Autonomy, Safety & Limits - moved verbatim. */
export function TabBehavior({
  draft,
  patch,
  inputClass,
  canDelegateToAgents,
  agentOptions,
  toggleAgent,
  voiceControlsAvailable,
  voicePlaybackEnabled,
  effectiveVoiceId,
  effectiveVoiceSource,
}: Props) {
  const {
    provider,
    role,
    delegationTargetMode,
    delegationTargetAgentIds,
    autoRecovery,
    disabled,
    voiceId,
    heartbeatEnabled,
    heartbeatIntervalSec,
    heartbeatModel,
    heartbeatPrompt,
    dreamEnabled,
    dreamCooldownMinutes,
    dreamTier2Enabled,
    orchestratorEnabled,
    orchestratorMission,
    orchestratorWakeInterval,
    orchestratorGovernance,
    orchestratorMaxCyclesPerDay,
    budgetEnabled,
    hourlyBudget,
    dailyBudget,
    monthlyBudget,
    budgetAction,
  } = draft
  const workerOnly = WORKER_ONLY_PROVIDER_IDS.has(provider)
  const showRoleAutonomy = !workerOnly || isOrchestratorProviderEligible(provider)

  return (
    <>
      {showRoleAutonomy && (
      <SectionCard
        title="Role & Autonomy"
        description="Define how this agent operates in the swarm."
      >
        {/* --- Role subsection --- */}
        {!WORKER_ONLY_PROVIDER_IDS.has(provider) && (
          <div className="rounded-lg border border-line-subtle bg-surface px-4 py-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <SectionLabel>Role</SectionLabel>
              <HintTip text="Coordinators automatically receive a list of available agents and can decompose complex goals, delegate to specialists, and synthesize results." />
            </div>
            <div className="flex gap-2 mb-3">
              {(['worker', 'coordinator'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    patch({ role: r })
                    if (r === 'coordinator') patch({ delegationEnabled: true })
                  }}
                  className={`px-4 py-1.5 rounded-sm text-[13px] font-display font-600 transition-all duration-200
                    ${role === r
                      ? 'bg-accent-bright text-accent-fg'
                      : 'bg-layer-2 text-text-3 hover:bg-layer-3'}`}
                >
                  {r === 'worker' ? 'Worker' : 'Coordinator'}
                </button>
              ))}
            </div>
            <p className="text-[12px] text-text-3">
              {role === 'coordinator'
                ? 'Breaks down complex goals, delegates to specialists, and synthesizes results'
                : 'Executes tasks when prompted by users or other agents'}
            </p>

            {/* Delegation toggle */}
            <div className="mt-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => {
                    if (role !== 'coordinator') patch((d) => ({ delegationEnabled: !d.delegationEnabled }))
                  }}
                  className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                    ${canDelegateToAgents ? 'bg-accent-bright' : 'bg-layer-3'}
                    ${role === 'coordinator' ? 'opacity-60' : ''}`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                    ${canDelegateToAgents ? 'left-[22px]' : 'left-0.5'}`} />
                </div>
                <span className="font-display text-[14px] font-600 text-text-2">Can Delegate</span>
                <span className="text-[12px] text-text-3">
                  {role === 'coordinator' ? 'Always on for coordinators' : 'Route work to specialized agents'}
                </span>
              </label>
            </div>

            {/* Delegation targets */}
            {canDelegateToAgents && agentOptions.length > 0 && (
              <div className="mt-4">
                <SectionLabel>Allowed Delegate Agents</SectionLabel>
                <AgentPickerList
                  agents={agentOptions}
                  selected={delegationTargetMode === 'all' ? [] : delegationTargetAgentIds}
                  onSelect={(id) => toggleAgent(id)}
                  noneOption={{
                    label: 'All Agents',
                    onSelect: () => {
                      patch({ delegationTargetMode: 'all' })
                      patch({ delegationTargetAgentIds: [] })
                    },
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* --- Orchestrator subsection --- */}
        {isOrchestratorProviderEligible(provider) && (
          <div className="rounded-lg border border-line-subtle bg-surface px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[14px] font-600 text-text">Orchestrator Mode</p>
                <p className="mt-1 text-[12px] leading-[1.6] text-text-3">
                  Wakes on a schedule to autonomously review platform state and take action.
                </p>
              </div>
              <button
                type="button"
                onClick={() => patch((d) => ({ orchestratorEnabled: !d.orchestratorEnabled }))}
                className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${orchestratorEnabled ? 'bg-accent-bright' : 'bg-layer-3'}`}
                aria-pressed={orchestratorEnabled}
              >
                <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${orchestratorEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>

            {orchestratorEnabled && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
                    Mission
                  </label>
                  <textarea
                    value={orchestratorMission}
                    onChange={(e) => patch({ orchestratorMission: e.target.value })}
                    placeholder="Describe the orchestrator's mission — what should it manage, optimize, or oversee?"
                    rows={3}
                    className={`${inputClass} resize-y min-h-[84px]`}
                    style={{ fontFamily: 'inherit' }}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
                      Wake Interval
                    </label>
                    <input
                      type="text"
                      value={orchestratorWakeInterval}
                      onChange={(e) => patch({ orchestratorWakeInterval: e.target.value })}
                      placeholder="5m"
                      className={inputClass}
                      style={{ fontFamily: 'inherit' }}
                    />
                  </div>
                  <div>
                    <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
                      Governance
                    </label>
                    <select
                      value={orchestratorGovernance}
                      onChange={(e) => patch({ orchestratorGovernance: e.target.value as typeof orchestratorGovernance })}
                      className={inputClass}
                      style={{ fontFamily: 'inherit' }}
                    >
                      <option value="autonomous">Autonomous</option>
                      <option value="approval-required">Approval Required</option>
                      <option value="notify-only">Notify Only</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
                      Max Cycles/Day
                    </label>
                    <input
                      type="number"
                      value={orchestratorMaxCyclesPerDay}
                      onChange={(e) => patch({ orchestratorMaxCyclesPerDay: e.target.value })}
                      placeholder="No limit"
                      min={1}
                      className={inputClass}
                      style={{ fontFamily: 'inherit' }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>
      )}

      {!workerOnly && (
      <SectionCard
        title="Behavior"
        description="Keep the core autonomy switch visible. Expert heartbeat controls stay in advanced settings."
      >
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line-subtle bg-surface px-4 py-4">
          <div className="min-w-0">
            <p className="text-[14px] font-600 text-text">Heartbeat</p>
            <p className="mt-1 text-[12px] leading-[1.6] text-text-3">
              Keep this agent alive in the background for proactive work and scheduled follow-through.
            </p>
          </div>
          <button
            type="button"
            onClick={() => patch((d) => ({ heartbeatEnabled: !d.heartbeatEnabled }))}
            className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${heartbeatEnabled ? 'bg-accent-bright' : 'bg-layer-3'}`}
            aria-pressed={heartbeatEnabled}
          >
            <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${heartbeatEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line-subtle bg-surface px-4 py-4 mt-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[14px] font-600 text-text">Dreaming</p>
              <HintTip text="When enabled, this agent consolidates and optimizes its memories during idle periods" />
            </div>
            <p className="mt-1 text-[12px] leading-[1.6] text-text-3">
              Consolidate, decay, and reflect on memories when the agent is idle.
            </p>
          </div>
          <button
            type="button"
            onClick={() => patch((d) => ({ dreamEnabled: !d.dreamEnabled }))}
            className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${dreamEnabled ? 'bg-accent-bright' : 'bg-layer-3'}`}
            aria-pressed={dreamEnabled}
          >
            <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${dreamEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        {dreamEnabled && (
          <div className="mt-3 rounded-lg border border-line-subtle bg-surface px-4 py-4 space-y-3">
            <div>
              <label className="flex items-center gap-2 text-[12px] font-600 text-text-2 mb-1.5">
                Cooldown (minutes) <HintTip text="Minimum minutes between dream cycles" />
              </label>
              <input
                type="number"
                value={dreamCooldownMinutes}
                onChange={(e) => patch({ dreamCooldownMinutes: e.target.value })}
                min={1}
                placeholder="360"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <div
                onClick={() => patch((d) => ({ dreamTier2Enabled: !d.dreamTier2Enabled }))}
                className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${dreamTier2Enabled ? 'bg-accent-bright' : 'bg-layer-3'}`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${dreamTier2Enabled ? 'left-[22px]' : 'left-0.5'}`} />
              </div>
              <span className="flex items-center gap-2 text-[13px] text-text-2">
                Tier 2 Reflection <HintTip text="Use the agent's LLM to reflect on memories and produce consolidated insights" />
              </span>
            </label>
          </div>
        )}
      </SectionCard>
      )}

      {!workerOnly && (
      <SectionCard
        title="Voice & Autonomy"
        description="Tune voice and the detailed heartbeat behavior for this agent."
        className="mb-6 border-line-subtle bg-layer-1"
      >
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
          Voice &amp; Audio
        </label>
        {voiceControlsAvailable ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3">
              <input
                type="text"
                value={voiceId}
                onChange={(e) => patch({ voiceId: e.target.value })}
                placeholder="ElevenLabs voice ID"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <button
                type="button"
                onClick={() => patch({ voiceId: '' })}
                className="px-3 py-2.5 rounded-md border border-line-default bg-transparent text-[12px] font-600 text-text-3 hover:bg-layer-2 hover:text-text-2 transition-all cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                Use global default
              </button>
            </div>
            <p className="mt-2 text-[12px] leading-[1.6] text-text-3">
              Current effective voice: <span className="text-text-2">{effectiveVoiceId}</span> · {effectiveVoiceSource}
              {!voicePlaybackEnabled && ' · Voice playback is disabled globally'}
            </p>
          </>
        ) : (
          <p className="text-[12px] leading-[1.6] text-text-3">
            ElevenLabs is not configured yet. Add a global API key in Settings to enable voice overrides here.
          </p>
        )}
      </div>

      <div>
        <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
          Heartbeat Controls
        </label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <select
            value={heartbeatIntervalSec}
            onChange={(e) => patch({ heartbeatIntervalSec: e.target.value })}
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          >
            <option value="">Use default interval</option>
            {HB_PRESETS.map((preset) => (
              <option key={preset} value={preset}>{formatHbDuration(preset)}</option>
            ))}
          </select>
          <input
            type="text"
            value={heartbeatModel}
            onChange={(e) => patch({ heartbeatModel: e.target.value })}
            placeholder="Heartbeat model override"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
        </div>
        <textarea
          value={heartbeatPrompt}
          onChange={(e) => patch({ heartbeatPrompt: e.target.value })}
          placeholder="Optional custom heartbeat prompt"
          rows={3}
          className={`${inputClass} resize-y min-h-[84px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>
      </SectionCard>
      )}

      {!workerOnly && (
      <SectionCard
        title="Safety & Limits"
        description="Enable safeguards, recovery, and spend limits without crowding the main setup flow."
        className="mb-6 border-line-subtle bg-layer-1"
      >
      <div className="space-y-3 mb-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <div onClick={() => patch((d) => ({ disabled: !d.disabled }))} className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${disabled ? 'bg-accent-bright' : 'bg-layer-3'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${disabled ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Disable this agent</span>
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <div onClick={() => patch((d) => ({ autoRecovery: !d.autoRecovery }))} className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${autoRecovery ? 'bg-accent-bright' : 'bg-layer-3'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${autoRecovery ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Guardian auto-recovery</span>
        </label>
      </div>

      <div className="mb-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <div onClick={() => patch((d) => ({ budgetEnabled: !d.budgetEnabled }))} className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${budgetEnabled ? 'bg-accent-bright' : 'bg-layer-3'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${budgetEnabled ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Spend limits</span>
        </label>
      </div>
      {budgetEnabled && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input type="number" min={0} step="0.01" value={hourlyBudget} onChange={(e) => patch({ hourlyBudget: e.target.value })} placeholder="Hourly" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="number" min={0} step="0.01" value={dailyBudget} onChange={(e) => patch({ dailyBudget: e.target.value })} placeholder="Daily" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="number" min={0} step="0.01" value={monthlyBudget} onChange={(e) => patch({ monthlyBudget: e.target.value })} placeholder="Monthly" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <select value={budgetAction} onChange={(e) => patch({ budgetAction: e.target.value as typeof budgetAction })} className={inputClass} style={{ fontFamily: 'inherit' }}>
            <option value="warn">Warn</option>
            <option value="block">Block</option>
          </select>
        </div>
      )}
      </SectionCard>
      )}

      {!showRoleAutonomy && workerOnly && (
        <TabEmptyNote>
          This provider runs its own agent loop, so SwarmClaw does not manage its role, delegation,
          heartbeat, dreaming, voice or spend limits. Its behaviour is configured where the CLI itself
          is configured.
        </TabEmptyNote>
      )}
    </>
  )
}
