'use client'

import { HintTip } from '@/components/shared/hint-tip'
import { AVAILABLE_TOOLS, PLATFORM_TOOLS } from '@/lib/tool-definitions'
import { MCP_INJECTION_PROVIDER_IDS, NATIVE_CAPABILITY_PROVIDER_IDS, WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import type { ClaudeSkill, McpServerConfig, Skill } from '@/types'
import { SectionCard, TabEmptyNote } from './section-card'
import type { AgentTabProps, ExtensionToolInfo } from './agent-draft'

interface Props extends AgentTabProps {
  inputClass: string
  enabledExtensionIds: Set<string> | null
  externalTools: ExtensionToolInfo[]
  claudeSkills: ClaudeSkill[]
  claudeSkillsLoading: boolean
  loadClaudeSkills: () => void
  dynamicSkills: Record<string, Skill>
  mcpServers: Record<string, McpServerConfig>
  mcpTools: Record<string, { name: string; description: string }[]>
  mcpToolsLoading: boolean
  capInput: string
  setCapInput: (value: string) => void
}

/** Context & Tool Access, Tools & Skills - moved verbatim. */
export function TabTools({
  draft,
  patch,
  inputClass,
  enabledExtensionIds,
  externalTools,
  claudeSkills,
  claudeSkillsLoading,
  loadClaudeSkills,
  dynamicSkills,
  mcpServers,
  mcpTools,
  mcpToolsLoading,
  capInput,
  setCapInput,
}: Props) {
  const {
    provider,
    tools,
    toolAccessMode,
    extensions,
    skills,
    skillIds,
    mcpServerIds,
    mcpDisabledTools,
    capabilities,
    openclawEnabled,
    filesystemScope,
  } = draft
  const workerOnly = WORKER_ONLY_PROVIDER_IDS.has(provider)
  const showToolsAndSkills = !workerOnly || MCP_INJECTION_PROVIDER_IDS.has(provider)
  const hasNativeCapabilities = NATIVE_CAPABILITY_PROVIDER_IDS.has(provider)

  return (
    <>
      {!workerOnly && (
      <SectionCard
        title="Context & Tool Access"
        description="Control how many tools are described in this agent's system prompt. Scoped (default) keeps the agent focused and saves ~3 k input tokens per turn; Universal gives it visibility into every built-in tool."
        className="mb-6 border-line-subtle bg-layer-1"
      >
      <div className="space-y-3">
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => patch((d) => ({ toolAccessMode: d.toolAccessMode === 'universal' ? 'scoped' : 'universal' }))}
            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${toolAccessMode === 'universal' ? 'bg-accent-bright' : 'bg-layer-3'}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${toolAccessMode === 'universal' ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Universal tool access</span>
          <HintTip text="Off (default, recommended): the agent only sees tools enabled in its Tools list. On: every built-in tool is described in the system prompt. Turn on only for coordinator agents that need visibility across every possible downstream tool, or temporarily for debugging." />
        </label>
        <p className="text-[12px] text-text-3 pl-[56px] -mt-1">
          {toolAccessMode === 'universal'
            ? 'Full tool universe is injected into the prompt. Costs ~3 k more input tokens per turn.'
            : 'Only the tools enabled above are visible to the agent — this is the focused default.'}
        </p>
      </div>
      </SectionCard>
      )}

      {showToolsAndSkills && (
      <SectionCard
        title="Tools & Skills"
        description="Enable tool families, pin preferred skills, and connect MCP tools for this agent."
        className="mb-6 border-line-subtle bg-layer-1"
      >
      {/* Tools — hidden for providers that manage capabilities outside LangGraph */}
      {!hasNativeCapabilities && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Tools</label>
          <p className="text-[12px] text-text-3 mb-3">Enable built-in tool families for this agent.</p>
          <div className="space-y-3">
            {AVAILABLE_TOOLS
              .map((t) => {
                const extensionDisabled = !!t.extensionId && !!enabledExtensionIds && !enabledExtensionIds.has(t.extensionId)
                return (
                  <label key={t.id} className={`flex items-center gap-3 ${extensionDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`} title={extensionDisabled ? 'Enable in Extensions page' : undefined}>
                    <div
                      onClick={() => !extensionDisabled && patch((d) => ({ tools: d.tools.includes(t.id) ? d.tools.filter((x) => x !== t.id) : [...d.tools, t.id] }))}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative shrink-0
                        ${extensionDisabled ? 'bg-layer-2 cursor-not-allowed' : tools.includes(t.id) ? 'bg-accent-bright cursor-pointer' : 'bg-layer-3 cursor-pointer'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                        ${tools.includes(t.id) && !extensionDisabled ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className={`font-display text-[14px] font-600 ${extensionDisabled ? 'text-text-3/40' : 'text-text-2'}`}>{t.label}</span>
                    <span className={`text-[12px] ${extensionDisabled ? 'text-text-3/30' : 'text-text-3'}`}>
                      {extensionDisabled ? 'Enable in Extensions page' : t.description}
                    </span>
                  </label>
                )
              })}
          </div>
        </div>
      )}

      {/* Filesystem Access */}
      <div className="mb-8">
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

      {/* Platform — hidden for providers that manage capabilities outside LangGraph */}
      {!hasNativeCapabilities && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Platform Tools</label>
          <p className="text-[12px] text-text-3 mb-3">Allow this agent to manage platform resources directly.</p>
          <div className="space-y-3">
            {PLATFORM_TOOLS
              .map((t) => {
                const extensionDisabled = !!t.extensionId && !!enabledExtensionIds && !enabledExtensionIds.has(t.extensionId)
                return (
                  <label key={t.id} className={`flex items-center gap-3 ${extensionDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`} title={extensionDisabled ? 'Enable in Extensions page' : undefined}>
                    <div
                      onClick={() => !extensionDisabled && patch((d) => ({ tools: d.tools.includes(t.id) ? d.tools.filter((x) => x !== t.id) : [...d.tools, t.id] }))}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative shrink-0
                        ${extensionDisabled ? 'bg-layer-2 cursor-not-allowed' : tools.includes(t.id) ? 'bg-accent-bright cursor-pointer' : 'bg-layer-3 cursor-pointer'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                        ${tools.includes(t.id) && !extensionDisabled ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className={`font-display text-[14px] font-600 ${extensionDisabled ? 'text-text-3/40' : 'text-text-2'}`}>{t.label}</span>
                    <span className={`text-[12px] ${extensionDisabled ? 'text-text-3/30' : 'text-text-3'}`}>
                      {extensionDisabled ? 'Enable in Extensions page' : t.description}
                    </span>
                  </label>
                )
              })}
          </div>
        </div>
      )}

      {!hasNativeCapabilities && externalTools.length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Extension Tools</label>
          <p className="text-[12px] text-text-3 mb-3">Attach enabled external extension tools to this agent.</p>
          <div className="space-y-3">
            {externalTools.map((t) => {
              const attached = extensions.includes(t.extensionId)
              const description = t.extensionName
                ? `${t.description || 'External extension tool'} (${t.extensionName})`
                : (t.description || 'External extension tool')
              return (
                <label key={`${t.extensionId}:${t.toolName}`} className="flex items-center gap-3 cursor-pointer">
                  <div
                    onClick={() => patch((d) => ({ extensions: d.extensions.includes(t.extensionId) ? d.extensions.filter((x) => x !== t.extensionId) : [...d.extensions, t.extensionId] }))}
                    className={`w-11 h-6 rounded-full transition-all duration-200 relative shrink-0 ${attached ? 'bg-accent-bright cursor-pointer' : 'bg-layer-3 cursor-pointer'}`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${attached ? 'left-[22px]' : 'left-0.5'}`} />
                  </div>
                  <span className="font-display text-[14px] font-600 text-text-2">{t.label}</span>
                  <span className="text-[12px] text-text-3">{description}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* Native capability provider note — not shown for OpenClaw (covered in connection status) */}
      {hasNativeCapabilities && !openclawEnabled && (
        <div className="mb-8 p-4 rounded-md bg-layer-1 border border-line-subtle">
          <p className="text-[13px] text-text-3">
            {provider === 'claude-cli'
              ? 'Claude CLI uses its own built-in capabilities — no additional local tool/platform configuration is needed.'
              : provider === 'codex-cli'
                ? 'OpenAI Codex CLI uses its own built-in tools (shell, files, etc.). Skills and MCP servers assigned below will be injected at runtime.'
                : provider === 'opencode-cli'
                  ? 'OpenCode CLI uses its own built-in tools (shell, files, etc.) — no additional local tool configuration is needed.'
                  : provider === 'gemini-cli'
                    ? 'Gemini CLI uses its own built-in tools and runtime — SwarmClaw does not inject local platform tools for it.'
                    : provider === 'copilot-cli'
                      ? 'GitHub Copilot CLI uses its own built-in tools and runtime. Skills and MCP servers assigned below will be injected at runtime.'
                      : provider === 'droid-cli'
                        ? 'Factory Droid CLI uses its own built-in tools and autonomy controls — SwarmClaw does not inject local platform tools for it.'
                        : provider === 'cursor-cli'
                        ? 'Cursor Agent CLI runs with its own native tool/runtime layer — SwarmClaw sends prompts directly without injecting local platform tools.'
                        : provider === 'qwen-code-cli'
                          ? 'Qwen Code CLI uses its own native tools and runtime — SwarmClaw does not inject local platform tools for it.'
                          : provider === 'goose'
                            ? 'Goose manages its own runtime, tools, and extensions — SwarmClaw sends prompts directly instead of injecting local platform tools.'
                            : provider === 'hermes'
                              ? 'Hermes Agent runs behind its own API server and tool runtime. SwarmClaw sends prompts to Hermes directly instead of injecting local platform tools.'
                              : 'This provider manages its own native capabilities and runtime.'}
          </p>
        </div>
      )}

      {/* Skills — discovered from ~/.claude/skills/ */}
      {provider === 'claude-cli' && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em]">
              Pinned Claude Skills <span className="normal-case tracking-normal font-normal text-text-3">(from ~/.claude/skills/)</span>
            </label>
            <button
              onClick={loadClaudeSkills}
              disabled={claudeSkillsLoading}
              className="text-[11px] text-text-3 hover:text-accent-bright transition-colors cursor-pointer bg-transparent border-none flex items-center gap-1"
              style={{ fontFamily: 'inherit' }}
              title="Refresh skills from ~/.claude/skills/"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={claudeSkillsLoading ? 'animate-spin' : ''}>
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              Refresh
            </button>
          </div>
          <p className="text-[12px] text-text-3 mb-3">Optional preference list. Pinned Claude skills are called out explicitly when this agent is delegated work.</p>
          {claudeSkills.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {claudeSkills.map((s) => {
                const active = skills.includes(s.id)
                return (
                  <button
                    key={s.id}
                    onClick={() => patch((d) => ({ skills: active ? d.skills.filter((x) => x !== s.id) : [...d.skills, s.id] }))}
                    className={`px-3 py-2 rounded-sm text-[13px] font-600 cursor-pointer transition-all border
                      ${active
                        ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                        : 'bg-surface border-line-subtle text-text-3 hover:text-text-2'}`}
                    style={{ fontFamily: 'inherit' }}
                    title={s.description}
                  >
                    {s.name}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-[12px] text-text-3">No skills found in ~/.claude/skills/</p>
          )}
        </div>
      )}

      {/* Dynamic Skills from Skills Manager */}
      {Object.keys(dynamicSkills).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
            Pinned Skills <span className="normal-case tracking-normal font-normal text-text-3">(from Skills manager)</span>
          </label>
          <p className="text-[12px] text-text-3 mb-3">All ready local skills are discoverable by default. Pin skills here only when they should stay in this agent&apos;s prompt as always-on guidance.</p>
          <div className="flex flex-wrap gap-2">
            {Object.values(dynamicSkills).map((s) => {
              const active = skillIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => patch((d) => ({ skillIds: active ? d.skillIds.filter((x) => x !== s.id) : [...d.skillIds, s.id] }))}
                  className={`px-3 py-2 rounded-sm text-[13px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-line-subtle text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                  title={s.description || s.filename}
                >
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* MCP Servers */}
      {Object.keys(mcpServers).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
            MCP Servers
          </label>
          <p className="text-[12px] text-text-3 mb-3">Connect external tool servers to this agent via MCP.</p>
          <div className="flex flex-wrap gap-2">
            {Object.values(mcpServers).map((s) => {
              const active = mcpServerIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => patch((d) => ({ mcpServerIds: active ? d.mcpServerIds.filter((x) => x !== s.id) : [...d.mcpServerIds, s.id] }))}
                  className={`px-3 py-2 rounded-sm text-[13px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-line-subtle text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                  title={`${s.transport} — ${s.command || s.url || ''}`}
                >
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* MCP Tools — per-tool enable/disable toggles */}
      {mcpServerIds.length > 0 && Object.keys(mcpTools).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
            MCP Tools
          </label>
          <p className="text-[12px] text-text-3 mb-3">
            Toggle individual tools from connected MCP servers.{mcpToolsLoading ? ' Loading…' : ''}
          </p>
          <div className="space-y-4">
            {mcpServerIds.map((serverId) => {
              const server = mcpServers[serverId]
              const serverTools = mcpTools[serverId]
              if (!server || !serverTools?.length) return null
              const safeName = server.name.replace(/[^a-zA-Z0-9_]/g, '_')
              return (
                <div key={serverId}>
                  <p className="text-[12px] font-600 text-text-3 mb-2">{server.name}</p>
                  <div className="space-y-3">
                    {serverTools.map((t) => {
                      const fullName = `mcp_${safeName}_${t.name}`
                      const enabled = !mcpDisabledTools.includes(fullName)
                      return (
                        <label key={fullName} className="flex items-center gap-3 cursor-pointer">
                          <div
                            onClick={() => patch((d) => ({
                              mcpDisabledTools: enabled ? [...d.mcpDisabledTools, fullName] : d.mcpDisabledTools.filter((x) => x !== fullName),
                            }))}
                            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                              ${enabled ? 'bg-accent-bright' : 'bg-layer-3'}`}
                          >
                            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                              ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                          </div>
                          <span className="font-display text-[14px] font-600 text-text-2">{t.name}</span>
                          <span className="text-[12px] text-text-3 truncate">{t.description}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="mb-2">
        <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Capabilities</label>
        <p className="text-[12px] text-text-3 mb-3">Optional tags that describe what this agent is especially good at.</p>
        {capabilities.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {capabilities.map((capability) => (
              <span key={capability} className="inline-flex items-center gap-1.5 rounded-sm border border-accent-bright/20 bg-accent-soft/20 px-3 py-1 text-[12px] text-accent-bright">
                {capability}
                <button
                  type="button"
                  onClick={() => patch((d) => ({ capabilities: d.capabilities.filter((entry) => entry !== capability) }))}
                  className="bg-transparent border-none text-accent-bright/70 hover:text-accent-bright cursor-pointer"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              const next = capInput.trim()
              if (!next || capabilities.includes(next)) return
              patch((d) => ({ capabilities: [...d.capabilities, next] }))
              setCapInput('')
            }}
            placeholder="Add a capability tag"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
          <button
            type="button"
            onClick={() => {
              const next = capInput.trim()
              if (!next || capabilities.includes(next)) return
              patch((d) => ({ capabilities: [...d.capabilities, next] }))
              setCapInput('')
            }}
            className="shrink-0 px-3 py-2.5 rounded-sm bg-accent-soft/50 text-accent-bright text-[12px] font-700 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
          >
            Add
          </button>
        </div>
      </div>
      </SectionCard>
      )}

      {workerOnly && !showToolsAndSkills && (
        <TabEmptyNote>
          This provider brings its own tools and does not take skills or MCP servers from SwarmClaw,
          so there is nothing to enable here.
        </TabEmptyNote>
      )}
    </>
  )
}
