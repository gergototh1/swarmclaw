'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { api } from '@/lib/app/api-client'
import { getExtensionSourceLabel } from '@/lib/extension-sources'
import { toast } from 'sonner'
import type { ExtensionMeta, ExtensionSettingsField, MarketplaceExtension } from '@/types'
import { dedup } from '@/lib/shared-utils'
import {
  summarizeLifecycleReconcile,
  type ManagedReconcileLifecycleOutcomeShape,
} from '@/lib/extensions/reconcile-summary'

/** What the install route returns alongside the install's own result. */
interface InstallResponse {
  managedResources?: ManagedReconcileLifecycleOutcomeShape | null
}

/**
 * Report the reconcile the host ran for an install, and stay silent when there
 * is nothing to report.
 *
 * An extension that declares no agents and no routines produces no message.
 * A skipped declaration or a failure produces one, because otherwise
 * "Installed" is the only thing the operator is told and it is true of the
 * extension while being wrong about its resources.
 */
function reportInstallReconcile(response: InstallResponse | null | undefined) {
  const summary = summarizeLifecycleReconcile(response?.managedResources)
  if (!summary) return
  if (summary.ok) toast.success(summary.text)
  else toast.error(summary.text, { duration: 10_000 })
}

function extensionDescription(ext: ExtensionMeta): string {
  const raw = (ext.description || '').trim()
  if (raw) return raw
  return 'No description provided. This installed extension is available and can be configured from this panel.'
}

function extensionCapabilityBadges(ext: ExtensionMeta): string[] {
  const badges: string[] = []
  if (ext.toolCount && ext.toolCount > 0) badges.push(`${ext.toolCount} tool${ext.toolCount === 1 ? '' : 's'}`)
  if (ext.hookCount && ext.hookCount > 0) badges.push(`${ext.hookCount} hook${ext.hookCount === 1 ? '' : 's'}`)
  if (ext.hasUI) badges.push('UI extension')
  if (ext.providerCount && ext.providerCount > 0) badges.push(`${ext.providerCount} provider${ext.providerCount === 1 ? '' : 's'}`)
  if (ext.connectorCount && ext.connectorCount > 0) badges.push(`${ext.connectorCount} connector${ext.connectorCount === 1 ? '' : 's'}`)
  if (ext.hasDependencyManifest) badges.push(`${ext.dependencyCount ?? 0} dep${ext.dependencyCount === 1 ? '' : 's'}`)
  return badges
}

