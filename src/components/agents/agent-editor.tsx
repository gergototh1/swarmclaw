'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { createAgent, updateAgent, deleteAgent } from '@/lib/agents'
import { api } from '@/lib/app/api-client'
import { fetchProviderModelDiscovery } from '@/lib/provider-model-discovery-client'
import { sleep } from '@/lib/shared-utils'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { EmptyState } from '@/components/shared/empty-state'
import { PageLoader } from '@/components/ui/page-loader'
import { setLeaveGuard } from '@/lib/app/leave-guard'
import { onTabFlushRequest } from '@/lib/app/tab-flush'
import { toast } from 'sonner'
import type { ProviderType, ProviderDiagnosticStep, ClaudeSkill, AgentPackManifest, AgentRoutingTarget } from '@/types'
import { NON_LANGGRAPH_PROVIDER_IDS, WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import { randomSoul } from '@/lib/soul-suggestions'
import { SoulLibraryPicker } from './soul-library-picker'
import { resolveStoredOllamaMode } from '@/lib/ollama-mode'
import { errorMessage } from '@/lib/shared-utils'
import { getDefaultAgentToolIds } from '@/lib/agent-default-tools'
import { normalizeAgentPlanningMode } from '@/lib/agent-planning-mode'
import { buildAgentConfigVersionSummary } from '@/lib/agent-config-history'
import { getEnabledExtensionIds, getEnabledToolIds } from '@/lib/capability-selection'
import { buildAgentSelectableProviders, resolveAgentSelectableProviderCredentials } from '@/lib/agent-provider-options'
import type { ConfigVersion } from '@/types/config-version'
import { ProviderDiagnosticsList } from '@/components/providers/provider-diagnostics-list'
import { AGENT_SHEET_TABS, type AgentTabKey } from './agent-sheet/agent-sheet-tabs'
import {
  createEmptyAgentDraft,
  type AgentDraft,
  type AgentPatch,
  type ExtensionToolInfo,
} from './agent-sheet/agent-draft'
import { formatGatewayTagList, formatHbDuration, formatIdentityList, parseDurationToSec, parseGatewayTagList, parseIdentityList } from './agent-sheet/agent-sheet-format'
import { TabEssentials } from './agent-sheet/tab-essentials'
import { TabBehavior } from './agent-sheet/tab-behavior'
import { TabTools } from './agent-sheet/tab-tools'
import { TabMemory } from './agent-sheet/tab-memory'
import { TabNetwork } from './agent-sheet/tab-network'
import { TabAdvanced } from './agent-sheet/tab-advanced'

export type { AgentDraft, AgentPatch, AgentTabProps } from './agent-sheet/agent-draft'

const FALLBACK_ELEVENLABS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'
const AUTO_SYNC_MODEL_PROVIDER_IDS = new Set<ProviderType>([
  'openai',
  'openrouter',
  'anthropic',
  'google',
  'deepseek',
  'groq',
  'together',
  'mistral',
  'xai',
  'fireworks',
  'nebius',
  'deepinfra',
  'hermes',
  'lmstudio',
  'ollama',
])
const CONNECTION_TEST_TIMEOUT_MS = 40_000

/**
 * The desktop app's window, or a tab frame inside it (the preload only runs in
 * the top frame). There a `beforeunload` block does not ask anything: it
 * silently stops window close, quit and the updater's restart.
 */
function insideDesktopApp(): boolean {
  const hasBridge = (w: Window) => Boolean((w as unknown as { swarmclawDesktop?: unknown }).swarmclawDesktop)
  if (hasBridge(window)) return true
  try {
    return window.parent !== window && hasBridge(window.parent)
  } catch {
    return false
  }
}

/** An agent's settings, shown in the main area at /agents/:id, or /agents/new when `agentId` is null. */
export function AgentEditor({ agentId }: { agentId: string | null }) {
  const router = useRouter()
  const editingId = agentId
  // True once the user changed something that is not saved yet.
  const [dirty, setDirty] = useState(false)
  // The held navigation while the "unsaved changes" dialog is up.
  const [leavePrompt, setLeavePrompt] = useState<(() => void) | null>(null)
  // The saved configuration version waiting on the restore dialog.
  const [restorePromptVersionId, setRestorePromptVersionId] = useState<string | null>(null)
  // Bumped by "Discard" to rerun the loader against the stored agent.
  const [reloadKey, setReloadKey] = useState(0)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const updateAgentInStore = useAppStore((s) => s.updateAgentInStore)
  const activeSessionId = useAppStore(selectActiveSessionId)
  const currentSession = useAppStore((s) => {
    const id = selectActiveSessionId(s)
    return id ? s.sessions[id] : null
  })
  const refreshSession = useAppStore((s) => s.refreshSession)
  const projects = useAppStore((s) => s.projects)
  const loadProjects = useAppStore((s) => s.loadProjects)
  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const providerConfigs = useAppStore((s) => s.providerConfigs)
  const loadProviderConfigs = useAppStore((s) => s.loadProviderConfigs)
  const gatewayProfiles = useAppStore((s) => s.gatewayProfiles)
  const loadGatewayProfiles = useAppStore((s) => s.loadGatewayProfiles)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const dynamicSkills = useAppStore((s) => s.skills)
  const mcpServers = useAppStore((s) => s.mcpServers)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const loadMcpServersAction = useAppStore((s) => s.loadMcpServers)
  const [claudeSkills, setClaudeSkills] = useState<ClaudeSkill[]>([])
  const [claudeSkillsLoading, setClaudeSkillsLoading] = useState(false)
  const loadClaudeSkills = useCallback(async () => {
    setClaudeSkillsLoading(true)
    try {
      const skills = await api<ClaudeSkill[]>('GET', '/claude-skills')
      setClaudeSkills(skills)
    } catch { /* ignore */ }
    finally { setClaudeSkillsLoading(false) }
  }, [])

  const [tab, setTab] = useState<AgentTabKey>('essentials')
  const [draft, setDraft] = useState<AgentDraft>(createEmptyAgentDraft)
  const patch = useCallback<AgentPatch>((update) => {
    setDraft((current) => ({ ...current, ...(typeof update === 'function' ? update(current) : update) }))
  }, [])
  // A change the user made, as opposed to the loader filling the form.
  const userPatch = useCallback<AgentPatch>((update) => {
    setDirty(true)
    patch(update)
  }, [patch])
  const {
    name,
    description,
    soul,
    systemPrompt,
    provider,
    model,
    credentialId,
    apiEndpoint,
    gatewayProfileId,
    preferredGatewayTagsText,
    preferredGatewayUseCase,
    routingStrategy,
    routingTargets,
    role,
    delegationEnabled,
    delegationTargetMode,
    delegationTargetAgentIds,
    tools,
    toolAccessMode,
    extensions,
    skills,
    skillIds,
    mcpServerIds,
    mcpDisabledTools,
    fallbackCredentialIds,
    capabilities,
    ollamaMode,
    openclawEnabled,
    projectId,
    avatarSeed,
    avatarUrl,
    thinkingLevel,
    memoryScopeMode,
    memoryTierPreference,
    proactiveMemory,
    autoDraftSkillSuggestions,
    planningMode,
    autoRecovery,
    disabled,
    filesystemScope,
    voiceId,
    replyNotificationsMuted,
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
    budgetEnabled,
    hourlyBudget,
    dailyBudget,
    monthlyBudget,
    budgetAction,
  } = draft

  // Sheet-local UI state — none of this is part of the saved agent.
  const [soulInitial, setSoulInitial] = useState('')
  const [soulSaveState, setSoulSaveState] = useState<'idle' | 'saved'>('idle')
  const [enabledExtensionIds, setEnabledExtensionIds] = useState<Set<string> | null>(null)
  const [externalTools, setExternalTools] = useState<ExtensionToolInfo[]>([])
  const [mcpTools, setMcpTools] = useState<Record<string, { name: string; description: string }[]>>({})
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false)
  const [capInput, setCapInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [addingKey, setAddingKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  // Test connection state
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [testErrorCode, setTestErrorCode] = useState<string | null>(null)
  const [testDiagnostics, setTestDiagnostics] = useState<ProviderDiagnosticStep[]>([])
  const [testDeviceId, setTestDeviceId] = useState<string | null>(null)
  const [openclawDeviceId, setOpenclawDeviceId] = useState<string | null>(null)
  const [configCopied, setConfigCopied] = useState(false)

  const [soulLibraryOpen, setSoulLibraryOpen] = useState(false)
  const importFileRef = useRef<HTMLInputElement>(null)
  const lastAutoSyncedModelsKeyRef = useRef<string | null>(null)
  const skipAutoModelRef = useRef(false)
  const [configVersions, setConfigVersions] = useState<ConfigVersion[]>([])
  const [configVersionsLoading, setConfigVersionsLoading] = useState(false)
  const [configVersionsError, setConfigVersionsError] = useState<string | null>(null)
  const [restoringConfigVersionId, setRestoringConfigVersionId] = useState<string | null>(null)

  const agentSelectableProviders = useMemo(
    () => buildAgentSelectableProviders(providers, providerConfigs),
    [providers, providerConfigs],
  )
  const currentProvider = agentSelectableProviders.find((p) => p.id === provider)
  const providerCredentials = useMemo(
    () => resolveAgentSelectableProviderCredentials(provider, credentials, providerConfigs),
    [credentials, provider, providerConfigs],
  )
  const openclawCredentials = Object.values(credentials).filter((c) => c.provider === 'openclaw')
  const openclawGatewayProfiles = gatewayProfiles.filter((item) => item.provider === 'openclaw')
  const setAgentPrefill = useAppStore((s) => s.setAgentPrefill)
  // Duplicate mode: the source agent, taken from the store once when the new-agent
  // page mounts. Holding it here keeps the fill below repeatable (Discard, and
  // React's double-run of effects in development) after the store copy is cleared.
  const [duplicateSource] = useState(() => (agentId === null ? useAppStore.getState().agentPrefill : null))
  useEffect(() => {
    if (duplicateSource) setAgentPrefill(null)
  }, [duplicateSource, setAgentPrefill])
  const editing = editingId ? agents[editingId] ?? null : null
  const editingLoaded = editing !== null
  // Set once this page's own agent fetch has come back, so an id that is not
  // in the store can be told apart from one that has not loaded yet.
  const [agentsChecked, setAgentsChecked] = useState(false)
  const globalVoiceId = typeof appSettings.elevenLabsVoiceId === 'string' ? appSettings.elevenLabsVoiceId.trim() : ''
  const agentVoiceId = voiceId.trim()
  const elevenLabsConfigured = appSettings.elevenLabsApiKeyConfigured === true
  const voiceControlsAvailable = elevenLabsConfigured || appSettings.elevenLabsEnabled === true || !!globalVoiceId || !!agentVoiceId
  const voicePlaybackEnabled = appSettings.elevenLabsEnabled === true
  const effectiveVoiceId = agentVoiceId || globalVoiceId || FALLBACK_ELEVENLABS_VOICE_ID
  const effectiveVoiceSource = agentVoiceId
    ? 'Agent override'
    : globalVoiceId
      ? 'Global default'
      : 'Built-in fallback'
  const syncLiveProviderModels = useCallback(async (
    providerId: string,
    nextCredentialId: string | null,
    nextEndpoint: string | null,
    nextOllamaMode: 'local' | 'cloud',
    force = false,
  ): Promise<{ synced: boolean; models: string[] } | null> => {
    if (openclawEnabled) return null
    if (!AUTO_SYNC_MODEL_PROVIDER_IDS.has(providerId as ProviderType)) return null
    const providerInfo = agentSelectableProviders.find((item) => item.id === providerId)
    if (!providerInfo?.supportsModelDiscovery) return null

    const result = await fetchProviderModelDiscovery({
      providerId,
      credentialId: nextCredentialId,
      endpoint: nextEndpoint,
      ollamaMode: providerId === 'ollama' ? nextOllamaMode : null,
      force,
    })

    if (!result.ok || result.models.length === 0) return { synced: false, models: result.models }

    const sameModels = providerInfo.models.length === result.models.length
      && providerInfo.models.every((item, index) => item === result.models[index])

    if (!sameModels) {
      await api('PUT', `/providers/${providerId}/models`, { models: result.models })
      await loadProviders()
    }

    patch((d) => ({ model: d.model.trim() || result.models[0] || '' }))
    return { synced: !sameModels, models: result.models }
  }, [agentSelectableProviders, loadProviders, openclawEnabled, patch])

  const loadAgentConfigVersions = useCallback(async (agentId: string) => {
    setConfigVersionsLoading(true)
    setConfigVersionsError(null)
    try {
      const response = await api<{ versions: ConfigVersion[] }>(
        'GET',
        `/config-versions?entityKind=agent&entityId=${encodeURIComponent(agentId)}`,
      )
      setConfigVersions(Array.isArray(response.versions) ? response.versions : [])
    } catch (err) {
      setConfigVersions([])
      setConfigVersionsError(errorMessage(err))
    } finally {
      setConfigVersionsLoading(false)
    }
  }, [])

  const providerNeedsKey = !editing && (
    (currentProvider?.requiresApiKey && providerCredentials.length === 0 && !addingKey) ||
    (provider === 'ollama' && ollamaMode === 'cloud' && providerCredentials.length === 0 && !addingKey)
  )

  useEffect(() => {
    if (openclawEnabled) return
    if (!AUTO_SYNC_MODEL_PROVIDER_IDS.has(provider as ProviderType)) return
    if (!currentProvider?.supportsModelDiscovery) return

    const requiresCredential = currentProvider.requiresApiKey || (provider === 'ollama' && ollamaMode === 'cloud')
    if (requiresCredential && !credentialId) return

    const syncKey = `${provider}::${credentialId || ''}::${apiEndpoint?.trim() || ''}::${provider === 'ollama' ? ollamaMode : ''}`
    if (lastAutoSyncedModelsKeyRef.current === syncKey) return
    lastAutoSyncedModelsKeyRef.current = syncKey

    void syncLiveProviderModels(provider, credentialId, apiEndpoint, ollamaMode, false).catch(() => {})
  }, [apiEndpoint, credentialId, currentProvider, ollamaMode, openclawEnabled, provider, syncLiveProviderModels])

  // Reference data the tabs pick from. The page remounts per agent (keyed on
  // the id), so this runs once per agent opened.
  useEffect(() => {
    loadSettings()
    loadProviders()
    loadProviderConfigs()
    loadGatewayProfiles()
    loadCredentials()
    loadSkills()
    loadMcpServersAction()
    loadProjects()
    loadClaudeSkills()
    void loadAgents().then(() => setAgentsChecked(true))
    // Fetch enabled extension IDs so we can filter tool toggles
    api<{ enabledExtensionIds: string[]; externalTools?: ExtensionToolInfo[] }>('GET', '/extensions/builtins')
      .then((res) => {
        if (res?.enabledExtensionIds) setEnabledExtensionIds(new Set(res.enabledExtensionIds))
        if (Array.isArray(res?.externalTools)) setExternalTools(res.externalTools)
      })
      .catch(() => {})
    setTab('essentials')
  }, [
    editingId, loadAgents, loadClaudeSkills, loadCredentials, loadGatewayProfiles, loadMcpServersAction,
    loadProjects, loadProviderConfigs, loadProviders, loadSettings, loadSkills,
  ])

  // Fill the form from the stored agent (or the duplicate prefill, or new-agent
  // defaults). Reruns on "Discard", and once more when an agent opened by URL
  // reaches the store after the first render.
  useEffect(() => {
    setDirty(false)
    setTestStatus('idle')
    setTestMessage('')
    setTestDiagnostics([])
    if (editing) {
      setSoulInitial(editing.soul || '')
      setSoulSaveState('idle')
      setCapInput('')
      patch({
        name: editing.name,
        description: editing.description,
        soul: editing.soul || '',
        systemPrompt: editing.systemPrompt,
        provider: editing.provider,
        model: editing.model,
        credentialId: editing.credentialId || null,
        apiEndpoint: editing.apiEndpoint || null,
        gatewayProfileId: editing.gatewayProfileId || null,
        preferredGatewayTagsText: formatGatewayTagList(editing.preferredGatewayTags),
        preferredGatewayUseCase: editing.preferredGatewayUseCase || '',
        routingStrategy: editing.routingStrategy || 'single',
        routingTargets: editing.routingTargets || [],
        role: editing.role === 'coordinator' ? 'coordinator' : 'worker',
        delegationEnabled: editing.delegationEnabled === true,
        delegationTargetMode: editing.delegationTargetMode === 'selected' ? 'selected' : 'all',
        delegationTargetAgentIds: editing.delegationTargetAgentIds || [],
        tools: getEnabledToolIds(editing),
        toolAccessMode: editing.toolAccessMode === 'scoped' ? 'scoped' : 'universal',
        extensions: getEnabledExtensionIds(editing),
        skills: editing.skills || [],
        skillIds: editing.skillIds || [],
        mcpServerIds: editing.mcpServerIds || [],
        mcpDisabledTools: editing.mcpDisabledTools || [],
        fallbackCredentialIds: editing.fallbackCredentialIds || [],
        capabilities: Array.isArray(editing.capabilities) ? editing.capabilities : [],
        ollamaMode: resolveStoredOllamaMode({
          ollamaMode: editing.ollamaMode ?? null,
          apiEndpoint: editing.apiEndpoint ?? null,
        }),
        openclawEnabled: editing.provider === 'openclaw',
        projectId: editing.projectId,
        avatarSeed: editing.avatarSeed || Math.random().toString(36).slice(2, 10),
        avatarUrl: editing.avatarUrl || null,
        thinkingLevel: editing.thinkingLevel || '',
        memoryScopeMode: editing.memoryScopeMode || 'auto',
        memoryTierPreference: editing.memoryTierPreference || 'blended',
        proactiveMemory: editing.proactiveMemory !== false,
        autoDraftSkillSuggestions: editing.autoDraftSkillSuggestions !== false,
        planningMode: normalizeAgentPlanningMode(editing.planningMode),
        autoRecovery: editing.autoRecovery || false,
        disabled: editing.disabled === true,
        filesystemScope: editing.filesystemScope === 'machine' ? 'machine' : 'workspace',
        voiceId: editing.elevenLabsVoiceId || '',
        replyNotificationsMuted: editing.replyNotificationsMuted === true,
        heartbeatEnabled: editing.heartbeatEnabled || false,
        heartbeatIntervalSec: parseDurationToSec(editing.heartbeatInterval, editing.heartbeatIntervalSec),
        heartbeatModel: editing.heartbeatModel || '',
        heartbeatPrompt: editing.heartbeatPrompt || '',
        dreamEnabled: editing.dreamEnabled || false,
        dreamCooldownMinutes: editing.dreamConfig?.cooldownMinutes != null ? String(editing.dreamConfig.cooldownMinutes) : '360',
        dreamTier2Enabled: editing.dreamConfig?.tier2Enabled !== false,
        orchestratorEnabled: editing.orchestratorEnabled || false,
        orchestratorMission: editing.orchestratorMission || '',
        orchestratorWakeInterval: typeof editing.orchestratorWakeInterval === 'string' ? editing.orchestratorWakeInterval : typeof editing.orchestratorWakeInterval === 'number' ? `${editing.orchestratorWakeInterval}s` : '5m',
        orchestratorGovernance: editing.orchestratorGovernance || 'autonomous',
        orchestratorMaxCyclesPerDay: editing.orchestratorMaxCyclesPerDay != null ? String(editing.orchestratorMaxCyclesPerDay) : '',
        sessionResetMode: editing.sessionResetMode || '',
        sessionIdleTimeoutSec: editing.sessionIdleTimeoutSec != null ? String(editing.sessionIdleTimeoutSec) : '',
        sessionMaxAgeSec: editing.sessionMaxAgeSec != null ? String(editing.sessionMaxAgeSec) : '',
        sessionDailyResetAt: editing.sessionDailyResetAt || '',
        sessionResetTimezone: editing.sessionResetTimezone || '',
        identityPersonaLabel: editing.identityState?.personaLabel || '',
        identitySelfSummary: editing.identityState?.selfSummary || '',
        identityRelationshipSummary: editing.identityState?.relationshipSummary || '',
        identityToneStyle: editing.identityState?.toneStyle || '',
        identityBoundariesText: formatIdentityList(editing.identityState?.boundaries),
        identityContinuityNotesText: formatIdentityList(editing.identityState?.continuityNotes),
        budgetEnabled: (typeof editing.hourlyBudget === 'number' && editing.hourlyBudget > 0)
          || (typeof editing.dailyBudget === 'number' && editing.dailyBudget > 0)
          || (typeof editing.monthlyBudget === 'number' && editing.monthlyBudget > 0),
        hourlyBudget: typeof editing.hourlyBudget === 'number' && editing.hourlyBudget > 0 ? String(editing.hourlyBudget) : '',
        dailyBudget: typeof editing.dailyBudget === 'number' && editing.dailyBudget > 0 ? String(editing.dailyBudget) : '',
        monthlyBudget: typeof editing.monthlyBudget === 'number' && editing.monthlyBudget > 0 ? String(editing.monthlyBudget) : '',
        budgetAction: editing.budgetAction || 'warn',
      })
    } else if (editingId) {
      // The agent is not in the store yet; this effect reruns when it arrives.
    } else if (duplicateSource) {
      // Duplicate mode — prefill from the source agent
      const src = duplicateSource
      skipAutoModelRef.current = true
      setSoulInitial(src.soul || '')
      setSoulSaveState('idle')
      setCapInput('')
      patch({
        name: `${src.name || 'Agent'} (Copy)`,
        description: src.description || '',
        soul: src.soul || '',
        systemPrompt: src.systemPrompt || '',
        provider: src.provider || 'claude-cli',
        model: src.model || '',
        credentialId: src.credentialId || null,
        apiEndpoint: src.apiEndpoint || null,
        gatewayProfileId: src.gatewayProfileId || null,
        preferredGatewayTagsText: formatGatewayTagList(src.preferredGatewayTags),
        preferredGatewayUseCase: src.preferredGatewayUseCase || '',
        routingStrategy: src.routingStrategy || 'single',
        routingTargets: src.routingTargets || [],
        role: src.role === 'coordinator' ? 'coordinator' : 'worker',
        delegationEnabled: src.delegationEnabled === true,
        delegationTargetMode: src.delegationTargetMode === 'selected' ? 'selected' : 'all',
        delegationTargetAgentIds: src.delegationTargetAgentIds || [],
        tools: getEnabledToolIds(src),
        toolAccessMode: src.toolAccessMode === 'scoped' ? 'scoped' : 'universal',
        extensions: getEnabledExtensionIds(src),
        skills: src.skills || [],
        skillIds: src.skillIds || [],
        mcpServerIds: src.mcpServerIds || [],
        mcpDisabledTools: src.mcpDisabledTools || [],
        fallbackCredentialIds: src.fallbackCredentialIds || [],
        capabilities: Array.isArray(src.capabilities) ? src.capabilities : [],
        ollamaMode: resolveStoredOllamaMode({
          ollamaMode: src.ollamaMode ?? null,
          apiEndpoint: src.apiEndpoint ?? null,
        }),
        openclawEnabled: src.provider === 'openclaw',
        projectId: src.projectId,
        avatarSeed: Math.random().toString(36).slice(2, 10),
        avatarUrl: null,
        thinkingLevel: src.thinkingLevel || '',
        memoryScopeMode: src.memoryScopeMode || 'auto',
        memoryTierPreference: src.memoryTierPreference || 'blended',
        proactiveMemory: src.proactiveMemory !== false,
        autoDraftSkillSuggestions: src.autoDraftSkillSuggestions !== false,
        planningMode: normalizeAgentPlanningMode(src.planningMode),
        autoRecovery: src.autoRecovery || false,
        disabled: false,
        filesystemScope: src.filesystemScope === 'machine' ? 'machine' : 'workspace',
        voiceId: src.elevenLabsVoiceId || '',
        replyNotificationsMuted: src.replyNotificationsMuted === true,
        heartbeatEnabled: src.heartbeatEnabled || false,
        heartbeatIntervalSec: parseDurationToSec(src.heartbeatInterval, src.heartbeatIntervalSec),
        heartbeatModel: src.heartbeatModel || '',
        heartbeatPrompt: src.heartbeatPrompt || '',
        dreamEnabled: src.dreamEnabled || false,
        dreamCooldownMinutes: src.dreamConfig?.cooldownMinutes != null ? String(src.dreamConfig.cooldownMinutes) : '360',
        dreamTier2Enabled: src.dreamConfig?.tier2Enabled !== false,
        orchestratorEnabled: src.orchestratorEnabled || false,
        orchestratorMission: src.orchestratorMission || '',
        orchestratorWakeInterval: typeof src.orchestratorWakeInterval === 'string' ? src.orchestratorWakeInterval : typeof src.orchestratorWakeInterval === 'number' ? `${src.orchestratorWakeInterval}s` : '5m',
        orchestratorGovernance: src.orchestratorGovernance || 'autonomous',
        orchestratorMaxCyclesPerDay: src.orchestratorMaxCyclesPerDay != null ? String(src.orchestratorMaxCyclesPerDay) : '',
        sessionResetMode: src.sessionResetMode || '',
        sessionIdleTimeoutSec: src.sessionIdleTimeoutSec != null ? String(src.sessionIdleTimeoutSec) : '',
        sessionMaxAgeSec: src.sessionMaxAgeSec != null ? String(src.sessionMaxAgeSec) : '',
        sessionDailyResetAt: src.sessionDailyResetAt || '',
        sessionResetTimezone: src.sessionResetTimezone || '',
        identityPersonaLabel: src.identityState?.personaLabel || '',
        identitySelfSummary: src.identityState?.selfSummary || '',
        identityRelationshipSummary: src.identityState?.relationshipSummary || '',
        identityToneStyle: src.identityState?.toneStyle || '',
        identityBoundariesText: formatIdentityList(src.identityState?.boundaries),
        identityContinuityNotesText: formatIdentityList(src.identityState?.continuityNotes),
        budgetEnabled: (typeof src.hourlyBudget === 'number' && src.hourlyBudget > 0)
          || (typeof src.dailyBudget === 'number' && src.dailyBudget > 0)
          || (typeof src.monthlyBudget === 'number' && src.monthlyBudget > 0),
        hourlyBudget: typeof src.hourlyBudget === 'number' && src.hourlyBudget > 0 ? String(src.hourlyBudget) : '',
        dailyBudget: typeof src.dailyBudget === 'number' && src.dailyBudget > 0 ? String(src.dailyBudget) : '',
        monthlyBudget: typeof src.monthlyBudget === 'number' && src.monthlyBudget > 0 ? String(src.monthlyBudget) : '',
        budgetAction: src.budgetAction || 'warn',
      })
    } else {
      const newSoul = randomSoul()
      setSoulInitial(newSoul)
      setSoulSaveState('idle')
      setCapInput('')
      patch({
        name: '',
        description: '',
        soul: newSoul,
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
        tools: getDefaultAgentToolIds(),
        toolAccessMode: 'scoped',
        extensions: [],
        skills: [],
        skillIds: [],
        mcpDisabledTools: [],
        fallbackCredentialIds: [],
        capabilities: [],
        ollamaMode: 'local',
        openclawEnabled: false,
        projectId: undefined,
        avatarSeed: '',
        thinkingLevel: '',
        memoryScopeMode: 'auto',
        memoryTierPreference: 'blended',
        proactiveMemory: true,
        autoDraftSkillSuggestions: true,
        planningMode: 'off',
        autoRecovery: false,
        disabled: false,
        voiceId: '',
        replyNotificationsMuted: false,
        heartbeatEnabled: true,
        heartbeatIntervalSec: '',
        heartbeatModel: '',
        heartbeatPrompt: '',
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
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, reloadKey, editingLoaded])

  useEffect(() => {
    if (!editingId) {
      setConfigVersions([])
      setConfigVersionsError(null)
      setConfigVersionsLoading(false)
      setRestoringConfigVersionId(null)
      return
    }
    void loadAgentConfigVersions(editingId)
  }, [editingId, loadAgentConfigVersions])

  useEffect(() => {
    if (skipAutoModelRef.current) {
      skipAutoModelRef.current = false
      return
    }
    if (currentProvider?.models.length && !editing) {
      patch({ model: currentProvider.models[0] })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, agentSelectableProviders])

  // Reset test status when connection params change
  useEffect(() => {
    setTestStatus('idle')
    setTestMessage('')
    setTestDiagnostics([])
  }, [provider, credentialId, apiEndpoint])

  // Fetch MCP tools when selected servers change
  useEffect(() => {
    if (!mcpServerIds.length) {
      setMcpTools({})
      return
    }
    let cancelled = false
    setMcpToolsLoading(true)
    Promise.all(
      mcpServerIds.map(async (id) => {
        try {
          const tools = await api<{ name: string; description: string }[]>('GET', `/mcp-servers/${id}/tools`)
          return { id, tools: Array.isArray(tools) ? tools : [] }
        } catch {
          return { id, tools: [] }
        }
      })
    ).then((results) => {
      if (cancelled) return
      const map: Record<string, { name: string; description: string }[]> = {}
      for (const r of results) map[r.id] = r.tools
      setMcpTools(map)
      setMcpToolsLoading(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpServerIds.join(',')])

  // Fetch OpenClaw device ID when toggle is enabled
  useEffect(() => {
    if (!openclawEnabled) return
    let cancelled = false
    api<{ deviceId: string }>('GET', '/setup/openclaw-device').then((res) => {
      if (!cancelled && res.deviceId) setOpenclawDeviceId(res.deviceId)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [openclawEnabled])

  // After a save, delete, restore or import: nothing is unsaved any more, and
  // the page may move on. `router.replace` skips the leave guard on purpose.
  // The connection test belongs to the settings just written: a stale 'pass'
  // would keep Save disabled on an agent that stays open.
  const afterWrite = (next: { goTo: string | null }) => {
    setDirty(false)
    setTestStatus('idle')
    setTestMessage('')
    setTestErrorCode(null)
    setTestDiagnostics([])
    if (next.goTo) router.replace(next.goTo)
    else if (editingId) void loadAgentConfigVersions(editingId)
  }

  // While edits are unsaved: in-app navigation asks first, reload/close warns
  // (in a browser), and the tab host is told this frame cannot be put to sleep.
  // A missing agent has nothing to lose, so it holds no guard.
  const agentMissing = Boolean(editingId && !editing)
  // The live guard's release, so confirming the leave dialog can drop the guard
  // before navigating instead of waiting for this effect's cleanup.
  const releaseLeaveGuardRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!dirty || agentMissing) return
    const release = setLeaveGuard((proceed) => setLeavePrompt(() => proceed))
    releaseLeaveGuardRef.current = release
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault() }
    const warnOnUnload = !insideDesktopApp()
    if (warnOnUnload) window.addEventListener('beforeunload', onBeforeUnload)
    const releaseFlush = onTabFlushRequest(async () => false)
    return () => {
      release()
      if (releaseLeaveGuardRef.current === release) releaseLeaveGuardRef.current = null
      releaseFlush()
      if (warnOnUnload) window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [dirty, agentMissing])

  const applyGatewayProfileSelection = (nextGatewayProfileId: string | null) => {
    userPatch({ gatewayProfileId: nextGatewayProfileId })
    const gateway = openclawGatewayProfiles.find((item) => item.id === nextGatewayProfileId)
    if (!gateway) return
    patch({ provider: 'openclaw' })
    patch({ openclawEnabled: true })
    patch({ apiEndpoint: gateway.endpoint })
    if (gateway.credentialId) patch({ credentialId: gateway.credentialId })
    if (!model) patch({ model: 'default' })
  }

  const applyDirectProviderSelection = (nextProviderId: string) => {
    const nextProvider = agentSelectableProviders.find((item) => item.id === nextProviderId)
    const nextCredentials = resolveAgentSelectableProviderCredentials(nextProviderId, credentials, providerConfigs)
    userPatch({ provider: nextProviderId })
    patch({ model: nextProvider?.models[0] || '' })
    patch({ credentialId: nextCredentials[0]?.id || null })
    patch({ fallbackCredentialIds: [] })
    patch({ gatewayProfileId: null })
    patch({ apiEndpoint: nextProvider?.requiresEndpoint ? nextProvider.defaultEndpoint || null : null })
    setTestStatus('idle')
    setTestMessage('')
    setTestErrorCode(null)
    setTestDiagnostics([])
    setAddingKey(false)
    setNewKeyName('')
    setNewKeyValue('')
  }

  const updateRoutingTarget = (targetId: string, targetPatch: Partial<AgentRoutingTarget>) => {
    userPatch((d) => ({
      routingTargets: d.routingTargets.map((target) => (
        target.id === targetId
          ? { ...target, ...targetPatch }
          : target
      )),
    }))
  }

  const removeRoutingTarget = (targetId: string) => {
    userPatch((d) => ({ routingTargets: d.routingTargets.filter((target) => target.id !== targetId) }))
  }

  const addRoutingTargetFromCurrent = () => {
    const nextTarget: AgentRoutingTarget = {
      id: Math.random().toString(16).slice(2, 10),
      label: routingTargets.length === 0 ? 'Primary route' : `Route ${routingTargets.length + 1}`,
      role: routingTargets.length === 0 ? 'primary' : 'backup',
      provider,
      model,
      ollamaMode: provider === 'ollama' ? ollamaMode : null,
      credentialId,
      fallbackCredentialIds,
      apiEndpoint,
      gatewayProfileId,
      preferredGatewayTags: parseGatewayTagList(preferredGatewayTagsText),
      preferredGatewayUseCase: preferredGatewayUseCase || null,
      priority: routingTargets.length + 1,
    }
    userPatch((d) => ({ routingTargets: [...d.routingTargets, nextTarget] }))
  }

  const handleSave = async () => {
    // For any endpoint, just ensure bare host:port gets a protocol prepended
    const providerAllowsAgentEndpoint = Boolean(openclawEnabled || currentProvider?.requiresEndpoint || currentProvider?.optionalEndpoint)
    let normalizedEndpoint = providerAllowsAgentEndpoint ? apiEndpoint : null
    if (normalizedEndpoint) {
      const url = normalizedEndpoint.trim().replace(/\/+$/, '')
      normalizedEndpoint = /^(https?|wss?):\/\//i.test(url) ? url : `http://${url}`
    }
    const parsedHourlyBudget = budgetEnabled && hourlyBudget ? Number(hourlyBudget) : null
    const parsedDailyBudget = budgetEnabled && dailyBudget ? Number(dailyBudget) : null
    const parsedMonthlyBudget = budgetEnabled && monthlyBudget ? Number(monthlyBudget) : null
    const parsedSessionIdleTimeoutSec = sessionIdleTimeoutSec ? Number(sessionIdleTimeoutSec) : null
    const parsedSessionMaxAgeSec = sessionMaxAgeSec ? Number(sessionMaxAgeSec) : null
    const identityBoundaries = parseIdentityList(identityBoundariesText)
    const identityContinuityNotes = parseIdentityList(identityContinuityNotesText)
    const identityState = (() => {
      const value = {
        personaLabel: identityPersonaLabel.trim() || undefined,
        selfSummary: identitySelfSummary.trim() || undefined,
        relationshipSummary: identityRelationshipSummary.trim() || undefined,
        toneStyle: identityToneStyle.trim() || undefined,
        boundaries: identityBoundaries.length ? identityBoundaries : undefined,
        continuityNotes: identityContinuityNotes.length ? identityContinuityNotes : undefined,
      }
      return Object.values(value).some((entry) => Array.isArray(entry) ? entry.length > 0 : Boolean(entry)) ? value : null
    })()
    const data = {
      name: name.trim() || 'Unnamed Agent',
      description,
      soul,
      systemPrompt,
      provider,
      model,
      ollamaMode: provider === 'ollama' ? ollamaMode : null,
      credentialId,
      apiEndpoint: normalizedEndpoint,
      gatewayProfileId,
      preferredGatewayTags: parseGatewayTagList(preferredGatewayTagsText),
      preferredGatewayUseCase: preferredGatewayUseCase || null,
      routingStrategy,
      routingTargets: routingTargets.map((target, index) => ({
        ...target,
        ollamaMode: target.provider === 'ollama'
          ? resolveStoredOllamaMode({
            ollamaMode: target.ollamaMode ?? null,
            apiEndpoint: target.apiEndpoint ?? null,
          })
          : null,
        preferredGatewayTags: parseGatewayTagList(formatGatewayTagList(target.preferredGatewayTags)),
        preferredGatewayUseCase: target.preferredGatewayUseCase || null,
        priority: typeof target.priority === 'number' ? target.priority : index + 1,
      })),
      role,
      delegationEnabled: role === 'coordinator' ? true : delegationEnabled,
      delegationTargetMode: delegationEnabled || role === 'coordinator' ? delegationTargetMode : 'all',
      delegationTargetAgentIds: (delegationEnabled || role === 'coordinator') && delegationTargetMode === 'selected' ? delegationTargetAgentIds : [],
      tools,
      toolAccessMode,
      extensions,
      skills,
      skillIds,
      mcpServerIds,
      mcpDisabledTools: mcpDisabledTools.length ? mcpDisabledTools : undefined,
      fallbackCredentialIds,
      capabilities,
      projectId: projectId || undefined,
      avatarSeed: avatarSeed.trim() || undefined,
      avatarUrl: avatarUrl || null,
      thinkingLevel: thinkingLevel || undefined,
      memoryScopeMode,
      memoryTierPreference,
      proactiveMemory,
      autoDraftSkillSuggestions,
      planningMode,
      autoRecovery,
      disabled,
      filesystemScope: filesystemScope === 'machine' ? 'machine' as const : undefined,
      elevenLabsVoiceId: voiceId.trim() || null,
      replyNotificationsMuted,
      heartbeatEnabled,
      heartbeatInterval: heartbeatIntervalSec ? formatHbDuration(Number(heartbeatIntervalSec)) : null,
      heartbeatIntervalSec: heartbeatIntervalSec ? Number(heartbeatIntervalSec) : null,
      heartbeatModel: heartbeatModel.trim() || null,
      heartbeatPrompt: heartbeatPrompt.trim() || null,
      dreamEnabled,
      dreamConfig: dreamEnabled
        ? { cooldownMinutes: Number(dreamCooldownMinutes) || 360, tier2Enabled: dreamTier2Enabled }
        : null,
      orchestratorEnabled,
      orchestratorMission: orchestratorMission.trim() || undefined,
      orchestratorWakeInterval: orchestratorWakeInterval.trim() || null,
      orchestratorGovernance,
      orchestratorMaxCyclesPerDay: orchestratorMaxCyclesPerDay ? Number(orchestratorMaxCyclesPerDay) : null,
      identityState,
      sessionResetMode: sessionResetMode || null,
      sessionIdleTimeoutSec: Number.isFinite(parsedSessionIdleTimeoutSec) && parsedSessionIdleTimeoutSec! >= 0 ? parsedSessionIdleTimeoutSec : null,
      sessionMaxAgeSec: Number.isFinite(parsedSessionMaxAgeSec) && parsedSessionMaxAgeSec! >= 0 ? parsedSessionMaxAgeSec : null,
      sessionDailyResetAt: sessionDailyResetAt.trim() || null,
      sessionResetTimezone: sessionResetTimezone.trim() || null,
      hourlyBudget: parsedHourlyBudget && parsedHourlyBudget > 0 ? parsedHourlyBudget : null,
      dailyBudget: parsedDailyBudget && parsedDailyBudget > 0 ? parsedDailyBudget : null,
      monthlyBudget: parsedMonthlyBudget && parsedMonthlyBudget > 0 ? parsedMonthlyBudget : null,
      budgetAction: budgetEnabled ? budgetAction : undefined,
    }
    if (WORKER_ONLY_PROVIDER_IDS.has(provider)) {
      data.role = 'worker'
      data.delegationEnabled = false
      data.heartbeatEnabled = false
      data.heartbeatInterval = null
      data.heartbeatIntervalSec = null
      data.heartbeatModel = null
      data.heartbeatPrompt = null
      data.dreamEnabled = false
      data.dreamConfig = null
    }
    const savedAgent = editing
      ? await updateAgent(editing.id, data)
      : await createAgent(data)
    updateAgentInStore(savedAgent)
    if (editing) {
      toast.success('Agent saved')
    } else {
      toast.success('Agent created')
    }
    await loadAgents()
    if (
      editing
      && activeSessionId
      && currentSession?.agentId === editing.id
      && (
        currentSession.shortcutForAgentId === editing.id
        || activeSessionId === editing.threadSessionId
      )
    ) {
      await refreshSession(activeSessionId)
    }
    setSoulInitial(soul)
    setSoulSaveState('saved')
    setTimeout(() => setSoulSaveState('idle'), 1500)
    afterWrite({ goTo: editing ? null : `/agents/${encodeURIComponent(savedAgent.id)}` })
  }

  const handleDelete = async () => {
    if (editing) {
      await deleteAgent(editing.id)
      toast.success('Agent moved to trash')
      await loadAgents()
      afterWrite({ goTo: '/agents' })
    }
  }

  // Asked through the restore ConfirmDialog below.
  const handleRestoreConfigVersion = (versionId: string) => {
    if (!editing) return
    setRestorePromptVersionId(versionId)
  }

  const restoreConfigVersion = async (versionId: string) => {
    if (!editing) return
    setRestoringConfigVersionId(versionId)
    try {
      await api('POST', '/config-versions/restore', { versionId })
      await loadAgents()
      if (
        activeSessionId
        && currentSession?.agentId === editing.id
        && (
          currentSession.shortcutForAgentId === editing.id
          || activeSessionId === editing.threadSessionId
        )
      ) {
        await refreshSession(activeSessionId)
      }
      toast.success('Agent configuration restored')
      afterWrite({ goTo: null })
      // Show the restored settings, not the ones that were on screen before.
      setReloadKey((key) => key + 1)
    } catch (err) {
      toast.error(`Restore failed: ${errorMessage(err)}`)
    } finally {
      setRestoringConfigVersionId(null)
    }
  }

  const handleExport = () => {
    if (!editing) return
    const recommendedProviders = agentSelectableProviders.some((providerOption) => (
      providerOption.id === editing.provider && providerOption.type === 'builtin'
    ))
      ? [editing.provider as ProviderType]
      : undefined
    const pack: AgentPackManifest = {
      schemaVersion: 1,
      kind: 'swarmclaw-agent-pack',
      name: `${editing.name} Pack`,
      description: editing.description || undefined,
      exportedAt: Date.now(),
      recommendedProviders,
      agents: [{
        id: editing.name.replace(/\s+/g, '-').toLowerCase(),
        name: editing.name,
        description: editing.description || undefined,
        provider: editing.provider,
        model: editing.model,
        ollamaMode: editing.provider === 'ollama' ? (editing.ollamaMode || 'local') : null,
        credentialId: editing.credentialId || null,
        fallbackCredentialIds: editing.fallbackCredentialIds || [],
        apiEndpoint: editing.apiEndpoint || null,
        gatewayProfileId: editing.gatewayProfileId || null,
        routingStrategy: editing.routingStrategy || null,
        routingTargets: editing.routingTargets || [],
        tools: getEnabledToolIds(editing),
        extensions: getEnabledExtensionIds(editing),
        capabilities: editing.capabilities,
        elevenLabsVoiceId: editing.elevenLabsVoiceId || null,
        planningMode: normalizeAgentPlanningMode(editing.planningMode),
        soul: editing.soul,
        systemPrompt: editing.systemPrompt,
      }],
    }
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${editing.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.agent-pack.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Agent pack exported')
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string)
        const importedAgent = data?.kind === 'swarmclaw-agent-pack'
          ? data?.agents?.[0]
          : data
        if (!importedAgent || typeof importedAgent !== 'object') throw new Error('Invalid agent pack')
        // Strip IDs and timestamps
        const { id: _id, createdAt: _ca, updatedAt: _ua, threadSessionId: _ts, ...agentData } = importedAgent
        void [_id, _ca, _ua, _ts]
        const imported = await createAgent({ ...agentData, name: agentData.name || 'Imported Agent' })
        await loadAgents()
        toast.success(data?.kind === 'swarmclaw-agent-pack' ? 'Agent pack imported' : 'Agent imported')
        afterWrite({ goTo: `/agents/${encodeURIComponent(imported.id)}` })
      } catch {
        toast.error('Invalid agent JSON file')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleTestConnection = async (): Promise<boolean> => {
    setTestStatus('testing')
    setTestMessage('')
    setTestErrorCode(null)
    setTestDiagnostics([])
    try {
      const result = await api<{ ok: boolean; message: string; errorCode?: string; deviceId?: string; diagnostics?: ProviderDiagnosticStep[] }>('POST', '/setup/check-provider', {
        provider,
        credentialId,
        endpoint: apiEndpoint,
        model,
        ollamaMode: provider === 'ollama' ? ollamaMode : null,
      }, {
        timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
      })
      setTestDiagnostics(result.diagnostics ?? [])
      if (result.deviceId) setTestDeviceId(result.deviceId)
      if (result.ok) {
        let syncedModels: string[] = []
        try {
          const synced = await syncLiveProviderModels(provider, credentialId, apiEndpoint, ollamaMode, true)
          syncedModels = synced?.models || []
        } catch {
          // Best-effort: a passing connection test should still pass if model sync fails.
        }
        setTestStatus('pass')
        setTestMessage(
          syncedModels.length > 0
            ? `${result.message} Synced ${syncedModels.length} live model${syncedModels.length === 1 ? '' : 's'} into the model picker.`
            : result.message,
        )
        return true
      } else {
        setTestStatus('fail')
        setTestMessage(result.message)
        setTestErrorCode(result.errorCode || null)
        toast.error(result.message || 'Connection test failed')
        return false
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Connection test failed'
      setTestStatus('fail')
      setTestMessage(msg)
      setTestDiagnostics([])
      toast.error(msg)
      return false
    }
  }

  // Whether this provider needs a connection test before saving.
  // Only CLI providers (no remote connection) skip the test.
  const needsTest = !providerNeedsKey && !NON_LANGGRAPH_PROVIDER_IDS.has(provider)

  const [saving, setSaving] = useState(false)

  const handleTestAndSave = async () => {
    if (needsTest) {
      const passed = await handleTestConnection()
      if (!passed) return
      if (!openclawEnabled) {
        // Brief pause so the user can see the success state on the button
        await sleep(1500)
      }
    }
    setSaving(true)
    await handleSave()
    setSaving(false)
  }

  const canDelegateToAgents = delegationEnabled || role === 'coordinator'
  const agentOptions = Object.values(agents).filter((p) => p.id !== editingId)
  const toggleAgent = (id: string) => {
    userPatch((d) => {
      const next = d.delegationTargetAgentIds.includes(id) ? d.delegationTargetAgentIds.filter((x) => x !== id) : [...d.delegationTargetAgentIds, id]
      return {
        delegationTargetMode: next.length === 0 ? 'all' : 'selected',
        delegationTargetAgentIds: next,
      }
    })
  }

  const inputClass ="w-full px-4 py-3.5 rounded-md border border-line-default bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3 focus-glow"
  const configVersionSummaries = configVersions.map((version) => buildAgentConfigVersionSummary(version))

  if (editingId && !editing) {
    if (!agentsChecked) return <PageLoader />
    return (
      <EmptyState
        icon={
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        }
        title="Agent not found"
        subtitle="It may have been moved to the trash. Pick another agent from the list."
        action={{ label: 'Back to agents', onClick: () => router.replace('/agents') }}
      />
    )
  }

  return (
    <>
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="mx-auto max-w-[960px] px-5 sm:px-8 py-6">
      <div className="mb-8">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[28px] font-700 tracking-[-0.03em]">
              {editing ? editing.name : 'New Agent'}
            </h2>
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-700 tracking-[0.03em] ${
              disabled
                ? 'border border-amber-400/20 bg-amber-400/[0.08] text-amber-300'
                : 'border border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300'
            }`}>
              {disabled ? 'Disabled' : 'Enabled'}
            </span>
          </div>
          <p className="text-[14px] text-text-3">Essentials holds the fields you edit most. The other five tabs hold everything else.</p>
        </div>
      </div>

      <div className="sticky top-0 z-30 -mx-5 mb-6 flex items-center gap-1 border-b border-line-subtle bg-bg px-5 pt-3 sm:-mx-8 sm:px-8 sm:pt-5">
        {AGENT_SHEET_TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            aria-current={entry.key === tab ? 'page' : undefined}
            className={`relative cursor-pointer rounded-t-sm px-3 py-2.5 text-[12px] transition-colors ${
              entry.key === tab ? 'font-600 text-accent-bright' : 'text-text-3 hover:text-text-2'
            }`}
            style={{ fontFamily: 'inherit' }}
          >
            {entry.label}
            {entry.key === tab && (
              <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-sm bg-accent-bright" />
            )}
          </button>
        ))}
      </div>

      {tab === 'essentials' && (
        <TabEssentials
          draft={draft}
          patch={userPatch}
          inputClass={inputClass}
          agentSelectableProviders={agentSelectableProviders}
          currentProvider={currentProvider}
          providerCredentials={providerCredentials}
          credentials={credentials}
          providerConfigs={providerConfigs}
          openclawCredentials={openclawCredentials}
          openclawGatewayProfiles={openclawGatewayProfiles}
          applyGatewayProfileSelection={applyGatewayProfileSelection}
          applyDirectProviderSelection={applyDirectProviderSelection}
          loadCredentials={loadCredentials}
          syncLiveProviderModels={syncLiveProviderModels}
          addingKey={addingKey}
          setAddingKey={setAddingKey}
          newKeyName={newKeyName}
          setNewKeyName={setNewKeyName}
          newKeyValue={newKeyValue}
          setNewKeyValue={setNewKeyValue}
          savingKey={savingKey}
          setSavingKey={setSavingKey}
          uploading={uploading}
          setUploading={setUploading}
          testStatus={testStatus}
          setTestStatus={setTestStatus}
          testMessage={testMessage}
          setTestMessage={setTestMessage}
          testErrorCode={testErrorCode}
          setTestErrorCode={setTestErrorCode}
          testDiagnostics={testDiagnostics}
          setTestDiagnostics={setTestDiagnostics}
          testDeviceId={testDeviceId}
          openclawDeviceId={openclawDeviceId}
          configCopied={configCopied}
          setConfigCopied={setConfigCopied}
          soulInitial={soulInitial}
          soulSaveState={soulSaveState}
          providerNeedsKey={providerNeedsKey}
          onOpenSoulLibrary={() => setSoulLibraryOpen(true)}
        />
      )}
      {tab === 'behavior' && (
        <TabBehavior
          draft={draft}
          patch={userPatch}
          inputClass={inputClass}
          canDelegateToAgents={canDelegateToAgents}
          agentOptions={agentOptions}
          toggleAgent={toggleAgent}
          voiceControlsAvailable={voiceControlsAvailable}
          voicePlaybackEnabled={voicePlaybackEnabled}
          effectiveVoiceId={effectiveVoiceId}
          effectiveVoiceSource={effectiveVoiceSource}
        />
      )}
      {tab === 'tools' && (
        <TabTools
          draft={draft}
          patch={userPatch}
          inputClass={inputClass}
          enabledExtensionIds={enabledExtensionIds}
          externalTools={externalTools}
          claudeSkills={claudeSkills}
          claudeSkillsLoading={claudeSkillsLoading}
          loadClaudeSkills={loadClaudeSkills}
          dynamicSkills={dynamicSkills}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          mcpToolsLoading={mcpToolsLoading}
          capInput={capInput}
          setCapInput={setCapInput}
        />
      )}
      {tab === 'memory' && (
        <TabMemory draft={draft} patch={userPatch} inputClass={inputClass} />
      )}
      {tab === 'network' && (
        <TabNetwork
          draft={draft}
          patch={userPatch}
          inputClass={inputClass}
          editing={editing}
          projects={projects}
          credentials={credentials}
          providerConfigs={providerConfigs}
          agentSelectableProviders={agentSelectableProviders}
          openclawGatewayProfiles={openclawGatewayProfiles}
          updateRoutingTarget={updateRoutingTarget}
          removeRoutingTarget={removeRoutingTarget}
          addRoutingTargetFromCurrent={addRoutingTargetFromCurrent}
        />
      )}
      {tab === 'advanced' && (
        <TabAdvanced
          draft={draft}
          editing={editing}
          configVersionSummaries={configVersionSummaries}
          configVersionsLoading={configVersionsLoading}
          configVersionsError={configVersionsError}
          restoringConfigVersionId={restoringConfigVersionId}
          loadAgentConfigVersions={loadAgentConfigVersions}
          handleRestoreConfigVersion={handleRestoreConfigVersion}
          handleExport={handleExport}
          onImportClick={() => importFileRef.current?.click()}
        />
      )}

      {/* Provider key warning */}
      {providerNeedsKey && (
        <div className="mb-4 p-3 rounded-lg bg-amber-500/[0.08] border border-amber-500/20">
          <p className="text-[13px] text-amber-400">
            Add an API key for {currentProvider?.name || provider} on the Essentials tab before creating this agent.
          </p>
        </div>
      )}

      {/* Test connection result (hidden for OpenClaw — inline status block handles it) */}
      {!openclawEnabled && testStatus === 'fail' && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/[0.08] border border-red-500/20">
          <p className="text-[13px] text-red-400">{testMessage || 'Connection test failed'}</p>
          <ProviderDiagnosticsList diagnostics={testDiagnostics} />
        </div>
      )}
      {!openclawEnabled && testStatus === 'pass' && (
        <div className="mb-4 p-3 rounded-lg bg-emerald-500/[0.08] border border-emerald-500/20">
          <p className="text-[13px] text-emerald-400">{testMessage || 'Connected successfully'}</p>
          <ProviderDiagnosticsList diagnostics={testDiagnostics} />
        </div>
      )}

      {/* Import file input (hidden) */}
      <input ref={importFileRef} type="file" accept=".json" onChange={handleImport} className="hidden" />

      <div className="sticky bottom-0 z-30 -mx-5 mt-2 flex gap-3 border-t border-line-subtle bg-bg px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:-mx-8 sm:px-8 sm:pb-8">
        {editing && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-full border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        {dirty && (
          <button onClick={() => setReloadKey((key) => key + 1)} className="flex-1 py-3.5 rounded-full border border-line-default bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
            Discard
          </button>
        )}
        <button
          onClick={handleTestAndSave}
          disabled={!name.trim() || providerNeedsKey || testStatus === 'testing' || saving || (!openclawEnabled && testStatus === 'pass')}
          className={`flex-1 py-3.5 rounded-full border-none text-accent-fg text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-60 transition-all hover:brightness-110
            ${testStatus === 'pass' ? 'bg-emerald-600 ' : 'bg-accent-bright'}`}
          style={{ fontFamily: 'inherit' }}
        >
          {openclawEnabled
            ? (testStatus === 'testing' ? 'Connecting...'
              : testStatus === 'pass' ? (saving ? 'Saving...' : 'Save')
              : testStatus === 'fail' && testErrorCode === 'PAIRING_REQUIRED' ? 'Retry Connection'
              : testStatus === 'fail' ? 'Retry'
              : 'Connect')
            : (testStatus === 'testing' ? 'Testing...' : testStatus === 'pass' ? (saving ? 'Saving...' : 'Connected!') : needsTest ? 'Test & Save' : editing ? 'Save' : 'Create')}
        </button>
      </div>
    </div>
    </div>

    <SoulLibraryPicker
      open={soulLibraryOpen}
      onClose={() => setSoulLibraryOpen(false)}
      onSelect={(s) => userPatch({ soul: s })}
    />
    <ConfirmDialog
      open={leavePrompt !== null}
      title="Unsaved changes"
      message="This agent has unsaved changes. Discard them and continue?"
      confirmLabel="Discard"
      danger
      onConfirm={() => {
        // `go` may ask the guard again (a caller that wraps `useNavigate`, or
        // a second `requestLeave` on the way), and the dirty effect's cleanup
        // only runs after this render, so the guard is dropped here first.
        const go = leavePrompt
        setLeavePrompt(null)
        setDirty(false)
        releaseLeaveGuardRef.current?.()
        releaseLeaveGuardRef.current = null
        go?.()
      }}
      onCancel={() => setLeavePrompt(null)}
    />
    <ConfirmDialog
      open={restorePromptVersionId !== null}
      title="Restore configuration"
      message="Restore this saved agent configuration? Current settings will become a new history entry when restored."
      confirmLabel="Restore"
      onConfirm={() => {
        const versionId = restorePromptVersionId
        setRestorePromptVersionId(null)
        if (versionId) void restoreConfigVersion(versionId)
      }}
      onCancel={() => setRestorePromptVersionId(null)}
    />
    </>
  )
}
