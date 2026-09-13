import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import type { Rpc } from './api'
import { errorText, readTree } from './api'
import { flushAllEditors, leaveBlockedMessage } from './doc-saver'
import { Editor } from './editor'
import { subPathForDoc } from './doc-route'
import { hostOf } from './host'

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

export function DocPanel({ rpc, refId, onClose, extensionId, headerSlot }: {
  extensionId: string
  rpc: Rpc
  refId: string
  onClose: () => void
  /**
   * The host header's action area, handed over by `ExtensionToolPanel`. Null
   * on the first render -- the host sets it from a ref callback during commit
   * -- so the link simply appears one render later rather than the panel
   * having to hunt for a node that is not there yet.
   */
  headerSlot?: HTMLElement | null
}) {
  const [titles, setTitles] = useState<Set<string>>(new Set())
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /**
   * Why "Open in Docs" stayed, when the reason is not on the panel's own
   * editor. It keeps blocking; "Open anyway" is the reader's way past it.
   */
  const [leaveError, setLeaveError] = useState<string | null>(null)
  /**
   * Whether the panel's own editor is currently showing a conflict, not-saved
   * bar, or plain save error for the doc on screen. Unlike `failedEdits`,
   * this covers a block the reader has not yet caused by leaving -- the edit
   * simply is not saved yet.
   */
  const [ownEditorBlocked, setOwnEditorBlocked] = useState(false)

  useEffect(() => {
    rpc('tree')
      .then((raw) => setTitles(new Set(readTree(raw).titles)))
      .catch(() => { /* Links still work; only unresolved-link styling needs this. */ })
  }, [rpc])

  const docsHref = useMemo(() => `/x/docs/${subPathForDoc(refId)}`, [refId])

  // Inside a tab, a full page load would replace the chat tab with Docs, so the
  // doc opens in a new tab instead; outside tabs the page navigates as before.
  const openDocs = () => {
    if (!hostOf().tabs?.openInNewTab(docsHref)) window.location.assign(docsHref)
  }

  return (
    <div className="docs-panel">
      {headerSlot && createPortal(
        <a
          className="docs-panel-open"
          href={docsHref}
          onClick={(e) => {
            // A modified or non-primary click opens elsewhere and leaves this
            // page, and its editor, where they are.
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
            // This link is a full page load, and the `pagehide` flush can be cut
            // off by it: save what is pending first, then go -- but only when
            // every save landed. A failure kept in `failedEdits` lives in
            // module memory the page load would wipe, so it is named here with
            // "Open anyway". A block that is not a kept `failedEdits` entry --
            // a conflict, not-saved bar, or plain error still showing in this
            // panel's own editor -- would otherwise say nothing at all: the
            // reader has not gone anywhere, so nothing was recorded off
            // screen, but the edit still is not saved.
            e.preventDefault()
            setLeaveError(null)
            void flushAllEditors().then(
              (landed) => {
                if (landed) {
                  openDocs()
                  return
                }
                setLeaveError(
                  leaveBlockedMessage()
                  ?? (ownEditorBlocked
                    ? 'The edit in this doc is not saved yet, so Docs was not opened.'
                    : 'Some edits could not be saved, so Docs was not opened.'),
                )
              },
              (err: unknown) => {
                setLeaveError(`Pending edits could not be saved, so Docs was not opened: ${err instanceof Error ? err.message : String(err)}`)
              },
            )
          }}
        >
          Open in Docs
        </a>,
        headerSlot,
      )}
      {leaveError && (
        <p className="docs-error" role="alert">
          {leaveError}{' '}
          <button type="button" onClick={() => openDocs()}>
            Open anyway
          </button>
        </p>
      )}
      {deleteError && <p className="docs-error" role="alert">{deleteError}</p>}
      <Editor
        rpc={rpc}
        id={refId}
        titles={titles}
        extensionId={extensionId}
        onSaved={() => {}}
        onBlocked={setOwnEditorBlocked}
        panelOpen={false}
        onDelete={() => {
          // Closing on failure would tell the reader the doc is gone when it
          // is not, so the panel stays open and says what happened.
          setDeleteError(null)
          return rpc('delete', { id: refId })
            .then((raw) => {
              const message = errorText(raw)
              if (message) { setDeleteError(message); return false }
              onClose()
              return true
            })
            .catch((err: unknown) => {
              setDeleteError(err instanceof Error ? err.message : String(err))
              return false
            })
        }}
        focusTitle={false}
        onTitleFocused={() => {}}
      />
    </div>
  )
}
