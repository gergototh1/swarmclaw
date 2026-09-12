import { useEffect, useMemo, useState } from 'react'

import type { Rpc } from './api'
import { errorText, readTree } from './api'
import { Editor } from './editor'

/**
 * One doc, opened from a card in the chat.
 *
 * The same editor as the Docs page, so a doc reads and saves the same way in
 * both places, conflict warning included -- the agent that wrote it may still
 * be writing. The host draws the title and the close button; this adds the
 * way over to the full page.
 */
export function DocPanel({ rpc, refId, onClose, extensionId }: { extensionId: string; rpc: Rpc; refId: string; onClose: () => void }) {
  const [titles, setTitles] = useState<Set<string>>(new Set())
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    rpc('tree')
      .then((raw) => setTitles(new Set(readTree(raw).titles)))
      .catch(() => { /* Links still work; only unresolved-link styling needs this. */ })
  }, [rpc])

  const docsHref = useMemo(() => `/x/docs?doc=${encodeURIComponent(refId)}`, [refId])

  return (
    <div className="docs-panel">
      <div className="docs-panel-bar">
        <a className="docs-panel-open" href={docsHref}>Open in Docs</a>
      </div>
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
