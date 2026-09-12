import { useEffect, useMemo, useState } from 'react'

import type { Rpc } from './api'
import { readTree } from './api'
import { Editor } from './editor'

/**
 * One doc, opened from a card in the chat.
 *
 * The same editor as the Docs page, so a doc reads and saves the same way in
 * both places, conflict warning included -- the agent that wrote it may still
 * be writing. The host draws the title and the close button; this adds the
 * way over to the full page.
 */
export function DocPanel({ rpc, refId, onClose }: { extensionId: string; rpc: Rpc; refId: string; onClose: () => void }) {
  const [titles, setTitles] = useState<Set<string>>(new Set())

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
      <Editor
        rpc={rpc}
        id={refId}
        titles={titles}
        onSaved={() => {}}
        panelOpen={false}
        onDelete={() => { rpc('delete', { id: refId }).finally(onClose) }}
        focusTitle={false}
        onTitleFocused={() => {}}
      />
    </div>
  )
}
