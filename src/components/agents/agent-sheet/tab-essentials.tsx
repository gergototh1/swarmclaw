'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/app/api-client'
import { errorMessage } from '@/lib/shared-utils'
import { randomSoul } from '@/lib/soul-suggestions'
import { copyTextToClipboard } from '@/lib/clipboard'
import { resolveAgentSelectableProviderCredentials, type AgentSelectableProvider } from '@/lib/agent-provider-options'
import type { Credential, Credentials, GatewayProfile, ProviderConfig, ProviderDiagnosticStep } from '@/types'
import { AdvancedSettingsSection } from '@/components/shared/advanced-settings-section'
import { HintTip } from '@/components/shared/hint-tip'
import { ModelCombobox } from '@/components/shared/model-combobox'
import { SectionLabel } from '@/components/shared/section-label'
import { StatusDot } from '@/components/ui/status-dot'
import { ProviderDiagnosticsList } from '@/components/providers/provider-diagnostics-list'
import { AgentAvatar } from '../agent-avatar'
import { SectionCard } from './section-card'
import type { AgentTabProps } from './agent-draft'

type TestStatus = 'idle' | 'testing' | 'pass' | 'fail'

interface Props extends AgentTabProps {
  inputClass: string
  agentSelectableProviders: AgentSelectableProvider[]
  currentProvider: AgentSelectableProvider | undefined
  providerCredentials: Credential[]
  credentials: Credentials
  providerConfigs: ProviderConfig[]
  openclawCredentials: Credential[]
  openclawGatewayProfiles: GatewayProfile[]
  applyGatewayProfileSelection: (nextGatewayProfileId: string | null) => void
  applyDirectProviderSelection: (nextProviderId: string) => void
  loadCredentials: () => Promise<void>
  syncLiveProviderModels: (
    providerId: string,
    nextCredentialId: string | null,
    nextEndpoint: string | null,
    nextOllamaMode: 'local' | 'cloud',
    force?: boolean,
  ) => Promise<{ synced: boolean; models: string[] } | null>
  addingKey: boolean
  setAddingKey: (value: boolean) => void
  newKeyName: string
  setNewKeyName: (value: string) => void
  newKeyValue: string
  setNewKeyValue: (value: string) => void
  savingKey: boolean
  setSavingKey: (value: boolean) => void
  uploading: boolean
  setUploading: (value: boolean) => void
  testStatus: TestStatus
  setTestStatus: (value: TestStatus) => void
  setTestMessage: (value: string) => void
  testMessage: string
  testErrorCode: string | null
  setTestErrorCode: (value: string | null) => void
  testDiagnostics: ProviderDiagnosticStep[]
  setTestDiagnostics: (value: ProviderDiagnosticStep[]) => void
  testDeviceId: string | null
  openclawDeviceId: string | null
  configCopied: boolean
  setConfigCopied: (value: boolean) => void
  soulInitial: string
  soulSaveState: 'idle' | 'saved'
  providerNeedsKey: boolean
  onOpenSoulLibrary: () => void
}

const handleFileUpload = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = (ev) => setter(ev.target?.result as string)
  reader.readAsText(file)
  e.target.value = ''
}

/**
 * Basics, Model & Connection, Instructions - moved verbatim, with one change:
 * Model & Connection's Ollama Mode, API Key, Fallback Keys and Endpoint fields
 * are now re-parented into a collapsed AdvancedSettingsSection disclosure.
 */
