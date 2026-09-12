import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import type { Rpc } from './api'
import { errorText, readTree } from './api'
import { Editor } from './editor'

/**
 * One doc, opened from a card in the chat.
 *
 * The same editor as the Docs page, so a doc reads and saves the same way in
 * both places, conflict warning included -- the agent that wrote it may still
 * be writing. The host draws the title and the close button; the way over to
 * the full page goes into the host's own header beside them, rather than on a
 * second full-width bar directly underneath, which cost a whole row of a panel
 * that is already narrow.
 */

/** The host's header action slot (`chat-preview-panel.tsx`). */
const HEADER_ACTIONS_ID = 'chat-preview-header-actions'

/**
 * The header slot node, once it is in the DOM.
 *
 * Looked up in an effect rather than during render: the host's header and this
 * panel mount in the same commit, so on the first render the node does not
 * exist yet. Returning null until it does simply leaves the link out for one
 * frame; throwing a portal at a missing node would take the panel down.
 */
function useHeaderSlot(): Element | null {
  const [slot, setSlot] = useState<Element | null>(null)
  useEffect(() => {
    setSlot(document.getElementById(HEADER_ACTIONS_ID))
  }, [])
  return slot
}

export function DocPanel({ rpc, refId, onClose, extensionId }: { extensionId: string; rpc: Rpc; refId: string; onClose: () => void }) {
  const [titles, setTitles] = useState<Set<string>>(new Set())
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const headerSlot = useHeaderSlot()

  useEffect(() => {
    rpc('tree')
      .then((raw) => setTitles(new Set(readTree(raw).titles)))
      .catch(() => { /* Links still work; only unresolved-link styling needs this. */ })
  }, [rpc])

  const docsHref = useMemo(() => `/x/docs?doc=${encodeURIComponent(refId)}`, [refId])

  return (
    <div className="docs-panel">
      {headerSlot && createPortal(
        <a className="docs-panel-open" href={docsHref}>Open in Docs</a>,
        headerSlot,
      )}
      {deleteError && <p className="docs-error" role="alert">{deleteError}</p>}
      <Editor
        rpc={rpc}
        id={refId}
        titles={titles}
        extensionId={extensionId}
        onSaved={() => {}}
        panelOpen={false}
        onDelete={() => {
          // Closing on failure would tell the reader the doc is gone when it
          // is not, so the panel stays open and says what happened.
          setDeleteError(null)
          rpc('delete', { id: refId })
            .then((raw) => {
              const message = errorText(raw)
              if (message) setDeleteError(message)
              else onClose()
            })
            .catch((err) => setDeleteError(String(err?.message ?? err)))
        }}
        focusTitle={false}
        onTitleFocused={() => {}}
      />
    </div>
  )
}
