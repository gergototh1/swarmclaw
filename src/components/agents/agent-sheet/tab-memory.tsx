'use client'

import { HintTip } from '@/components/shared/hint-tip'
import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import { AGENT_PLANNING_MODE_OPTIONS, describeAgentPlanningMode, normalizeAgentPlanningMode } from '@/lib/agent-planning-mode'
import { SectionCard, TabEmptyNote } from './section-card'
import type { AgentTabProps } from './agent-draft'

interface Props extends AgentTabProps {
  inputClass: string
}

/** Memory & Intelligence, Continuity - moved verbatim. */
export function TabMemory({ draft, patch, inputClass }: Props) {
  const {
    provider,
    thinkingLevel,
    memoryScopeMode,
    memoryTierPreference,
    proactiveMemory,
    autoDraftSkillSuggestions,
    planningMode,
    sessionResetMode,
    sessionIdleTimeoutSec,
    sessionMaxAgeSec,
    sessionDailyResetAt,
    sessionResetTimezone,
    identityPersonaLabel,
    identitySelfSummary,
    identityRelationshipSummary,
    identityToneStyle,
    identityBoundariesText,
    identityContinuityNotesText,
  } = draft
  const workerOnly = WORKER_ONLY_PROVIDER_IDS.has(provider)

  return (
    <>
      {!workerOnly && (
      <SectionCard
        title="Memory & Intelligence"
        description="Reasoning depth, memory defaults, and drafting behavior."
        className="mb-6 border-line-subtle bg-layer-1"
      >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <select value={thinkingLevel} onChange={(e) => patch({ thinkingLevel: e.target.value as typeof thinkingLevel })} className={inputClass}>
          <option value="">Default thinking</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <select value={memoryScopeMode} onChange={(e) => patch({ memoryScopeMode: e.target.value as typeof memoryScopeMode })} className={inputClass}>
          <option value="auto">Auto memory scope</option>
          <option value="all">All</option>
          <option value="global">Global</option>
          <option value="agent">Agent</option>
          <option value="session">Session</option>
          <option value="project">Project</option>
        </select>
        <select value={memoryTierPreference} onChange={(e) => patch({ memoryTierPreference: e.target.value as typeof memoryTierPreference })} className={inputClass}>
          <option value="blended">Blended tiering</option>
          <option value="working">Working memory</option>
          <option value="durable">Durable memory</option>
          <option value="archive">Archive memory</option>
        </select>
        <select value={planningMode} onChange={(e) => patch({ planningMode: normalizeAgentPlanningMode(e.target.value) })} className={inputClass}>
          {AGENT_PLANNING_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <p className="mb-4 text-[12px] leading-[1.6] text-text-3">
        {describeAgentPlanningMode(planningMode)}
      </p>
      <div className="space-y-3">
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => patch((d) => ({ proactiveMemory: !d.proactiveMemory }))}
            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${proactiveMemory ? 'bg-accent-bright' : 'bg-layer-3'}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${proactiveMemory ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Use proactive recall before each run</span>
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => patch((d) => ({ autoDraftSkillSuggestions: !d.autoDraftSkillSuggestions }))}
            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${autoDraftSkillSuggestions ? 'bg-accent-bright' : 'bg-layer-3'}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${autoDraftSkillSuggestions ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Auto-draft conversation skills</span>
        </label>
      </div>
      </SectionCard>
      )}

      {!workerOnly && (
      <SectionCard
        title="Continuity"
        description="Stable identity, relationship context, and session reset policy."
        className="mb-6 border-line-subtle bg-layer-1"
      >
      <div className="mb-8">
        <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
          Identity Continuity <HintTip text="Seeds the agent's continuity state so session memory can preserve a stable persona and relationship context." />
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <input type="text" value={identityPersonaLabel} onChange={(e) => patch({ identityPersonaLabel: e.target.value })} placeholder="Persona label" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="text" value={identityToneStyle} onChange={(e) => patch({ identityToneStyle: e.target.value })} placeholder="Tone style" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>
        <div className="grid grid-cols-1 gap-3">
          <textarea value={identitySelfSummary} onChange={(e) => patch({ identitySelfSummary: e.target.value })} placeholder="How this agent should summarize itself across sessions." rows={3} className={`${inputClass} resize-y min-h-[84px]`} style={{ fontFamily: 'inherit' }} />
          <textarea value={identityRelationshipSummary} onChange={(e) => patch({ identityRelationshipSummary: e.target.value })} placeholder="Relationship framing or standing context the agent should keep in mind." rows={3} className={`${inputClass} resize-y min-h-[84px]`} style={{ fontFamily: 'inherit' }} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <textarea value={identityBoundariesText} onChange={(e) => patch({ identityBoundariesText: e.target.value })} placeholder="Boundaries, one per line." rows={4} className={`${inputClass} resize-y min-h-[108px]`} style={{ fontFamily: 'inherit' }} />
            <textarea value={identityContinuityNotesText} onChange={(e) => patch({ identityContinuityNotesText: e.target.value })} placeholder="Continuity notes, one per line." rows={4} className={`${inputClass} resize-y min-h-[108px]`} style={{ fontFamily: 'inherit' }} />
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-[1.5] text-text-3">
          Use one line per item. Boundaries are stable guardrails; continuity notes are recurring relationship or project context worth carrying across sessions.
        </p>
      </div>

      <div>
        <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
          Session Reset Policy <HintTip text="Controls when this agent's sessions are considered stale and should be refreshed." />
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <select value={sessionResetMode} onChange={(e) => patch({ sessionResetMode: e.target.value as typeof sessionResetMode })} className={inputClass} style={{ fontFamily: 'inherit' }}>
            <option value="">Inherit global default</option>
            <option value="idle">Idle</option>
            <option value="daily">Daily</option>
            <option value="isolated">Isolated (fresh context per run)</option>
          </select>
          <input type="number" min={0} value={sessionIdleTimeoutSec} onChange={(e) => patch({ sessionIdleTimeoutSec: e.target.value })} placeholder="Idle timeout in seconds" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input type="number" min={0} value={sessionMaxAgeSec} onChange={(e) => patch({ sessionMaxAgeSec: e.target.value })} placeholder="Max age in seconds" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="text" value={sessionDailyResetAt} onChange={(e) => patch({ sessionDailyResetAt: e.target.value })} placeholder="Daily reset time (HH:MM)" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="text" value={sessionResetTimezone} onChange={(e) => patch({ sessionResetTimezone: e.target.value })} placeholder="Timezone (optional)" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>
      </div>
      </SectionCard>
      )}

      {workerOnly && (
        <TabEmptyNote>
          Reasoning depth, memory scope, identity continuity and session reset are applied by the
          SwarmClaw runtime, which this provider bypasses in favour of its own. They have no effect
          on this agent and are hidden.
        </TabEmptyNote>
      )}
    </>
  )
}
