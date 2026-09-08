'use client'

import { HintTip } from '@/components/shared/hint-tip'
import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import { resolveStoredOllamaMode } from '@/lib/ollama-mode'
import { resolveAgentSelectableProviderCredentials, type AgentSelectableProvider } from '@/lib/agent-provider-options'
import { AgentSocialSettings } from '@/features/swarmfeed/agent-social-settings'
import { AgentMarketplaceSettings } from '@/features/swarmdock/agent-marketplace-settings'
import type { Agent, AgentRoutingStrategy, AgentRoutingTarget, Credentials, GatewayProfile, Project, ProviderConfig } from '@/types'
import { SectionCard, TabEmptyNote } from './section-card'
import { formatGatewayTagList, parseGatewayTagList } from './agent-sheet-format'
import type { AgentTabProps } from './agent-draft'

interface Props extends AgentTabProps {
  inputClass: string
  editing: Agent | null
  projects: Record<string, Project>
  credentials: Credentials
  providerConfigs: ProviderConfig[]
  agentSelectableProviders: AgentSelectableProvider[]
  openclawGatewayProfiles: GatewayProfile[]
  updateRoutingTarget: (targetId: string, targetPatch: Partial<AgentRoutingTarget>) => void
  removeRoutingTarget: (targetId: string) => void
  addRoutingTargetFromCurrent: () => void
}

