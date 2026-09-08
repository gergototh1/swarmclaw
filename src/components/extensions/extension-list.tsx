'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { api } from '@/lib/app/api-client'
import { getExtensionSourceLabel } from '@/lib/extension-sources'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/use-mounted-ref'
import type { Agent, MarketplaceExtension, ExtensionContractConsumedMeta, ExtensionMeta } from '@/types'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { dedup, errorMessage } from '@/lib/shared-utils'
import {
  summarizeLifecycleReconcile,
  summarizeManagedReconcile,
  type ManagedReconcileLifecycleOutcomeShape,
  type ManagedReconcileResultShape,
} from '@/lib/extensions/reconcile-summary'

/** What every lifecycle route now returns alongside its own result. */
interface LifecycleResponse {
  managedResources?: ManagedReconcileLifecycleOutcomeShape | null
}

type TopTab = 'extensions' | 'marketplace'

/**
 * `reconciling` holds the filename of the extension being reconciled; this
 * value stands in for "all of them".
 *
 * It cannot collide with an installed extension: `sanitizeExtensionFilename`
 * refuses anything that does not end in `.js` or `.mjs`, so no card is keyed
 * by this. It is only ever compared against a filename here, never sent to the
 * host, so a built-in registered under some other id shape cannot be reached
 * by it either.
 */
const ALL_EXTENSIONS = '*all-extensions*'

