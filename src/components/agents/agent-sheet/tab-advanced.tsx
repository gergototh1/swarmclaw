'use client'

import { MCP_INJECTION_PROVIDER_IDS, WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import type { Agent } from '@/types'
import type { AgentConfigVersionSummary } from '@/lib/agent-config-history'
import { SectionCard, TabEmptyNote } from './section-card'
import type { AgentDraft } from './agent-draft'

interface Props {
  draft: AgentDraft
  editing: Agent | null
  configVersionSummaries: AgentConfigVersionSummary[]
  configVersionsLoading: boolean
  configVersionsError: string | null
  restoringConfigVersionId: string | null
  loadAgentConfigVersions: (agentId: string) => Promise<void>
  handleRestoreConfigVersion: (versionId: string) => Promise<void>
  handleExport: () => void
  onImportClick: () => void
}

/** Configuration History, Utilities - moved verbatim. */
export function TabAdvanced({
  draft,
  editing,
  configVersionSummaries,
  configVersionsLoading,
  configVersionsError,
  restoringConfigVersionId,
  loadAgentConfigVersions,
  handleRestoreConfigVersion,
  handleExport,
  onImportClick,
}: Props) {
  const { provider } = draft
  const showAdvancedGroup = !WORKER_ONLY_PROVIDER_IDS.has(provider) || MCP_INJECTION_PROVIDER_IDS.has(provider)

  return (
    <>
      {editing && showAdvancedGroup && (
        <SectionCard
          title="Configuration History"
          description="Recent saved versions for this agent."
          className="mb-6 border-line-subtle bg-layer-1"
          action={(
            <button
              type="button"
              onClick={() => void loadAgentConfigVersions(editing.id)}
              disabled={configVersionsLoading}
              className="px-3 py-2 rounded-md border border-line-default bg-transparent text-[12px] font-600 text-text-3 hover:bg-layer-2 hover:text-text-2 transition-all disabled:opacity-50"
              style={{ fontFamily: 'inherit' }}
            >
              {configVersionsLoading ? 'Refreshing' : 'Refresh'}
            </button>
          )}
        >
          {configVersionsError ? (
            <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] p-3 text-[13px] text-red-300">
              {configVersionsError}
            </div>
          ) : configVersionsLoading && configVersionSummaries.length === 0 ? (
            <div className="rounded-lg border border-line-subtle bg-surface p-3 text-[13px] text-text-3">
              Loading saved versions...
            </div>
          ) : configVersionSummaries.length === 0 ? (
            <div className="rounded-lg border border-line-subtle bg-surface p-3 text-[13px] text-text-3">
              No saved versions yet.
            </div>
          ) : (
            <div className="space-y-3">
              {configVersionSummaries.slice(0, 8).map((summary) => (
                <div
                  key={summary.id}
                  className="flex flex-col gap-3 rounded-lg border border-line-subtle bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-700 text-text">{summary.title}</div>
                    <div className="mt-1 truncate text-[12px] text-text-3">{summary.subtitle}</div>
                    <div className="mt-1 text-[11px] text-text-3">{summary.meta}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRestoreConfigVersion(summary.id)}
                    disabled={Boolean(restoringConfigVersionId)}
                    className="shrink-0 rounded-md border border-accent-bright/20 bg-accent-soft/30 px-3 py-2 text-[12px] font-700 text-accent-bright transition-all hover:bg-accent-soft disabled:opacity-50"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {restoringConfigVersionId === summary.id ? 'Restoring' : 'Restore'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {showAdvancedGroup && (
      <SectionCard
        title="Utilities"
        description="Import and export agents."
        className="mb-0 border-line-subtle bg-layer-1"
      >
      <div className="flex flex-wrap gap-3">
        {editing ? (
          <button
            type="button"
            onClick={handleExport}
            className="px-4 py-2.5 rounded-sm border border-line-default bg-transparent text-text-2 text-[12px] font-600 cursor-pointer hover:bg-layer-2 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Export agent
          </button>
        ) : (
          <button
            type="button"
            onClick={onImportClick}
            className="px-4 py-2.5 rounded-sm border border-line-default bg-transparent text-text-2 text-[12px] font-600 cursor-pointer hover:bg-layer-2 transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Import agent
          </button>
        )}
      </div>
      </SectionCard>
      )}

      {!showAdvancedGroup && (
        <TabEmptyNote>
          Configuration history and agent import/export sat behind the advanced settings panel, which
          this provider never showed. Nothing here applies to it.
        </TabEmptyNote>
      )}
    </>
  )
}