export function ExtensionSheet() {
  const open = useAppStore((s) => s.extensionSheetOpen)
  const setOpen = useAppStore((s) => s.setExtensionSheetOpen)
  const editingFilename = useAppStore((s) => s.editingExtensionFilename)
  const setEditingFilename = useAppStore((s) => s.setEditingExtensionFilename)
  const extensions = useAppStore((s) => s.extensions)
  const loadExtensions = useAppStore((s) => s.loadExtensions)

  const [tab, setTab] = useState<'marketplace' | 'url'>('marketplace')
  const [marketplace, setMarketplace] = useState<MarketplaceExtension[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlFilename, setUrlFilename] = useState('')
  const [urlStatus, setUrlStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'downloads'>('downloads')
  const [extensionSettingsValues, setExtensionSettingsValues] = useState<Record<string, unknown>>({})
  const [configuredSecretFields, setConfiguredSecretFields] = useState<string[]>([])
  const [extensionSettingsLoading, setExtensionSettingsLoading] = useState(false)
  const [extensionSettingsSaving, setExtensionSettingsSaving] = useState(false)
  const [dependencyInstalling, setDependencyInstalling] = useState(false)

  const editing = editingFilename ? extensions[editingFilename] : null

  // Load per-extension settings when editing an extension that has settingsFields
  useEffect(() => {
    if (!editing?.settingsFields?.length) {
      setExtensionSettingsValues({})
      setConfiguredSecretFields([])
      return
    }
    setExtensionSettingsLoading(true)
    api<{ values?: Record<string, unknown>; configuredSecretFields?: string[] }>('GET', `/extensions/settings?extensionId=${encodeURIComponent(editing.filename)}`)
      .then((data) => {
        setExtensionSettingsValues(data?.values ?? {})
        setConfiguredSecretFields(Array.isArray(data?.configuredSecretFields) ? data.configuredSecretFields : [])
      })
      .catch(() => {
        setExtensionSettingsValues({})
        setConfiguredSecretFields([])
      })
      .finally(() => setExtensionSettingsLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingFilename])

  const saveExtensionSettings = useCallback(async () => {
    if (!editing) return
    setExtensionSettingsSaving(true)
    try {
      const secretFieldSet = new Set(
        (editing.settingsFields || [])
          .filter((field) => field.type === 'secret')
          .map((field) => field.key),
      )
      const payload = Object.fromEntries(
        Object.entries(extensionSettingsValues).filter(([key, value]) => {
          if (!secretFieldSet.has(key)) return true
          return value !== undefined && value !== ''
        }),
      )
      const response = await api<{ values?: Record<string, unknown>; configuredSecretFields?: string[] }>(
        'PUT',
        `/extensions/settings?extensionId=${encodeURIComponent(editing.filename)}`,
        payload,
      )
      setExtensionSettingsValues(response?.values ?? {})
      setConfiguredSecretFields(Array.isArray(response?.configuredSecretFields) ? response.configuredSecretFields : [])
      toast.success('Extension settings saved')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save extension settings')
    }
    setExtensionSettingsSaving(false)
  }, [editing, extensionSettingsValues])

  const loadMarketplace = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<MarketplaceExtension[]>('GET', '/extensions/marketplace')
      if (Array.isArray(data)) setMarketplace(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!open || !!editingFilename || tab !== 'marketplace') return
    const timer = setTimeout(() => {
      void loadMarketplace()
    }, 0)
    return () => clearTimeout(timer)
  }, [open, editingFilename, tab, loadMarketplace])

  const handleClose = () => {
    setOpen(false)
    setEditingFilename(null)
    setUrlInput('')
    setUrlFilename('')
    setUrlStatus(null)
    setConfirmDelete(false)
  }

  const toggleExtension = async (filename: string, enabled: boolean) => {
    try {
      await api('POST', '/extensions', { filename, enabled })
      toast.success(enabled ? 'Extension enabled' : 'Extension disabled')
      loadExtensions()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle extension')
    }
  }

  const deleteExtension = async (filename: string) => {
    setDeleting(true)
    try {
      await api('DELETE', `/extensions?filename=${encodeURIComponent(filename)}`)
      toast.success('Extension deleted')
      await loadExtensions()
      handleClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
    setDeleting(false)
  }

  const installDependencies = useCallback(async () => {
    if (!editing?.filename) return
    setDependencyInstalling(true)
    try {
      const response = await api<{ ok: boolean; dependencyInfo?: { restartRequiredForUpgrades?: boolean } }>(
        'POST',
        '/extensions/dependencies',
        {
          filename: editing.filename,
          packageManager: editing.packageManager,
        },
      )
      if (response?.ok) {
        await loadExtensions()
        // A package this process already evaluated keeps the copy it has, so an
        // install that upgraded one reports success while the old code is still
        // what runs. The operator has to be told here, not only in a comment
        // next to the loader.
        toast.success(response.dependencyInfo?.restartRequiredForUpgrades
          ? 'Extension dependencies installed. Restart SwarmClaw to run upgraded packages.'
          : 'Extension dependencies installed')
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to install extension dependencies')
    }
    setDependencyInstalling(false)
  }, [editing?.filename, editing?.packageManager, loadExtensions])

  const installFromMarketplace = async (p: MarketplaceExtension) => {
    setInstalling(p.id)
    const toastId = toast.loading(`Installing ${p.name}...`)
    try {
      const safeFilename = `${p.id.replace(/[^a-zA-Z0-9.-]/g, '_')}.js`
      const response = await api<InstallResponse>('POST', '/extensions/install', {
        url: p.url,
        filename: safeFilename,
        installMethod: 'marketplace',
        sourceLabel: p.source,
        installSource: p.catalogSource || p.source,
      })
      await loadExtensions()
      toast.success(`Installed ${p.name}`, { id: toastId })
      reportInstallReconcile(response)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Install failed', { id: toastId })
    }
    setInstalling(null)
  }

  const installFromUrl = async () => {
    if (!urlInput || !urlFilename) return
    setUrlStatus(null)
    setInstalling('url')
    try {
      const response = await api<InstallResponse>('POST', '/extensions/install', { url: urlInput, filename: urlFilename })
      await loadExtensions()
      setUrlStatus({ ok: true, message: 'Installed successfully' })
      toast.success('Extension installed from URL')
      reportInstallReconcile(response)
      setUrlInput('')
      setUrlFilename('')
    } catch (err: unknown) {
      setUrlStatus({ ok: false, message: err instanceof Error ? err.message : 'Install failed' })
    }
    setInstalling(null)
  }

  const installedFilenames = new Set(Object.keys(extensions))

  const tabClass = (t: string) =>
    `py-2.5 px-4 rounded-sm text-center cursor-pointer transition-all text-[12px] font-600 border
    ${tab === t
      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
      : 'bg-bg border-line-subtle text-text-3 hover:bg-surface-2'}`

  return (
    <BottomSheet open={open} onClose={handleClose}>
      {editing ? (
        <div className="space-y-5">
          <div className="py-4 px-4 rounded-md bg-surface border border-line-subtle">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[15px] font-700 text-text truncate">{editing.name}</span>
                  <span className="text-[10px] font-mono text-text-3">v{editing.version || '1.0.0'}</span>
                  {editing.openclaw && <span className="text-[9px] font-600 text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">OpenClaw</span>}
                </div>
                <p className="text-[12px] text-text-3 leading-relaxed">{extensionDescription(editing)}</p>
              </div>
              <span className={`shrink-0 text-[10px] font-600 px-2 py-1 rounded-full ${
                editing.enabled ? 'text-emerald-300 bg-emerald-500/10' : 'text-text-3/80 bg-layer-2'
              }`}>
                {editing.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
              <div className="rounded-sm bg-bg/50 border border-line-subtle px-2.5 py-2">
                <div className="text-[10px] tracking-[0.03em] text-text-3 mb-0.5">Type</div>
                <div className="text-[11px] text-text-2">
                  {editing.isBuiltin
                    ? 'Core Platform'
                    : editing.source === 'marketplace'
                      ? 'Marketplace Extension'
                      : editing.source === 'manual'
                        ? 'Manual URL Extension'
                        : 'Local Extension'}
                </div>
              </div>
              <div className="rounded-sm bg-bg/50 border border-line-subtle px-2.5 py-2">
                <div className="text-[10px] tracking-[0.03em] text-text-3 mb-0.5">Publisher</div>
                <div className="text-[11px] text-text-2">{getExtensionSourceLabel(editing.sourceLabel)}</div>
              </div>
              <div className="rounded-sm bg-bg/50 border border-line-subtle px-2.5 py-2">
                <div className="text-[10px] tracking-[0.03em] text-text-3 mb-0.5">Installed Via</div>
                <div className="text-[11px] text-text-2">{getExtensionSourceLabel(editing.installSource || editing.sourceLabel)}</div>
              </div>
            </div>

            <div className="text-[11px] text-text-3 mt-2">{editing.author || 'Unknown author'}</div>

            <div className="text-[11px] font-mono text-text-3 mt-3 break-all">{editing.filename}</div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {extensionCapabilityBadges(editing).length > 0 ? (
                extensionCapabilityBadges(editing).map((badge) => (
                  <span key={badge} className="text-[10px] font-600 px-1.5 py-0.5 rounded-full text-text-3 bg-layer-2">
                    {badge}
                  </span>
                ))
              ) : (
                <span className="text-[10px] text-text-3">No declared tools/hooks metadata</span>
              )}
              {editing.sourceLabel && (
                <span className="text-[10px] font-700 px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-300">
                  {getExtensionSourceLabel(editing.sourceLabel)}
                </span>
              )}
              {editing.installSource && editing.installSource !== editing.sourceLabel && (
                <span className="text-[10px] font-700 px-1.5 py-0.5 rounded-full bg-layer-2 text-text-3">
                  via {getExtensionSourceLabel(editing.installSource)}
                </span>
              )}
            </div>

            {editing.autoDisabled && (
              <div className="mt-3 p-2.5 rounded-sm bg-amber-500/[0.06] border border-amber-500/20 text-[11px] text-amber-300/90">
                Auto-disabled after {editing.failureCount ?? 0} failures
                {editing.lastFailureStage ? ` at ${editing.lastFailureStage}` : ''}.
                {editing.lastFailureError ? ` ${editing.lastFailureError}` : ''}
              </div>
            )}
          </div>

          {(editing.hasDependencyManifest || !editing.isBuiltin) && (
            <div className="py-4 px-4 rounded-md bg-surface border border-line-subtle">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-600 text-text">Dependencies</div>
                  <p className="text-[11px] text-text-3 mt-1">
                    {editing.hasDependencyManifest
                      ? `Managed in a per-extension workspace${editing.packageManager ? ` via ${editing.packageManager}` : ''}.`
                      : 'No package.json manifest is currently attached to this extension.'}
                  </p>
                </div>
                {editing.hasDependencyManifest && (
                  <button
                    onClick={() => { void installDependencies() }}
                    disabled={dependencyInstalling}
                    className="px-3 py-2 rounded-sm bg-accent-soft text-[11px] font-700 text-accent-bright hover:bg-accent-bright/15 transition-all cursor-pointer border-none disabled:opacity-50"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {dependencyInstalling ? 'Installing…' : 'Install / Refresh'}
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3">
                <div className="rounded-sm bg-bg/50 border border-line-subtle px-2.5 py-2">
                  <div className="text-[10px] tracking-[0.03em] text-text-3 mb-0.5">Runtime deps</div>
                  <div className="text-[11px] text-text-2">{editing.dependencyCount ?? 0}</div>
                </div>
                <div className="rounded-sm bg-bg/50 border border-line-subtle px-2.5 py-2">
                  <div className="text-[10px] tracking-[0.03em] text-text-3 mb-0.5">Status</div>
                  <div className="text-[11px] text-text-2">{editing.dependencyInstallStatus || 'none'}</div>
                </div>
              </div>

              {editing.dependencyInstallError && (
                <div className="mt-3 p-2.5 rounded-sm bg-red-500/[0.08] border border-red-500/20 text-[11px] text-red-300/90">
                  {editing.dependencyInstallError}
                </div>
              )}

              {editing.dependencyInstalledAt && (
                <p className="text-[10px] text-text-3 mt-3">
                  Last installed {new Date(editing.dependencyInstalledAt).toLocaleString()}
                </p>
              )}

              {editing.dependencyInstallStatus === 'installed' && (
                <p className="text-[10px] text-text-3 mt-1.5">
                  Reloading an extension re-runs its own files, but a package it depends on
                  is loaded once per process. Restart SwarmClaw to run an upgraded package.
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between py-3 px-4 rounded-md bg-surface border border-line-subtle">
            <div>
              <span className="text-[13px] font-600 text-text block">Enabled</span>
              <span className="text-[11px] text-text-3">Disable to keep the extension installed but inactive.</span>
            </div>
            <div
              onClick={() => toggleExtension(editing.filename, !editing.enabled)}
              className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                ${editing.enabled ? 'bg-accent-bright' : 'bg-layer-3'}`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                ${editing.enabled ? 'left-[22px]' : 'left-0.5'}`} />
            </div>
          </div>

          {editing.settingsFields && editing.settingsFields.length > 0 && (
            <div className="py-4 px-4 rounded-md bg-surface border border-line-subtle space-y-3">
              <div className="text-[13px] font-600 text-text">Settings</div>
              {extensionSettingsLoading ? (
                <p className="text-[11px] text-text-3">Loading...</p>
              ) : (
                <>
                  {editing.settingsFields.map((field: ExtensionSettingsField) => (
                    <ExtensionSettingRow
                      key={field.key}
                      field={field}
                      value={extensionSettingsValues[field.key]}
                      configured={configuredSecretFields.includes(field.key)}
                      onChange={(v) => setExtensionSettingsValues((prev) => ({ ...prev, [field.key]: v }))}
                    />
                  ))}
                  <button
                    onClick={saveExtensionSettings}
                    disabled={extensionSettingsSaving}
                    className="w-full py-2 rounded-sm text-[12px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20
                      hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-default mt-1"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {extensionSettingsSaving ? 'Saving...' : 'Save Settings'}
                  </button>
                </>
              )}
            </div>
          )}

          {editing.source !== 'local' && (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              className="w-full py-2.5 rounded-sm text-[13px] font-600 bg-red-500/10 text-red-400 border border-red-500/20
                hover:bg-red-500/20 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-default"
              style={{ fontFamily: 'inherit' }}
            >
              {deleting ? 'Deleting...' : 'Delete Extension'}
            </button>
          )}
        </div>
      ) : (
        <div>
          <div className="flex gap-2 mb-5">
            <button onClick={() => setTab('marketplace')} className={tabClass('marketplace')} style={{ fontFamily: 'inherit' }}>
              Marketplace
            </button>
            <button onClick={() => setTab('url')} className={tabClass('url')} style={{ fontFamily: 'inherit' }}>
              Install from URL
            </button>
          </div>

          {tab === 'marketplace' && (
            loading
              ? <p className="text-[12px] text-text-3">Loading marketplace...</p>
              : marketplace.length === 0
                ? <p className="text-[12px] text-text-3">No extensions available</p>
                : (() => {
                    const allTags = dedup(marketplace.flatMap((p) => (p.tags ?? []))).sort()
                    const q = search.toLowerCase()
                    const filtered = marketplace
                      .filter((p) => {
                        const sourceTerms = [getExtensionSourceLabel(p.source).toLowerCase(), getExtensionSourceLabel(p.catalogSource).toLowerCase()]
                        if (
                          q
                          && !p.name.toLowerCase().includes(q)
                          && !p.description.toLowerCase().includes(q)
                          && !(p.tags ?? []).some((t) => t.toLowerCase().includes(q))
                          && !sourceTerms.some((term) => term.includes(q))
                        ) return false
                        if (activeTag && !(p.tags ?? []).includes(activeTag)) return false
                        return true
                      })
                      .sort((a, b) => sort === 'downloads' ? (b.downloads ?? 0) - (a.downloads ?? 0) : a.name.localeCompare(b.name))

                    return (
                      <div className="space-y-3">
                        {/* Search */}
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Search extensions..."
                          className="w-full px-3 py-2.5 rounded-sm bg-bg border border-line-subtle text-[12px] text-text placeholder:text-text-3 outline-none focus:border-accent-bright/30"
                          style={{ fontFamily: 'inherit' }}
                        />

                        {/* Tags + Sort */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            onClick={() => setActiveTag(null)}
                            className={`px-2 py-1 rounded-xs text-[10px] font-600 cursor-pointer transition-all border-none ${
                              !activeTag ? 'bg-accent-soft text-accent-bright' : 'bg-layer-1 text-text-3/60 hover:text-text-3'
                            }`}
                          >
                            All
                          </button>
                          {allTags.map((t) => (
                            <button
                              key={t}
                              onClick={() => setActiveTag(activeTag === t ? null : t)}
                              className={`px-2 py-1 rounded-xs text-[10px] font-600 cursor-pointer transition-all border-none ${
                                activeTag === t ? 'bg-accent-soft text-accent-bright' : 'bg-layer-1 text-text-3/60 hover:text-text-3'
                              }`}
                            >
                              {t}
                            </button>
                          ))}
                          <div className="flex-1" />
                          <select
                            value={sort}
                            onChange={(e) => setSort(e.target.value as 'name' | 'downloads')}
                            className="px-2 py-1 rounded-xs bg-bg border border-line-subtle text-[10px] text-text-3 outline-none cursor-pointer appearance-none"
                            style={{ fontFamily: 'inherit' }}
                          >
                            <option value="downloads">Popular</option>
                            <option value="name">A-Z</option>
                          </select>
                        </div>

                        {/* Results */}
                        {filtered.length === 0 ? (
                          <p className="text-[12px] text-text-3 text-center py-4">No extensions match your search</p>
                        ) : (
                          <div className="space-y-2.5">
                            {filtered.map((p) => {
                              const isInstalled = installedFilenames.has(`${p.id}.js`)
                              return (
                                <div key={p.id} className="py-3.5 px-4 rounded-md bg-surface border border-line-subtle">
                                  <div className="flex items-start gap-3">
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-[14px] font-600 text-text">{p.name}</span>
                                        <span className="text-[10px] font-mono text-text-3">v{p.version}</span>
                                        {p.openclaw && <span className="text-[9px] font-600 text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">OpenClaw</span>}
                                      </div>
                                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                                        {p.source && (
                                          <span className="text-[10px] font-700 px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-300">
                                            {getExtensionSourceLabel(p.source)}
                                          </span>
                                        )}
                                        {p.catalogSource && p.catalogSource !== p.source && (
                                          <span className="text-[10px] font-700 px-1.5 py-0.5 rounded-full bg-layer-2 text-text-3">
                                            via {getExtensionSourceLabel(p.catalogSource)}
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-[11px] text-text-3 mt-1">{p.description}</div>
                                      <div className="flex items-center gap-2 mt-2">
                                        <span className="text-[10px] text-text-3">by {p.author}</span>
                                        <span className="text-[10px] text-text-3">&middot;</span>
                                        {(p.tags ?? []).slice(0, 3).map((t) => (
                                          <button
                                            key={t}
                                            onClick={() => setActiveTag(activeTag === t ? null : t)}
                                            className={`text-[9px] font-600 px-1.5 py-0.5 rounded-full cursor-pointer transition-all border-none ${
                                              activeTag === t ? 'text-accent-bright bg-accent-soft' : 'text-text-3/50 bg-layer-2 hover:text-text-3'
                                            }`}
                                          >
                                            {t}
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                    <button
                                      onClick={() => !isInstalled && installFromMarketplace(p)}
                                      disabled={isInstalled || installing === p.id}
                                      className={`shrink-0 py-2 px-4 rounded-sm text-[12px] font-600 transition-all cursor-pointer
                                        ${isInstalled
                                          ? 'bg-layer-2 text-text-3/70 cursor-default'
                                          : installing === p.id
                                            ? 'bg-accent-soft text-accent-bright animate-pulse'
                                            : 'bg-accent-soft text-accent-bright hover:bg-accent-soft/80 border border-accent-bright/20'}`}
                                      style={{ fontFamily: 'inherit' }}
                                    >
                                      {isInstalled ? 'Installed' : installing === p.id ? 'Installing...' : 'Install'}
                                    </button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })()
          )}

          {tab === 'url' && (
            <div className="p-5 rounded-lg bg-surface border border-line-subtle">
              <div className="mb-4">
                <label className="block font-display text-[11px] font-600 text-text-3 tracking-[0.03em] mb-2">Extension URL</label>
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://example.com/my-extension.js"
                  className="w-full py-2.5 px-3 rounded-sm text-[13px] bg-bg border border-line-subtle text-text placeholder:text-text-3 outline-none focus:border-accent-bright/30"
                  style={{ fontFamily: 'inherit' }}
                />
              </div>
              <div className="mb-4">
                <label className="block font-display text-[11px] font-600 text-text-3 tracking-[0.03em] mb-2">Save as filename</label>
                <input
                  type="text"
                  value={urlFilename}
                  onChange={(e) => setUrlFilename(e.target.value)}
                  placeholder="my-extension.js"
                  className="w-full py-2.5 px-3 rounded-sm text-[13px] bg-bg border border-line-subtle text-text placeholder:text-text-3 outline-none focus:border-accent-bright/30"
                  style={{ fontFamily: 'inherit' }}
                />
              </div>
              <button
                onClick={installFromUrl}
                disabled={!urlInput || !urlFilename || installing === 'url'}
                className="w-full py-2.5 rounded-sm text-[13px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20
                  hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-default"
                style={{ fontFamily: 'inherit' }}
              >
                {installing === 'url' ? 'Installing...' : 'Install Extension'}
              </button>
              {urlStatus && (
                <p className={`text-[11px] mt-3 ${urlStatus.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  {urlStatus.message}
                </p>
              )}
              <p className="text-[10px] text-text-3 mt-3">
                Works with `.js` / `.mjs` SwarmClaw and OpenClaw extension formats. URL must be HTTPS.
              </p>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!editing && confirmDelete}
        title="Delete Extension"
        message={editing ? `Delete "${editing.name}"? This cannot be undone.` : ''}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        danger
        onConfirm={() => {
          if (!editing) return
          setConfirmDelete(false)
          void deleteExtension(editing.filename)
        }}
        onCancel={() => { if (!deleting) setConfirmDelete(false) }}
      />
    </BottomSheet>
  )
}

function ExtensionSettingRow({
  field,
  value,
  configured,
  onChange,
}: {
  field: ExtensionSettingsField
  value: unknown
  configured: boolean
  onChange: (v: unknown) => void
}) {
  const inputCls = 'w-full py-2 px-3 rounded-sm text-[12px] bg-bg border border-line-subtle text-text placeholder:text-text-3 outline-none focus:border-accent-bright/30'

  return (
    <div>
      <label className="block text-[11px] font-600 text-text-2 mb-1">
        {field.label}
        {field.required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {field.type === 'boolean' ? (
        <div
          onClick={() => onChange(!(value ?? field.defaultValue ?? false))}
          className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
            ${(value ?? field.defaultValue ?? false) ? 'bg-accent-bright' : 'bg-layer-3'}`}
        >
          <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
            ${(value ?? field.defaultValue ?? false) ? 'left-[22px]' : 'left-0.5'}`} />
        </div>
      ) : field.type === 'select' ? (
        <select
          value={String(value ?? field.defaultValue ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} cursor-pointer appearance-none`}
          style={{ fontFamily: 'inherit' }}
        >
          <option value="">Select...</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : field.type === 'number' ? (
        <input
          type="number"
          value={String(value ?? field.defaultValue ?? '')}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          placeholder={field.placeholder}
          className={inputCls}
          style={{ fontFamily: 'inherit' }}
        />
      ) : (
        <input
          type={field.type === 'secret' ? 'password' : 'text'}
          value={String(value ?? field.defaultValue ?? '')}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={field.type === 'secret' && configured ? 'Stored securely. Enter a new value to replace it.' : field.placeholder}
          className={inputCls}
          style={{ fontFamily: 'inherit' }}
        />
      )}
      {field.type === 'secret' && configured && (
        <p className="text-[10px] text-emerald-400/90 mt-1">Stored securely. Leave blank to keep the current value.</p>
      )}
      {field.help && <p className="text-[10px] text-text-3 mt-1">{field.help}</p>}
    </div>
  )
}