export function TabEssentials({
  draft,
  patch,
  inputClass,
  agentSelectableProviders,
  currentProvider,
  providerCredentials,
  credentials,
  providerConfigs,
  openclawCredentials,
  openclawGatewayProfiles,
  applyGatewayProfileSelection,
  applyDirectProviderSelection,
  loadCredentials,
  syncLiveProviderModels,
  addingKey,
  setAddingKey,
  newKeyName,
  setNewKeyName,
  newKeyValue,
  setNewKeyValue,
  savingKey,
  setSavingKey,
  uploading,
  setUploading,
  testStatus,
  setTestStatus,
  testMessage,
  setTestMessage,
  testErrorCode,
  setTestErrorCode,
  testDiagnostics,
  setTestDiagnostics,
  testDeviceId,
  openclawDeviceId,
  configCopied,
  setConfigCopied,
  soulInitial,
  soulSaveState,
  providerNeedsKey,
  onOpenSoulLibrary,
}: Props) {
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
    fallbackCredentialIds,
    ollamaMode,
    openclawEnabled,
    avatarSeed,
    avatarUrl,
    replyNotificationsMuted,
  } = draft
  const soulFileRef = useRef<HTMLInputElement>(null)
  const promptFileRef = useRef<HTMLInputElement>(null)
  const [connectionAdvancedOpen, setConnectionAdvancedOpen] = useState(false)
  // The API key field lives inside the collapsed panel, and a provider that
  // still needs one cannot be saved at all — so open on that case rather than
  // hiding the single thing standing between the reader and a working agent.
  useEffect(() => {
    if (providerNeedsKey) setConnectionAdvancedOpen(true)
  }, [providerNeedsKey])

  return (
    <>
      <SectionCard
        title="Basics"
        description="Start with the core identity and description users will see first."
      >
      <div className="mb-8">
        <SectionLabel>Name</SectionLabel>
        <input type="text" value={name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. SEO Researcher" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <SectionLabel>Avatar</SectionLabel>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="relative group shrink-0">
              <AgentAvatar seed={avatarUrl ? null : (avatarSeed || null)} avatarUrl={avatarUrl} name={name || 'A'} size={64} />
              <label className="absolute inset-0 rounded-full flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setUploading(true)
                    try {
                      const res = await fetch('/api/upload', {
                        method: 'POST',
                        headers: { 'x-filename': file.name },
                        body: await file.arrayBuffer(),
                      })
                      const data = await res.json()
                      if (data.url) {
                        patch({ avatarUrl: data.url })
                        patch({ avatarSeed: '' })
                        toast.success('Avatar image uploaded')
                      }
                    } catch {
                      toast.error('Failed to upload image')
                    } finally {
                      setUploading(false)
                      e.target.value = ''
                    }
                  }}
                />
              </label>
            </div>
            <div className="flex flex-col gap-1.5 flex-1 min-w-0">
              {avatarUrl && (
                <button
                  type="button"
                  onClick={() => {
                    patch({ avatarUrl: null })
                    if (!avatarSeed) patch({ avatarSeed: Math.random().toString(36).slice(2, 10) })
                  }}
                  className="text-[11px] text-text-3 hover:text-red-400 transition-colors self-start cursor-pointer"
                >
                  Remove custom image
                </button>
              )}
              {uploading && <span className="text-[11px] text-text-3">Uploading...</span>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={avatarSeed}
              onChange={(e) => { patch({ avatarSeed: e.target.value }); patch({ avatarUrl: null }) }}
              placeholder="Avatar seed (any text)"
              className={inputClass}
              style={{ fontFamily: 'inherit', flex: 1 }}
            />
            <button
              type="button"
              onClick={() => { patch({ avatarSeed: Math.random().toString(36).slice(2, 10) }); patch({ avatarUrl: null }) }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-line-default bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:bg-layer-2 hover:text-text-2 active:scale-95 shrink-0"
              style={{ fontFamily: 'inherit' }}
              title="Shuffle avatar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <circle cx="9" cy="9" r="1" fill="currentColor" />
                <circle cx="15" cy="15" r="1" fill="currentColor" />
              </svg>
              Shuffle
            </button>
          </div>
        </div>
      </div>

      <div className="mb-8">
        <SectionLabel>Description</SectionLabel>
        <input type="text" value={description} onChange={(e) => patch({ description: e.target.value })} placeholder="What does this agent do?" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>
      </SectionCard>

      <SectionCard
        title="Model & Connection"
        description="Choose how this agent connects to a model, then verify the setup before saving."
      >
      <div className="mb-8">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line-subtle bg-surface px-4 py-3">
          <div>
            <p className="text-[12px] font-700 tracking-[0.03em] text-text-3">Runtime</p>
            <p className="mt-1 text-[14px] font-600 text-text">{openclawEnabled ? 'OpenClaw gateway' : 'Direct provider connection'}</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-[11px] font-600 tracking-[0.03em] text-text-3">OpenClaw</label>
            <button
              type="button"
              onClick={() => {
                setTestStatus('idle')
                setTestMessage('')
                setTestErrorCode(null)
                setTestDiagnostics([])
                if (!openclawEnabled) {
                  patch({ openclawEnabled: true })
                  patch({ provider: 'openclaw' })
                  patch({ model: 'default' })
                  if (!apiEndpoint) patch({ apiEndpoint: 'http://localhost:18789' })
                } else {
                  patch({ openclawEnabled: false })
                  const first = agentSelectableProviders[0]?.id || 'claude-cli'
                  patch({ provider: first })
                  patch({ model: '' })
                  patch({ apiEndpoint: null })
                  patch({ credentialId: null })
                  patch({ gatewayProfileId: null })
                }
              }}
              className={`relative h-6 w-11 rounded-full border-none transition-colors duration-200 ${openclawEnabled ? 'bg-accent-bright' : 'bg-layer-3'}`}
            >
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${openclawEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
        </div>
      </div>
      {/* OpenClaw Gateway Fields */}
      {openclawEnabled && (
        <div className="mb-8 space-y-5">
          {openclawGatewayProfiles.length > 0 && (
            <div>
              <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Gateway Profile</label>
              <select
                value={gatewayProfileId || ''}
                onChange={(e) => applyGatewayProfileSelection(e.target.value || null)}
                className={inputClass}
              >
                <option value="">Custom endpoint</option>
                {openclawGatewayProfiles.map((gateway) => (
                  <option key={gateway.id} value={gateway.id}>
                    {gateway.name}{gateway.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* Connection fields */}
          <div className="space-y-4">
            <div>
              <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Gateway URL</label>
              <input
                type="text"
                value={apiEndpoint || ''}
                onChange={(e) => patch({ apiEndpoint: e.target.value || null })}
                placeholder="http://localhost:18789"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">Gateway Token</label>
              {openclawCredentials.length > 0 && !addingKey ? (
                <div className="flex gap-2">
                  <select value={credentialId || ''} onChange={(e) => {
                    if (e.target.value === '__add__') {
                      setAddingKey(true)
                      setNewKeyName('')
                      setNewKeyValue('')
                    } else {
                      patch({ credentialId: e.target.value || null })
                    }
                  }} className={`${inputClass} appearance-none cursor-pointer flex-1`} style={{ fontFamily: 'inherit' }}>
                    <option value="">No token (auth disabled)</option>
                    {openclawCredentials.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                    <option value="__add__">+ Add new token...</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => { setAddingKey(true); setNewKeyName(''); setNewKeyValue('') }}
                    className="shrink-0 px-3 py-2.5 rounded-md bg-accent-soft/50 text-accent-bright text-[12px] font-600 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
                  >
                    + New
                  </button>
                </div>
              ) : (
                <div className="space-y-3 p-4 rounded-lg border border-accent-bright/15 bg-accent-soft/10">
                  <input
                    type="text"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Label (e.g. Local gateway)"
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  />
                  <input
                    type="password"
                    value={newKeyValue}
                    onChange={(e) => setNewKeyValue(e.target.value)}
                    placeholder="Paste gateway token..."
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  />
                  <div className="flex gap-2 justify-end">
                    {openclawCredentials.length > 0 && (
                      <button type="button" onClick={() => setAddingKey(false)} className="px-3 py-1.5 text-[12px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none" style={{ fontFamily: 'inherit' }}>Cancel</button>
                    )}
                    <button
                      type="button"
                      disabled={savingKey || !newKeyValue.trim()}
                      onClick={async () => {
                        setSavingKey(true)
                        try {
                          const cred = await api<{ id: string }>('POST', '/credentials', { provider: 'openclaw', name: newKeyName.trim() || 'OpenClaw token', apiKey: newKeyValue.trim() })
                          await loadCredentials()
                          patch({ credentialId: cred.id })
                          setAddingKey(false)
                          setNewKeyName('')
                          setNewKeyValue('')
                        } catch (err: unknown) { toast.error(`Failed to save: ${errorMessage(err)}`) }
                        finally { setSavingKey(false) }
                      }}
                      className="px-4 py-1.5 rounded-sm bg-accent-bright text-accent-fg text-[12px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-40"
                      style={{ fontFamily: 'inherit' }}
                    >
                      {savingKey ? 'Saving...' : 'Save Token'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Insecure connection warning */}
          {(() => {
            const url = (apiEndpoint || '').trim().toLowerCase()
            const isRemote = url && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(url)
            const isSecure = /^(https|wss):\/\//i.test(url)
            if (isRemote && !isSecure) return (
              <div className="px-3 py-2.5 rounded-md bg-warning/[0.06] border border-warning/20">
                <p className="text-[13px] text-warning leading-[1.5]">
                  Unencrypted connection. Use HTTPS or an SSH tunnel for production.
                </p>
              </div>
            )
            return null
          })()}

          {/* Status feedback — single unified block */}
          {testStatus === 'pass' && (
            <div className="p-4 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15 space-y-2">
              <div className="flex items-center gap-2">
                <StatusDot status="online" />
                <p className="text-[14px] text-emerald-400 font-600">Connected</p>
              </div>
              <p className="text-[13px] text-text-2 leading-[1.6]">Gateway is reachable and this device is paired. Tools and models are managed by the OpenClaw instance.</p>
              <ProviderDiagnosticsList diagnostics={testDiagnostics} />
            </div>
          )}
          {testStatus === 'fail' && (
            <div className="p-4 rounded-md border space-y-3"
              style={{
                background: testErrorCode === 'PAIRING_REQUIRED' ? 'rgba(34,197,94,0.04)' : 'rgba(var(--accent-bright-rgb,120,100,255),0.06)',
                borderColor: testErrorCode === 'PAIRING_REQUIRED' ? 'rgba(34,197,94,0.2)' : 'rgba(var(--accent-bright-rgb,120,100,255),0.15)',
              }}
            >
              {testErrorCode === 'PAIRING_REQUIRED' ? (<>
                <div className="flex items-center gap-2">
                  <StatusDot status="online" pulse />
                  <p className="text-[14px] text-success font-600">Awaiting Approval</p>
                </div>
                <p className="text-[13px] text-text-2 leading-[1.6]">
                  This device is pending approval on your gateway. Go to <span className="text-text-2 font-600">Nodes</span>, approve the device{(testDeviceId || openclawDeviceId) ? <> (<code className="text-[12px] font-mono text-text-2">{(testDeviceId || openclawDeviceId)!.slice(0, 12)}...</code>)</> : null}, then click <span className="text-text-2 font-600">Retry Connection</span>.
                </p>
                <a
                  href={(() => { const ep = (apiEndpoint || 'http://localhost:18789').replace(/\/+$/, ''); return /^https?:\/\//i.test(ep) ? ep : `http://${ep}` })()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-2 px-4 py-2 rounded-sm bg-layer-2 border border-line-default text-[13px] text-text-2 font-600 hover:bg-layer-3 transition-colors"
                >
                  Approve in Dashboard →
                </a>
              </>) : testErrorCode === 'DEVICE_AUTH_INVALID' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Device Not Paired</p>
                <p className="text-[13px] text-text-2 leading-[1.6]">
                  The gateway doesn&apos;t recognize this device. Go to <span className="text-text-2 font-600">Nodes</span>, and add or approve this device{(testDeviceId || openclawDeviceId) ? <> (<code className="text-[12px] font-mono text-text-2">{(testDeviceId || openclawDeviceId)!.slice(0, 12)}...</code>)</> : null}.
                </p>
                <a
                  href={(() => { const ep = (apiEndpoint || 'http://localhost:18789').replace(/\/+$/, ''); return /^https?:\/\//i.test(ep) ? ep : `http://${ep}` })()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-2 px-4 py-2 rounded-sm bg-layer-2 border border-line-default text-[13px] text-text-2 font-600 hover:bg-layer-3 transition-colors"
                >
                  Approve in Dashboard →
                </a>
              </>) : testErrorCode === 'AUTH_TOKEN_MISSING' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Token Required</p>
                <p className="text-[13px] text-text-2 leading-[1.6]">
                  This gateway requires an auth token. Add one above and try again.
                </p>
              </>) : testErrorCode === 'AUTH_TOKEN_INVALID' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Invalid Token</p>
                <p className="text-[13px] text-text-2 leading-[1.6]">
                  The gateway rejected this token. Check that it matches the one configured on your OpenClaw instance.
                </p>
              </>) : (<>
                <p className="text-[14px] text-accent-bright font-600">Connection Failed</p>
                <p className="text-[13px] text-text-2 leading-[1.6]">
                  {testMessage || 'Could not reach the gateway. Check the URL, token, and that the gateway is running.'}
                </p>
              </>)}
              {/* Device ID footer — always shown on failure for debugging */}
              {(testDeviceId || openclawDeviceId) && testErrorCode !== 'AUTH_TOKEN_MISSING' && testErrorCode !== 'AUTH_TOKEN_INVALID' && (
                <div className="pt-2 border-t border-line-subtle">
                  <p className="text-[12px] text-text-3 flex items-center gap-1.5">
                    Device <code className="font-mono text-text-2 select-all">{(testDeviceId || openclawDeviceId)}</code>
                    <button
                      type="button"
                      onClick={() => {
                        void copyTextToClipboard((testDeviceId || openclawDeviceId)!).then((copiedId) => {
                          if (!copiedId) return
                          setConfigCopied(true)
                          setTimeout(() => setConfigCopied(false), 2000)
                        })
                      }}
                      className="text-[12px] text-text-3/60 hover:text-text-3/80 transition-colors cursor-pointer bg-transparent border-none"
                    >
                      {configCopied ? 'copied' : 'copy'}
                    </button>
                  </p>
                </div>
              )}
              <ProviderDiagnosticsList diagnostics={testDiagnostics} />
            </div>
          )}
        </div>
      )}

      {!openclawEnabled && <div className="mb-8">
        <SectionLabel>Provider</SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          {agentSelectableProviders.map((p) => {
            const nextCredentials = resolveAgentSelectableProviderCredentials(p.id, credentials, providerConfigs)
            const isConnected = !p.requiresApiKey || nextCredentials.length > 0
            return (
              <button
                key={p.id}
                onClick={() => applyDirectProviderSelection(p.id)}
                className={`relative py-3.5 px-4 rounded-lg text-center cursor-pointer transition-all duration-200
                  active:scale-[0.97] text-[14px] font-600 border
                  ${provider === p.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-surface border-line-subtle text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {isConnected && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400" />
                )}
                {p.name}
              </button>
            )
          })}
        </div>
      </div>}

      {!openclawEnabled && currentProvider && currentProvider.models.length > 0 && (
        <div className="mb-8">
          <SectionLabel>Model</SectionLabel>
          <ModelCombobox
            providerId={currentProvider.id}
            value={model}
            onChange={(value) => patch({ model: value })}
            models={currentProvider.models}
            defaultModels={currentProvider.defaultModels}
            credentialId={credentialId}
            apiEndpoint={apiEndpoint}
            ollamaMode={provider === 'ollama' ? ollamaMode : null}
            supportsDiscovery={currentProvider.supportsModelDiscovery}
            className={`${inputClass} cursor-pointer`}
          />
        </div>
      )}

      {/* OpenClaw manages its own models — no selector needed */}

      <AdvancedSettingsSection
        open={connectionAdvancedOpen}
        onToggle={() => setConnectionAdvancedOpen((current) => !current)}
        summary="Endpoint & authentication"
      >
      {/* Ollama Mode Toggle */}
      {!openclawEnabled && provider === 'ollama' && (
        <div className="mb-8">
          <SectionLabel>Mode</SectionLabel>
          <div className="flex p-1 rounded-md bg-surface border border-line-subtle">
            {(['local', 'cloud'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  patch({ ollamaMode: mode })
                  if (mode === 'local') {
                    patch({ apiEndpoint: 'http://localhost:11434' })
                    patch({ credentialId: null })
                  } else {
                    patch({ apiEndpoint: null })
                    if (providerCredentials.length > 0) patch({ credentialId: providerCredentials[0].id })
                  }
                }}
                className={`flex-1 py-3 rounded-md text-center cursor-pointer transition-all duration-200
                  text-[14px] font-600 capitalize
                  ${ollamaMode === mode
                    ? 'bg-accent-soft text-accent-bright'
                    : 'bg-transparent text-text-3 hover:text-text-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      )}

      {!openclawEnabled && (currentProvider?.requiresApiKey || currentProvider?.optionalApiKey || (provider === 'ollama' && ollamaMode === 'cloud')) && (
        <div className="mb-8">
          <SectionLabel>API Key{currentProvider?.optionalApiKey && !currentProvider?.requiresApiKey && <span className="normal-case tracking-normal font-normal text-text-3"> (optional)</span>}</SectionLabel>
          {providerCredentials.length > 0 && !addingKey ? (
            <div className="flex gap-2">
              <select value={credentialId || ''} onChange={(e) => {
                if (e.target.value === '__add__') {
                  setAddingKey(true)
                  setNewKeyName('')
                  setNewKeyValue('')
                } else {
                  patch({ credentialId: e.target.value || null })
                }
              }} className={`${inputClass} appearance-none cursor-pointer flex-1`} style={{ fontFamily: 'inherit' }}>
                <option value="">Select a key...</option>
                {providerCredentials.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value="__add__">+ Add new key...</option>
              </select>
              <button
                type="button"
                onClick={() => { setAddingKey(true); setNewKeyName(''); setNewKeyValue('') }}
                className="shrink-0 px-3 py-2.5 rounded-md bg-accent-soft/50 text-accent-bright text-[12px] font-600 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
              >
                + New
              </button>
            </div>
          ) : (
            <div className="space-y-3 p-4 rounded-lg border border-accent-bright/15 bg-accent-soft/20">
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (optional)"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <input
                type="password"
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                placeholder="Paste API key..."
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <div className="flex gap-2 justify-end">
                {providerCredentials.length > 0 && (
                  <button type="button" onClick={() => setAddingKey(false)} className="px-3 py-1.5 text-[12px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none" style={{ fontFamily: 'inherit' }}>Cancel</button>
                )}
                <button
                  type="button"
                  disabled={savingKey || !newKeyValue.trim()}
                      onClick={async () => {
                        setSavingKey(true)
                        try {
                          const cred = await api<{ id: string }>('POST', '/credentials', { provider, name: newKeyName.trim() || `${provider} key`, apiKey: newKeyValue.trim() })
                          await loadCredentials()
                          patch({ credentialId: cred.id })
                          const synced = await syncLiveProviderModels(provider, cred.id, apiEndpoint, ollamaMode, true).catch(() => null)
                          setAddingKey(false)
                          setNewKeyName('')
                          setNewKeyValue('')
                          if (synced?.models.length) {
                            toast.success(`Key saved. Synced ${synced.models.length} model${synced.models.length === 1 ? '' : 's'}.`)
                          } else {
                            toast.success('Key saved')
                          }
                        } catch (err: unknown) { toast.error(`Failed to save: ${errorMessage(err)}`) }
                        finally { setSavingKey(false) }
                      }}
                  className="px-4 py-1.5 rounded-sm bg-accent-bright text-accent-fg text-[12px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-40"
                  style={{ fontFamily: 'inherit' }}
                >
                  {savingKey ? 'Saving...' : 'Save Key'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Fallback Credentials */}
      {!openclawEnabled && (currentProvider?.requiresApiKey || currentProvider?.optionalApiKey || (provider === 'ollama' && ollamaMode === 'cloud')) && providerCredentials.length > 1 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
            Fallback Keys <span className="normal-case tracking-normal font-normal text-text-3">(for auto-failover)</span>
          </label>
          <p className="text-[12px] text-text-3 mb-3">If the primary key fails (rate limit, auth error), these keys will be tried in order.</p>
          <div className="flex flex-wrap gap-2">
            {providerCredentials.filter((c) => c.id !== credentialId).map((c) => {
              const active = fallbackCredentialIds.includes(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => patch((d) => ({ fallbackCredentialIds: active ? d.fallbackCredentialIds.filter((x) => x !== c.id) : [...d.fallbackCredentialIds, c.id] }))}
                  className={`px-3 py-2 rounded-sm text-[12px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-line-subtle text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {(currentProvider?.requiresEndpoint || currentProvider?.optionalEndpoint) && (provider !== 'ollama' || ollamaMode === 'local') && (
        <div className="mb-8">
          <SectionLabel>{provider === 'openclaw' ? 'OpenClaw Endpoint' : provider === 'hermes' ? 'Hermes API Endpoint' : provider === 'lmstudio' ? 'LM Studio Endpoint' : 'Endpoint'}</SectionLabel>
          <input type="text" value={apiEndpoint || ''} onChange={(e) => patch({ apiEndpoint: e.target.value || null })} placeholder={currentProvider.defaultEndpoint || 'http://localhost:11434'} className={`${inputClass} font-mono text-[14px]`} />
          {provider === 'openclaw' && (
            <p className="text-[13px] text-text-3 mt-2">The URL of your OpenClaw gateway</p>
          )}
          {provider === 'hermes' && (
            <p className="text-[13px] text-text-3 mt-2">Point this at the Hermes API server, usually <code className="text-text-2">http://127.0.0.1:8642/v1</code>.</p>
          )}
          {provider === 'lmstudio' && (
            <p className="text-[13px] text-text-3 mt-2">Point this at the LM Studio local server. A bare host is normalized to <code className="text-text-2">/v1</code>.</p>
          )}
        </div>
      )}

      <div className="mb-1">
        <label className="flex items-center gap-2 text-[12px] text-text-2">
          <input
            type="checkbox"
            checked={replyNotificationsMuted ?? false}
            onChange={(e) => patch({ replyNotificationsMuted: e.target.checked })}
            className="h-4 w-4 rounded-xs border-line-strong accent-accent"
          />
          Ne kuldjon ertesitest errol az ugynokrol
          <HintTip text="A lista olvasatlan-jelzese megmarad, csak a natv rendszer-ertesites nem megy ki errol az ugynokrol." />
        </label>
      </div>
      </AdvancedSettingsSection>

      </SectionCard>

      <SectionCard
        title="Instructions"
        description="Keep the agent's personality and core prompt visible and easy to edit."
      >
        <div className="mb-8">
          <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 tracking-[0.03em] mb-2">
            Soul / Personality <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
            <HintTip text="The agent's voice and tone — how it talks, not what it knows" />
            {soul !== soulInitial && soulSaveState === 'idle' && (
              <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[10px] text-amber-400 font-600">
                <StatusDot status="warning" size="sm" />
                Unsaved
              </span>
            )}
            {soulSaveState === 'saved' && (
              <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[10px] text-emerald-400 font-600">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                Saved
              </span>
            )}
          </label>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-[12px] text-text-3">Define the agent&apos;s voice, tone, and personality. Injected before the system prompt.</p>
            <button
              type="button"
              onClick={() => patch({ soul: randomSoul() })}
              className="inline-flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-sm border border-line-default bg-transparent text-[11px] text-text-3 hover:text-text-2 cursor-pointer transition-colors"
              style={{ fontFamily: 'inherit' }}
              title="Randomize personality"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <circle cx="9" cy="9" r="1" fill="currentColor" />
                <circle cx="15" cy="15" r="1" fill="currentColor" />
              </svg>
              Shuffle
            </button>
            <button
              type="button"
              onClick={onOpenSoulLibrary}
              className="shrink-0 px-2 py-1 rounded-sm border border-accent-bright/20 bg-accent-soft text-[11px] text-accent-bright hover:brightness-110 cursor-pointer transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              Browse Library
            </button>
            <button onClick={() => soulFileRef.current?.click()} className="shrink-0 px-2 py-1 rounded-sm border border-line-default bg-surface text-[11px] text-text-3 hover:text-text-2 cursor-pointer transition-colors" style={{ fontFamily: 'inherit' }}>Upload .md</button>
            <input ref={soulFileRef} type="file" accept=".md,.txt,.markdown" onChange={handleFileUpload((value) => patch({ soul: value }))} className="hidden" />
          </div>
          <textarea
            value={soul}
            onChange={(e) => patch({ soul: e.target.value })}
            placeholder="e.g. You speak concisely and directly. You have a dry sense of humor. You always back claims with data."
            rows={3}
            className={`${inputClass} resize-y min-h-[80px]`}
            style={{ fontFamily: 'inherit' }}
          />
        </div>

        {provider !== 'openclaw' ? (
          <div className="mb-1">
            <div className="mb-3 flex items-center gap-2">
              <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 tracking-[0.03em]">System Prompt <HintTip text="Instructions that tell the agent what it can do, what tools to use, and how to behave" /></label>
              <button onClick={() => promptFileRef.current?.click()} className="shrink-0 px-2 py-1 rounded-sm border border-line-default bg-surface text-[11px] text-text-3 hover:text-text-2 cursor-pointer transition-colors" style={{ fontFamily: 'inherit' }}>Upload .md</button>
              <input ref={promptFileRef} type="file" accept=".md,.txt,.markdown" onChange={handleFileUpload((value) => patch({ systemPrompt: value }))} className="hidden" />
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => patch({ systemPrompt: e.target.value })}
              placeholder="You are an expert..."
              rows={6}
              className={`${inputClass} resize-y min-h-[140px]`}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        ) : (
          <div className="rounded-lg border border-line-subtle bg-surface px-4 py-4 text-[13px] leading-[1.6] text-text-3">
            OpenClaw agents rely on the gateway runtime for tool execution and node routing. Expand advanced settings if you need continuity, voice, or heartbeat overrides.
          </div>
        )}
      </SectionCard>
    </>
  )
}