/** Social Network, Marketplace, Routing & Infrastructure - moved verbatim. */
export function TabNetwork({
  draft,
  patch,
  inputClass,
  editing,
  projects,
  credentials,
  providerConfigs,
  agentSelectableProviders,
  openclawGatewayProfiles,
  updateRoutingTarget,
  removeRoutingTarget,
  addRoutingTargetFromCurrent,
}: Props) {
  const {
    provider,
    preferredGatewayTagsText,
    preferredGatewayUseCase,
    routingStrategy,
    routingTargets,
    openclawEnabled,
    projectId,
    filesystemScope,
  } = draft
  const workerOnly = WORKER_ONLY_PROVIDER_IDS.has(provider)

  return (
    <>
      {editing && (
        <SectionCard
          title="Social Network"
          description="SwarmFeed integration — let this agent post and engage on the social feed."
        >
          <AgentSocialSettings agent={editing} />
        </SectionCard>
      )}

      {editing && (
        <SectionCard
          title="Marketplace"
          description="SwarmDock integration — list this agent on the AI marketplace to accept tasks and earn USDC."
        >
          <AgentMarketplaceSettings agent={editing} />
        </SectionCard>
      )}

      {!workerOnly && (
      <SectionCard
        title="Routing & Infrastructure"
        description="Project binding, filesystem access, and other deeper runtime controls."
        className="mb-6 border-line-subtle bg-layer-1"
      >
      {Object.keys(projects).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Project</label>
          <select value={projectId || ''} onChange={(e) => patch({ projectId: e.target.value || undefined })} className={inputClass} style={{ fontFamily: 'inherit' }}>
            <option value="">No project</option>
            {Object.values(projects).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </div>
      )}
      {openclawEnabled && (
        <div className="mb-8">
          <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
            Gateway Preferences <HintTip text="When multiple OpenClaw gateways are available, prefer matching tags or deployment templates before falling back to the default route." />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              value={preferredGatewayTagsText}
              onChange={(e) => patch({ preferredGatewayTagsText: e.target.value })}
              placeholder="gpu, local, research"
              className={inputClass}
            />
            <select value={preferredGatewayUseCase} onChange={(e) => patch({ preferredGatewayUseCase: e.target.value })} className={inputClass}>
              <option value="">Any OpenClaw template</option>
              <option value="local-dev">Local Dev</option>
              <option value="single-vps">Single VPS</option>
              <option value="private-tailnet">Private Tailnet</option>
              <option value="browser-heavy">Browser Heavy</option>
              <option value="team-control">Team Control</option>
            </select>
          </div>
          <p className="text-[11px] text-text-3 mt-2">
            These preferences bias scheduling toward matching OpenClaw control planes without hard-locking the agent to one gateway.
          </p>
        </div>
      )}
      <div className="mb-8">
        <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
          Model Routing <HintTip text="Route this agent through a provider/model pool instead of a single fixed model. The base provider remains the default when no route matches." />
        </label>
        <div className="flex items-center gap-3 mb-3">
          <select value={routingStrategy} onChange={(e) => patch({ routingStrategy: e.target.value as AgentRoutingStrategy })} className={inputClass}>
            <option value="single">Single route</option>
            <option value="balanced">Balanced</option>
            <option value="economy">Economy</option>
            <option value="premium">Premium</option>
            <option value="reasoning">Reasoning</option>
          </select>
          <button
            type="button"
            onClick={addRoutingTargetFromCurrent}
            className="shrink-0 px-3 py-2.5 rounded-md bg-accent-soft/50 text-accent-bright text-[12px] font-700 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
          >
            + Add Current Route
          </button>
        </div>
        <div className="space-y-3">
          {routingTargets.map((target, index) => {
            const targetCredentials = resolveAgentSelectableProviderCredentials(target.provider, credentials, providerConfigs)
            return (
              <div key={target.id} className="p-4 rounded-lg border border-line-default bg-surface space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input
                    value={target.label || ''}
                    onChange={(e) => updateRoutingTarget(target.id, { label: e.target.value })}
                    placeholder={`Route ${index + 1} label`}
                    className={inputClass}
                  />
                  <select value={target.role || 'backup'} onChange={(e) => updateRoutingTarget(target.id, { role: e.target.value as AgentRoutingTarget['role'] })} className={inputClass}>
                    <option value="primary">Primary</option>
                    <option value="economy">Economy</option>
                    <option value="premium">Premium</option>
                    <option value="reasoning">Reasoning</option>
                    <option value="backup">Backup</option>
                  </select>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <select
                    value={target.provider}
                    onChange={(e) => {
                      const nextProviderId = e.target.value
                      const nextCredentials = resolveAgentSelectableProviderCredentials(nextProviderId, credentials, providerConfigs)
                      updateRoutingTarget(target.id, {
                        provider: nextProviderId,
                        credentialId: nextCredentials[0]?.id || null,
                        gatewayProfileId: nextProviderId === 'openclaw' ? target.gatewayProfileId : null,
                        ollamaMode: nextProviderId === 'ollama'
                        ? resolveStoredOllamaMode({
                          ollamaMode: target.ollamaMode ?? null,
                          apiEndpoint: target.apiEndpoint ?? null,
                        })
                        : null,
                      })
                    }}
                    className={inputClass}
                  >
                    {agentSelectableProviders.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                  <input
                    value={target.model}
                    onChange={(e) => updateRoutingTarget(target.id, { model: e.target.value })}
                    placeholder="Model"
                    className={inputClass}
                  />
                </div>
                {target.provider === 'openclaw' && openclawGatewayProfiles.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <select
                      value={target.gatewayProfileId || ''}
                      onChange={(e) => {
                        const nextId = e.target.value || null
                        const gateway = openclawGatewayProfiles.find((item) => item.id === nextId)
                        updateRoutingTarget(target.id, {
                          gatewayProfileId: nextId,
                          apiEndpoint: gateway?.endpoint || target.apiEndpoint || null,
                          credentialId: gateway?.credentialId || target.credentialId || null,
                          model: target.model || 'default',
                        })
                      }}
                      className={inputClass}
                    >
                      <option value="">Custom OpenClaw endpoint</option>
                      {openclawGatewayProfiles.map((gateway) => (
                        <option key={gateway.id} value={gateway.id}>{gateway.name}</option>
                      ))}
                    </select>
                    <input
                      value={formatGatewayTagList(target.preferredGatewayTags)}
                      onChange={(e) => updateRoutingTarget(target.id, { preferredGatewayTags: parseGatewayTagList(e.target.value) })}
                      placeholder="Prefer tags"
                      className={inputClass}
                    />
                    <select
                      value={target.preferredGatewayUseCase || ''}
                      onChange={(e) => updateRoutingTarget(target.id, { preferredGatewayUseCase: e.target.value || null })}
                      className={inputClass}
                    >
                      <option value="">Any OpenClaw template</option>
                      <option value="local-dev">Local Dev</option>
                      <option value="single-vps">Single VPS</option>
                      <option value="private-tailnet">Private Tailnet</option>
                      <option value="browser-heavy">Browser Heavy</option>
                      <option value="team-control">Team Control</option>
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
                  <input
                    value={target.apiEndpoint || ''}
                    onChange={(e) => updateRoutingTarget(target.id, { apiEndpoint: e.target.value || null })}
                    placeholder="Endpoint (optional)"
                    className={`${inputClass} font-mono text-[14px]`}
                  />
                  <select value={target.credentialId || ''} onChange={(e) => updateRoutingTarget(target.id, { credentialId: e.target.value || null })} className={inputClass}>
                    <option value="">No key</option>
                    {targetCredentials.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex justify-end">
                  <button type="button" onClick={() => removeRoutingTarget(target.id)} className="px-3 py-1.5 rounded-sm border border-red-400/20 bg-red-400/[0.06] text-[12px] font-700 text-red-300 hover:bg-red-400/[0.1] transition-all cursor-pointer">
                    Remove Route
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        {routingTargets.length === 0 && (
          <p className="text-[11px] text-text-3 mt-2">No route pool yet. Add one if this agent should switch between cheaper, stronger, or gateway-specific models.</p>
        )}
      </div>
      <div>
        <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Filesystem Access</label>
        <select
          value={filesystemScope}
          onChange={(e) => patch({ filesystemScope: e.target.value as 'workspace' | 'machine' })}
          className="w-full h-10 px-3 rounded-sm bg-layer-2 border border-line-subtle text-[14px] text-text-2"
        >
          <option value="workspace">Workspace only</option>
          <option value="machine">Full machine</option>
        </select>
        {filesystemScope === 'machine' && (
          <p className="mt-2 text-[12px] text-amber-400/80">Agent can access any file your user account can reach. Sensitive paths (.ssh, .env, .gnupg) are blocked by default.</p>
        )}
      </div>
      </SectionCard>
      )}

      {!editing && workerOnly && (
        <TabEmptyNote>
          SwarmFeed and SwarmDock settings appear once the agent exists, and model routing is applied
          by the SwarmClaw runtime that this provider bypasses. Save the agent to configure its
          social and marketplace presence.
        </TabEmptyNote>
      )}
    </>
  )
}