export function ExtensionList({ inSidebar }: { inSidebar?: boolean }) {
  const extensions = useAppStore((s) => s.extensions)
  const loadExtensions = useAppStore((s) => s.loadExtensions)
  const setExtensionSheetOpen = useAppStore((s) => s.setExtensionSheetOpen)
  const setEditingExtensionFilename = useAppStore((s) => s.setEditingExtensionFilename)
  const agents = useAppStore((s) => s.agents)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const navigateTo = useNavigate()

  const navigateToAgentChat = useCallback((agentId: string) => {
    void setCurrentAgent(agentId)
    navigateTo('agents')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [tab, setTab] = useState<TopTab>('extensions')
  const [marketplace, setMarketplace] = useState<MarketplaceExtension[]>([])
  const [mpLoading, setMpLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [reconciling, setReconciling] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ filename: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'downloads'>('downloads')
  const mountedRef = useMountedRef()

  useEffect(() => {
    void loadExtensions()
  }, [loadExtensions])

  const loadMarketplace = useCallback(async () => {
    if (!mountedRef.current) return
    setMpLoading(true)
    try {
      const data = await api<MarketplaceExtension[]>('GET', '/extensions/marketplace')
      if (mountedRef.current && Array.isArray(data)) setMarketplace(data)
    } catch { /* ignore */ }
    if (mountedRef.current) setMpLoading(false)
  }, [mountedRef])

  useEffect(() => {
    if (inSidebar || tab !== 'marketplace') return
    const timer = setTimeout(() => { void loadMarketplace() }, 0)
    return () => clearTimeout(timer)
  }, [tab, inSidebar, loadMarketplace])

  const extensionList = Object.values(extensions)
  const filteredExtensionList = useMemo(() => extensionList, [extensionList])

  // Search filtering for installed extensions
  const filterInstalled = useCallback((list: ExtensionMeta[]) => {
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      p.filename.toLowerCase().includes(q)
    )
  }, [search])

  const filteredExtensions = useMemo(() => filterInstalled(filteredExtensionList), [filterInstalled, filteredExtensionList])

  const handleEdit = (filename: string) => {
    setEditingExtensionFilename(filename)
    setExtensionSheetOpen(true)
  }

  /**
   * Report the reconcile the host ran for an install, an enable or an upgrade.
   *
   * Silent when there is nothing to report: an extension that declares no
   * agents and no routines produces no message at all, rather than a
   * reassuring one about work that was never attempted. A skipped declaration
   * or a failure is a toast the operator has to see, because otherwise the
   * surrounding "Extension enabled" is the only thing they are told and it is
   * true of the extension while being wrong about its resources.
   */
  const reportLifecycleReconcile = (response: LifecycleResponse | null | undefined) => {
    const summary = summarizeLifecycleReconcile(response?.managedResources)
    if (!summary) return
    if (summary.ok) toast.success(summary.text)
    else toast.error(summary.text, { duration: 10_000 })
  }

  const handleToggle = async (e: React.MouseEvent, filename: string, enabled: boolean) => {
    e.stopPropagation()
    try {
      // Enabling reconciles server-side, which can take longer than a plain
      // config flip, so this call gets the reconcile timeout rather than the
      // client default.
      const response = await api<LifecycleResponse>(
        'POST',
        '/extensions',
        { filename, enabled: !enabled },
        { timeoutMs: 30_000 },
      )
      toast.success(!enabled ? 'Extension enabled' : 'Extension disabled')
      reportLifecycleReconcile(response)
      loadExtensions()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle extension')
    }
  }

  /**
   * Create or update the agents and routines an extension declares.
   *
   * WHY THIS CONTROL STILL EXISTS NOW THAT THE HOST RECONCILES BY ITSELF. The
   * host runs a reconcile on install, on enable and on upgrade, so the first
   * install is no longer the case this covers. What it covers is every case
   * after it: a reconcile that failed or skipped a declaration and has to be
   * retried once the cause is fixed, an agent or routine the operator deleted
   * and wants back, and a declaration that changed under a running host. There
   * is no other way to ask for any of those from the interface.
   *
   * The result is reported by `summarizeManagedReconcile`, which is where the
   * numbers -- including the ones that are zero, and any declaration the host
   * refused -- become the sentence. A run that skipped everything shows as a
   * failure, because it is one.
   *
   * `filename` null means every extension, which is what the header control
   * sends. The request body then carries no `extensionId` at all rather than a
   * null one: an absent argument is the host's own way of spelling "all of
   * them", and a null would be an argument it has to refuse.
   */
  const handleReconcile = async (e: React.MouseEvent, filename: string | null) => {
    e.stopPropagation()
    setReconciling(filename ?? ALL_EXTENSIONS)
    try {
      const result = await api<ManagedReconcileResultShape>(
        'POST',
        '/extensions/managed-resources',
        { action: 'reconcile', ...(filename ? { extensionId: filename } : {}) },
        { timeoutMs: 30_000 },
      )
      const summary = summarizeManagedReconcile(result)
      if (summary.ok) toast.success(summary.text)
      else toast.error(summary.text, { duration: 10_000 })
      await loadExtensions()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setReconciling(null)
    }
  }

  const handleDeleteClick = (e: React.MouseEvent, filename: string, name: string) => {
    e.stopPropagation()
    setConfirmDelete({ filename, name })
  }

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await api('DELETE', `/extensions?filename=${encodeURIComponent(confirmDelete.filename)}`)
      toast.success('Extension deleted')
      await loadExtensions()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
      setConfirmDelete(null)
    }
  }

  const installFromMarketplace = async (p: MarketplaceExtension) => {
    setInstalling(p.id)
    const toastId = toast.loading(`Installing ${p.name}...`)
    try {
      const safeFilename = `${p.id.replace(/[^a-zA-Z0-9.-]/g, '_')}.js`
      const response = await api<LifecycleResponse>('POST', '/extensions/install', {
        url: p.url,
        filename: safeFilename,
        installMethod: 'marketplace',
        sourceLabel: p.source,
        installSource: p.catalogSource || p.source,
      })
      await loadExtensions()
      toast.success(`Installed ${p.name}`, { id: toastId })
      reportLifecycleReconcile(response)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Install failed', { id: toastId })
    }
    setInstalling(null)
  }

  const installedFilenames = new Set(Object.keys(extensions))

  // --- Sidebar mode ---
  if (inSidebar) {
    return (
      <div className="px-3 pb-4 flex-1 overflow-y-auto">
        <div className="space-y-2">
          {extensionList.map((ext) => (
            <SidebarExtensionCard key={ext.filename} ext={ext} onEdit={handleEdit} />
          ))}
        </div>
      </div>
    )
  }

  // --- Full page mode ---
  const enabledCount = extensionList.filter((p) => p.enabled).length
  const totalTools = extensionList.reduce((acc, p) => acc + (p.toolCount ?? 0), 0)
  const totalHooks = extensionList.reduce((acc, p) => acc + (p.hookCount ?? 0), 0)
  // Declared, not created: these are manifest counts, and the host does not
  // report per-extension how many of them exist. Used only to decide whether a
  // reconcile could do anything, never shown as a number.
  const declaredManagedCount = extensionList.reduce(
    (acc, p) => acc + (p.managedAgentCount ?? 0) + (p.managedScheduleCount ?? 0),
    0,
  )

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-6">
      {/* Stats bar */}
      <div className="flex items-center gap-3 mb-4">
        <Stat label="Installed" value={extensionList.length} />
        <Stat label="Enabled" value={enabledCount} accent />
        <Stat label="Tools" value={totalTools} />
        <Stat label="Hooks" value={totalHooks} />
        <div className="flex-1" />
        {/*
          Reconcile every extension at once.

          The per-card control cannot cover one case: a built-in extension that
          gained a declaration in an application upgrade. There is no install
          and no enable to hang a reconcile off, and finding which card grew a
          declaration means opening each one. This is the only control in the
          product that reaches those, and it is the "Reconcile All" the
          unreachable settings view carried before it was deleted.

          Shown only when something declares agents or routines, so it does not
          offer an action that could not do anything.

          It reaches every extension the host has loaded, and a built-in that is
          switched off is still loaded, so this creates that one's agents and
          routines too. That is the host's existing rule for a reconcile with no
          extension named -- the same one `swarmclaw extensions reconcile`
          follows -- and not something this control decides.
        */}
        {declaredManagedCount > 0 && (
          <button
            type="button"
            onClick={(e) => { void handleReconcile(e, null) }}
            disabled={reconciling !== null}
            title="Create or update the agents and routines every installed extension declares"
            className="h-8 px-3 rounded-sm bg-layer-2 hover:bg-layer-3 text-text-2 text-[10px] font-700 tracking-[0.03em] border border-line-subtle cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {reconciling === ALL_EXTENSIONS ? 'Reconciling...' : 'Reconcile all'}
          </button>
        )}
        {/* Search */}
        <div className="relative w-[260px]">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search extensions..."
            className="w-full pl-8 pr-3 py-2 rounded-sm bg-surface border border-line-subtle text-[12px] text-text placeholder:text-text-3 outline-none focus:border-accent-bright/30 transition-colors"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-line-subtle pb-px">
        <TabButton active={tab === 'extensions'} onClick={() => setTab('extensions')} count={extensionList.length}>
          Extensions
        </TabButton>
        <TabButton active={tab === 'marketplace'} onClick={() => setTab('marketplace')}>
          Marketplace
        </TabButton>
      </div>

      {/* Tab content */}
      {tab === 'extensions' && (
        <InstalledGrid
          extensions={filteredExtensions}
          allowDelete
          search={search}
          agents={agents}
          reconciling={reconciling}
          onEdit={handleEdit}
          onToggle={handleToggle}
          onDelete={handleDeleteClick}
          onReconcile={handleReconcile}
          onNavigateToAgent={navigateToAgentChat}
          emptyMessage={search ? 'No extensions match your search' : 'No extensions installed'}
          emptyAction={!search ? (
            <button
              onClick={() => setTab('marketplace')}
              className="mt-3 px-4 py-2 rounded-sm bg-transparent text-accent-bright text-[12px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              Browse Marketplace
            </button>
          ) : undefined}
        />
      )}

      {tab === 'marketplace' && (
        <MarketplaceTab
          marketplace={marketplace}
          loading={mpLoading}
          installing={installing}
          installedFilenames={installedFilenames}
          search={search}
          activeTag={activeTag}
          setActiveTag={setActiveTag}
          sort={sort}
          setSort={setSort}
          onInstall={installFromMarketplace}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Extension"
        message={confirmDelete ? `Delete "${confirmDelete.name}"? This cannot be undone.` : ''}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        danger
        onConfirm={() => { void handleDeleteConfirm() }}
        onCancel={() => { if (!deleting) setConfirmDelete(null) }}
      />
    </div>
  )
}

// --- Sub-components ---

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-[18px] font-700 tabular-nums ${accent ? 'text-accent-bright' : 'text-text'}`}>
        {value}
      </span>
      <span className="text-[11px] text-text-3 font-600">{label}</span>
    </div>
  )
}

function TabButton({ active, onClick, count, children }: {
  active: boolean; onClick: () => void; count?: number; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-2 text-[12px] font-600 cursor-pointer transition-all border-none bg-transparent
        ${active ? 'text-accent-bright' : 'text-text-3/60 hover:text-text-2'}`}
      style={{ fontFamily: 'inherit' }}
    >
      <span className="flex items-center gap-1.5">
        {children}
        {count !== undefined && (
          <span className={`text-[10px] tabular-nums px-1.5 py-px rounded-full ${
            active ? 'bg-accent-soft text-accent-bright' : 'bg-layer-2 text-text-3/50'
          }`}>
            {count}
          </span>
        )}
      </span>
      {active && <div className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-accent-bright" />}
    </button>
  )
}

