import type { AgentRoutingStrategy, AgentRoutingTarget } from '@/types'
import type { AgentPlanningMode } from '@/lib/agent-planning-mode'

export type AgentProviderId = string

export interface ExtensionToolInfo {
  extensionId: string
  extensionName?: string
  toolName: string
  label: string
  description: string
}

/**
 * Every field the agent sheet edits, gathered into one shape. This is not a
 * "one prop pair per tab" contract: TabEssentials destructures this plus 38
 * more props of its own, and TabAdvanced takes `draft` but never `patch`. What
 * this buys is a single source of truth for the sheet's field values and
 * their `createEmptyAgentDraft()` defaults, so a tab reads and writes one
 * shape instead of the sheet's fields being redeclared per tab.
 */
export interface AgentDraft {
  name: string
  description: string
  soul: string
  systemPrompt: string
  provider: AgentProviderId
  model: string
  credentialId: string | null
  apiEndpoint: string | null
  gatewayProfileId: string | null
  preferredGatewayTagsText: string
  preferredGatewayUseCase: string
  routingStrategy: AgentRoutingStrategy
  routingTargets: AgentRoutingTarget[]
  role: 'worker' | 'coordinator'
  delegationEnabled: boolean
  delegationTargetMode: 'all' | 'selected'
  delegationTargetAgentIds: string[]
  tools: string[]
  /**
   * Scoped tool access is the default for new agents (cuts ~3 k input tokens
   * per turn). Existing agents with no toolAccessMode field persisted stay
   * universal server-side for backward compat; the new-agent setup path
   * also explicitly writes 'scoped' so it persists on save.
   */
  toolAccessMode: 'universal' | 'scoped'
  extensions: string[]
  skills: string[]
  skillIds: string[]
  mcpServerIds: string[]
  mcpDisabledTools: string[]
  fallbackCredentialIds: string[]
  capabilities: string[]
  ollamaMode: 'local' | 'cloud'
  openclawEnabled: boolean
  projectId: string | undefined
  avatarSeed: string
  avatarUrl: string | null
  thinkingLevel: '' | 'minimal' | 'low' | 'medium' | 'high'
  memoryScopeMode: 'auto' | 'all' | 'global' | 'agent' | 'session' | 'project'
  memoryTierPreference: 'working' | 'durable' | 'archive' | 'blended'
  proactiveMemory: boolean
  autoDraftSkillSuggestions: boolean
  planningMode: AgentPlanningMode
  autoRecovery: boolean
  disabled: boolean
  filesystemScope: 'workspace' | 'machine'
  voiceId: string
  heartbeatEnabled: boolean
  /** '' = default (30m) */
  heartbeatIntervalSec: string
  heartbeatModel: string
  heartbeatPrompt: string
  dreamEnabled: boolean
  dreamCooldownMinutes: string
  dreamTier2Enabled: boolean
  orchestratorEnabled: boolean
  orchestratorMission: string
  orchestratorWakeInterval: string
  orchestratorGovernance: 'autonomous' | 'approval-required' | 'notify-only'
  orchestratorMaxCyclesPerDay: string
  sessionResetMode: '' | 'idle' | 'daily' | 'isolated'
  sessionIdleTimeoutSec: string
  sessionMaxAgeSec: string
  sessionDailyResetAt: string
  sessionResetTimezone: string
  identityPersonaLabel: string
  identitySelfSummary: string
  identityRelationshipSummary: string
  identityToneStyle: string
  identityBoundariesText: string
  identityContinuityNotesText: string
  budgetEnabled: boolean
  hourlyBudget: string
  dailyBudget: string
  monthlyBudget: string
  budgetAction: 'warn' | 'block'
}

/**
 * One write into the draft. The function form exists because several of the
 * moved controls toggle or append to the value they already hold, and reading
 * that value from the updater is what keeps them correct under batching.
 */
export type AgentPatch = (
  update: Partial<AgentDraft> | ((current: AgentDraft) => Partial<AgentDraft>),
) => void

export interface AgentTabProps {
  draft: AgentDraft
  patch: AgentPatch
}

export function createEmptyAgentDraft(): AgentDraft {
  return {
    name: '',
    description: '',
    soul: '',
    systemPrompt: '',
    provider: 'claude-cli',
    model: '',
    credentialId: null,
    apiEndpoint: null,
    gatewayProfileId: null,
    preferredGatewayTagsText: '',
    preferredGatewayUseCase: '',
    routingStrategy: 'single',
    routingTargets: [],
    role: 'worker',
    delegationEnabled: false,
    delegationTargetMode: 'all',
    delegationTargetAgentIds: [],
    tools: [],
    toolAccessMode: 'scoped',
    extensions: [],
    skills: [],
    skillIds: [],
    mcpServerIds: [],
    mcpDisabledTools: [],
    fallbackCredentialIds: [],
    capabilities: [],
    ollamaMode: 'local',
    openclawEnabled: false,
    projectId: undefined,
    avatarSeed: '',
    avatarUrl: null,
    thinkingLevel: '',
    memoryScopeMode: 'auto',
    memoryTierPreference: 'blended',
    proactiveMemory: true,
    autoDraftSkillSuggestions: true,
    planningMode: 'off',
    autoRecovery: false,
    disabled: false,
    filesystemScope: 'workspace',
    voiceId: '',
    heartbeatEnabled: false,
    heartbeatIntervalSec: '',
    heartbeatModel: '',
    heartbeatPrompt: '',
    dreamEnabled: false,
    dreamCooldownMinutes: '360',
    dreamTier2Enabled: true,
    orchestratorEnabled: false,
    orchestratorMission: '',
    orchestratorWakeInterval: '5m',
    orchestratorGovernance: 'autonomous',
    orchestratorMaxCyclesPerDay: '',
    sessionResetMode: '',
    sessionIdleTimeoutSec: '',
    sessionMaxAgeSec: '',
    sessionDailyResetAt: '',
    sessionResetTimezone: '',
    identityPersonaLabel: '',
    identitySelfSummary: '',
    identityRelationshipSummary: '',
    identityToneStyle: '',
    identityBoundariesText: '',
    identityContinuityNotesText: '',
    budgetEnabled: false,
    hourlyBudget: '',
    dailyBudget: '',
    monthlyBudget: '',
    budgetAction: 'warn',
  }
}
