'use client'

import { Component, useCallback, type ReactNode } from 'react'
import { getHostRegistry } from '@/components/layout/extension-host'
import { useRegisteredExtensionComponent, type ExtensionComponentFailure } from '@/hooks/use-registered-extension-component'
import type { ToolPanelRef } from '@/lib/chat/tool-panel-refs'

/**
 * The inside of the chat's side panel for something an extension's tool made.
 *
 * Loading, waiting for registration and every failure message are the page
 * route's, through `useRegisteredExtensionComponent`, so a broken extension
 * says the same thing here as on its own page. The component is registered as
 * `panel:<id>` by the same bundle that serves the extension's pages.
 */

function PanelMessage({ failure }: { failure: ExtensionComponentFailure }) {
  return (
    <div className="p-4 text-[13px] leading-[1.6]">
      <p className="font-600 text-danger">{failure.title}</p>
      <p className="mt-2 text-text-2 whitespace-pre-wrap break-words">{failure.detail}</p>
      {failure.hint && <p className="mt-2 text-[12px] text-text-3">{failure.hint}</p>}
      <p className="mt-3 text-[12px]">
        <a className="text-accent-bright underline" href="/extensions">Open the Extensions screen</a>
      </p>
    </div>
  )
}

class PanelBoundary extends Component<{ panelKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: Error | null } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <PanelMessage
        failure={{
          title: `The panel "${this.props.panelKey}" crashed while rendering`,
          detail: this.state.error.message,
          hint: 'The error came from the extension\'s component, not from SwarmClaw. Reload after rebuilding the extension.',
        }}
      />
    )
  }
}

export function ExtensionToolPanel({ panelRef, onClose, headerSlot }: { panelRef: ToolPanelRef; onClose: () => void; headerSlot?: HTMLElement | null }) {
  const componentId = `panel:${panelRef.panelId}`
  const state = useRegisteredExtensionComponent({
    extensionId: panelRef.extensionId,
    componentId,
    entry: panelRef.entry,
    css: panelRef.css,
    declaredIn: 'ui.toolPanels',
  })
  const rpc = useCallback(
    (method: string, body?: object) => getHostRegistry().rpc(panelRef.extensionId, method, body),
    [panelRef.extensionId],
  )

  if (state.status === 'error') return <PanelMessage failure={state.failure} />
  if (state.status === 'loading') return <p className="p-4 text-[13px] text-text-3">Loading…</p>

  const PanelComponent = state.registered.Component
  return (
    <PanelBoundary key={`${panelRef.extensionId}:${componentId}:${panelRef.refId}`} panelKey={`${panelRef.extensionId}:${componentId}`}>
      <PanelComponent extensionId={panelRef.extensionId} rpc={rpc} refId={panelRef.refId} onClose={onClose} headerSlot={headerSlot} />
    </PanelBoundary>
  )
}