function extensionDescription(ext: ExtensionMeta): string {
  const raw = (ext.description || '').trim()
  if (raw) return raw
  const sourceLabel = ext.isBuiltin ? 'built-in tool integration' : 'installed extension'
  return `No description provided. Click to view metadata and controls for this ${sourceLabel}.`
}

function extensionCapabilityBadges(ext: ExtensionMeta): string[] {
  const badges: string[] = []
  if (ext.toolCount && ext.toolCount > 0) badges.push(`${ext.toolCount} tool${ext.toolCount === 1 ? '' : 's'}`)
  if (ext.hookCount && ext.hookCount > 0) badges.push(`${ext.hookCount} hook${ext.hookCount === 1 ? '' : 's'}`)
  if (ext.hasUI) badges.push('UI')
  if (ext.providerCount && ext.providerCount > 0) badges.push(`${ext.providerCount} provider${ext.providerCount === 1 ? '' : 's'}`)
  if (ext.connectorCount && ext.connectorCount > 0) badges.push(`${ext.connectorCount} connector${ext.connectorCount === 1 ? '' : 's'}`)
  if (ext.hasDependencyManifest) badges.push(`${ext.dependencyCount ?? 0} dep${ext.dependencyCount === 1 ? '' : 's'}`)
  const provided = ext.contractsProvided?.length ?? 0
  if (provided > 0) badges.push(`${provided} contract${provided === 1 ? '' : 's'}`)
  return badges
}

/**
 * The consumptions an extension declared, which is the operator's view of a
 * data-access grant: which other extension's data this one asked for, the
 * sentence it gave for wanting it, and — when the host is not serving it — the
 * reason why not.
 *
 * Deliberately a read-only list and not a permissions panel. There is one
 * control over a grant, and it is the enable toggle already on this card: a
 * consumption exists because the extension declares it, so revoking one means
 * switching the extension off, not editing its manifest from here.
 *
 * The host mediates access, not semantics. It cannot check that a contract
 * described as read-only only reads, so this shows what was declared and does
 * not dress it up as a verified permission.
 */
function ContractConsumptions({ consumed }: { consumed: ExtensionContractConsumedMeta[] }) {
  return (
    <div className="mt-2.5 pt-2.5 border-t border-line-subtle">
      <p className="text-[10px] font-600 tracking-wide text-text-3 mb-1">Data access</p>
      <ul className="space-y-1">
        {consumed.map((entry) => (
          <li key={`${entry.extension}:${entry.contract}`} className="text-[11px] leading-relaxed">
            <span className="font-mono text-text-3">{entry.extension}.{entry.contract} v{entry.version}</span>
            <span className="text-text-3"> &mdash; {entry.reason}</span>
            {entry.unavailable && (
              <span className="text-amber-400/90"> Unavailable: {entry.unavailable}.</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- Installed extensions grid ---

function InstalledGrid({ extensions, allowDelete, search, agents, reconciling, onEdit, onToggle, onDelete, onReconcile, onNavigateToAgent, emptyMessage, emptyAction }: {
  extensions: ExtensionMeta[]
  allowDelete: boolean
  search: string
  agents: Record<string, Agent>
  reconciling: string | null
  onEdit: (filename: string) => void
  onToggle: (e: React.MouseEvent, filename: string, enabled: boolean) => void
  onDelete: (e: React.MouseEvent, filename: string, name: string) => void
  onReconcile: (e: React.MouseEvent, filename: string) => void
  onNavigateToAgent: (agentId: string) => void
  emptyMessage: string
  emptyAction?: React.ReactNode
}) {
  if (extensions.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-layer-1 mb-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-3">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-[13px] text-text-3">{emptyMessage}</p>
        {emptyAction}
      </div>
    )
  }

  // Group enabled first, then disabled
  const enabled = extensions.filter((p) => p.enabled)
  const disabled = extensions.filter((p) => !p.enabled)
  const sorted = [...enabled, ...disabled]

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {sorted.map((ext) => (
        <ExtensionCard
          key={ext.filename}
          ext={ext}
          allowDelete={allowDelete}
          agents={agents}
          reconciling={reconciling === ext.filename || reconciling === ALL_EXTENSIONS}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          onReconcile={onReconcile}
          onNavigateToAgent={onNavigateToAgent}
          highlight={search}
        />
      ))}
    </div>
  )
}

// --- Extension card ---

function ExtensionCard({ ext, allowDelete, agents, reconciling, onEdit, onToggle, onDelete, onReconcile, onNavigateToAgent, highlight }: {
  ext: ExtensionMeta
  allowDelete: boolean
  agents: Record<string, Agent>
  reconciling: boolean
  onEdit: (filename: string) => void
  onToggle: (e: React.MouseEvent, filename: string, enabled: boolean) => void
  onDelete: (e: React.MouseEvent, filename: string, name: string) => void
  onReconcile: (e: React.MouseEvent, filename: string) => void
  onNavigateToAgent: (agentId: string) => void
  highlight: string
}) {
  const badges = extensionCapabilityBadges(ext)
  const agent = ext.createdByAgentId ? agents[ext.createdByAgentId] : null
  const managedCount = (ext.managedAgentCount ?? 0) + (ext.managedScheduleCount ?? 0)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(ext.filename)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(ext.filename) } }}
      className={`group relative text-left p-4 rounded-md border transition-all cursor-pointer
        ${ext.enabled
          ? 'border-line-subtle bg-surface hover:bg-surface-2 hover:border-line-default'
          : 'border-line-subtle bg-surface/50 hover:bg-surface hover:border-line-default opacity-70 hover:opacity-100'
        }`}
    >
      {/* Top row: name + toggle */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {agent && (
            <button
              type="button"
              title={`Created by ${agent.name}`}
              onClick={(e) => { e.stopPropagation(); onNavigateToAgent(ext.createdByAgentId!) }}
              className="shrink-0 rounded-full hover:ring-2 hover:ring-accent-bright/40 transition-all cursor-pointer bg-transparent border-none p-0"
            >
              <AgentAvatar
                seed={agent.avatarSeed || null}
                avatarUrl={agent.avatarUrl}
                name={agent.name || 'Agent'}
                size={20}
              />
            </button>
          )}
          <span className="font-display text-[14px] font-600 text-text truncate">
            <HighlightText text={ext.name} highlight={highlight} />
          </span>
          {ext.version && (
            <span className="text-[10px] font-mono text-text-3 shrink-0">v{ext.version}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div
            onClick={(e) => onToggle(e, ext.filename, ext.enabled)}
            className={`w-9 h-5 rounded-full transition-all relative cursor-pointer shrink-0
              ${ext.enabled ? 'bg-accent-bright' : 'bg-layer-3'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
              ${ext.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </div>
          {allowDelete && (
            <button
              onClick={(e) => onDelete(e, ext.filename, ext.name)}
              className="text-text-3 hover:text-red-400 transition-colors p-0.5 opacity-0 group-hover:opacity-100"
              title="Delete"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-[12px] text-text-3 leading-relaxed line-clamp-2 mb-2.5">
        {extensionDescription(ext)}
      </p>

      {/* Badges */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {badges.map((badge) => (
          <span key={badge} className="text-[10px] font-600 px-1.5 py-0.5 rounded-full text-text-3 bg-layer-2">
            {badge}
          </span>
        ))}
        {ext.sourceLabel && (
          <SourceChip label={getExtensionSourceLabel(ext.sourceLabel)} tone="publisher" />
        )}
        {ext.installSource && ext.installSource !== ext.sourceLabel && (
          <SourceChip label={`via ${getExtensionSourceLabel(ext.installSource)}`} tone="catalog" />
        )}
        {ext.hasDependencyManifest && (
          <span className={`text-[10px] font-700 px-1.5 py-0.5 rounded-full ${
            ext.dependencyInstallStatus === 'installed'
              ? 'text-emerald-400 bg-emerald-500/10'
              : ext.dependencyInstallStatus === 'error'
                ? 'text-red-400 bg-red-500/10'
                : 'text-amber-400 bg-amber-500/10'
          }`}>
            deps {ext.dependencyInstallStatus || 'ready'}
          </span>
        )}
        {ext.author && (
          <span className="text-[10px] text-text-3 ml-auto">
            {ext.author}
          </span>
        )}
      </div>

      {/* Declared data access */}
      {ext.contractsConsumed && ext.contractsConsumed.length > 0 && (
        <ContractConsumptions consumed={ext.contractsConsumed} />
      )}

      {/*
        Managed resources. The host creates these on install, on enable and on
        upgrade, and this is the control that asks for the same run again --
        after a reconcile that failed or skipped a declaration, or after the
        operator deleted an agent or a routine and wants it back.

        The counts are what the extension declared, not what exists: the host
        does not report per-extension how many were actually created, and
        writing "2 agents" beside a number that came from the manifest would
        claim more than the card knows. The wording says declared for that
        reason. What was really created is the routines list and the agents
        list, and the toast after a run names the numbers.

        A switched-off extension is not loaded, and the reconcile reads its
        declarations off the loaded map: asking would answer with an error
        about an extension that "has no managed resources", which is true of
        the running system and misleading to read next to a card that lists
        two agents. So the button is disabled with the actual reason.

        Which cards that reaches differs by kind, and the difference is the
        host's, not this component's: an external extension that is switched
        off reports no counts at all (`describeCapabilities` has only the
        loaded module to read), so this whole row disappears with it, while a
        built-in one declares its resources whether or not it is on and shows
        the disabled button. Both are honest; neither claims a reconcile is
        available when it is not.
      */}
      {managedCount > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-line-subtle flex items-center justify-between gap-2">
          <span className="text-[11px] text-text-3">
            Declares {ext.managedAgentCount ?? 0} agent{(ext.managedAgentCount ?? 0) === 1 ? '' : 's'} and {ext.managedScheduleCount ?? 0} routine{(ext.managedScheduleCount ?? 0) === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={(e) => onReconcile(e, ext.filename)}
            disabled={reconciling || !ext.enabled}
            title={ext.enabled
              ? 'Create or update the agents and routines this extension declares'
              : 'Switch the extension on first: a disabled extension is not loaded, so the host has no declarations to reconcile'}
            className="shrink-0 h-6 px-2 rounded-sm bg-layer-2 hover:bg-layer-3 text-text-2 text-[10px] font-700 tracking-[0.03em] border border-line-subtle cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {reconciling ? 'Reconciling...' : 'Reconcile'}
          </button>
        </div>
      )}

      {/* Failure warning */}
      {ext.autoDisabled && (
        <p className="mt-2 text-[11px] text-amber-400/90 line-clamp-2">
          Auto-disabled after {ext.failureCount ?? 0} failures
          {ext.lastFailureStage ? ` (${ext.lastFailureStage})` : ''}.
          {ext.lastFailureError ? ` ${ext.lastFailureError}` : ''}
        </p>
      )}
    </div>
  )
}

// --- Sidebar card (compact) ---

function SidebarExtensionCard({ ext, onEdit }: { ext: ExtensionMeta; onEdit: (filename: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(ext.filename)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(ext.filename) } }}
      className="w-full text-left p-3 rounded-md border border-line-subtle bg-surface hover:bg-surface-2 transition-all cursor-pointer"
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-display text-[13px] font-600 text-text truncate">{ext.name}</span>
        <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-full ${
          ext.enabled ? 'text-emerald-400 bg-emerald-400/10' : 'text-text-3/50 bg-layer-2'
        }`}>
          {ext.enabled ? 'On' : 'Off'}
        </span>
      </div>
      <p className="text-[11px] text-text-3 line-clamp-1">{extensionDescription(ext)}</p>
    </div>
  )
}

// --- Highlight text helper ---

function HighlightText({ text, highlight }: { text: string; highlight: string }) {
  if (!highlight.trim()) return <>{text}</>
  const idx = text.toLowerCase().indexOf(highlight.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-accent-bright">{text.slice(idx, idx + highlight.length)}</span>
      {text.slice(idx + highlight.length)}
    </>
  )
}

// --- Marketplace tab ---

function MarketplaceTab({ marketplace, loading, installing, installedFilenames, search, activeTag, setActiveTag, sort, setSort, onInstall }: {
  marketplace: MarketplaceExtension[]
  loading: boolean
  installing: string | null
  installedFilenames: Set<string>
  search: string
  activeTag: string | null
  setActiveTag: (v: string | null) => void
  sort: 'name' | 'downloads'
  setSort: (v: 'name' | 'downloads') => void
  onInstall: (p: MarketplaceExtension) => void
}) {
  if (loading) return <p className="text-[12px] text-text-3 py-8 text-center">Loading marketplace...</p>

  if (marketplace.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-layer-1 mb-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-3">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="9,22 9,12 15,12 15,22" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-[13px] text-text-3">No extensions available in the marketplace</p>
      </div>
    )
  }

  const allTags = dedup(marketplace.flatMap((p) => p.tags ?? [])).sort()
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
          className="px-2 py-1 rounded-xs bg-surface border border-line-subtle text-[10px] text-text-3 outline-none cursor-pointer appearance-none"
          style={{ fontFamily: 'inherit' }}
        >
          <option value="downloads">Popular</option>
          <option value="name">A-Z</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="text-[12px] text-text-3 text-center py-4">No extensions match your search</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
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
                      {p.source && <SourceChip label={getExtensionSourceLabel(p.source)} tone="publisher" />}
                      {p.catalogSource && p.catalogSource !== p.source && (
                        <SourceChip label={`via ${getExtensionSourceLabel(p.catalogSource)}`} tone="catalog" />
                      )}
                    </div>
                    <div className="text-[11px] text-text-3 mt-1 line-clamp-2">{p.description}</div>
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
                    onClick={() => !isInstalled && onInstall(p)}
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
}

function SourceChip({ label, tone }: { label: string; tone: 'publisher' | 'catalog' }) {
  return (
    <span className={tone === 'publisher'
      ? 'text-[10px] font-700 px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-300'
      : 'text-[10px] font-700 px-1.5 py-0.5 rounded-full bg-layer-2 text-text-3/75'}>
      {label}
    </span>
  )
}
