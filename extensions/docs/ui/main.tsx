import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Rpc, Status, Tree } from './api'
import { errorText, readStatus, readTree } from './api'
import { DocPanel } from './doc-panel'
import { Editor } from './editor'
import { currentExtensionId, hostOf, hostReact } from './host'
import { DetailsPanel } from './details-panel'
import { TreeColumn } from './tree'

/**
 * The page: a status strip and three columns.
 *
 * TWO LOADS, TWO FAILURE STATES, NEVER FOLDED TOGETHER. `status` failing means
 * the module could not be asked about itself; `tree` failing means the tree
 * could not be read. Neither gates the other, and neither is drawn as its
 * opposite: a tree that never loaded shows its message rather than an empty
 * folder list, and a status that could not be read does not make the page
 * pretend everything is fine.
 *
 * The most important thing this page can say is that the root is unwritable,
 * and it says it at the top, with the way out -- because a reader who does not
 * see that reads the empty tree below it as "I have no documents".
 */

export function DocsPage({ rpc }: { extensionId: string; rpc: Rpc }) {
  const [tree, setTree] = useState<Tree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const fromUrl = new URLSearchParams(window.location.search).get('doc')
    return fromUrl && fromUrl.trim() !== '' ? fromUrl : null
  })
  const [agentNames, setAgentNames] = useState<Map<string, string>>(new Map())
  // THE DETAILS COLUMN STARTS CLOSED. While it always stood there, the editor
  // shared its width as a third column with a panel whose content -- path,
  // owner, dates -- does not change while editing and is not needed for it.
  // The text gets the room, and whoever is curious about the details brings it
  // up with one click.
  const [panelOpen, setPanelOpen] = useState(false)
  // Which doc was just created. It drives exactly one thing: the editor moves
  // the caret to the title, so "Untitled doc" does not stay that way.
  const [freshDocId, setFreshDocId] = useState<string | null>(null)

  const refresh = useCallback(() => {
    rpc('tree')
      .then((raw) => { setTree(readTree(raw)); setTreeError(null) })
      .catch((err) => setTreeError(String(err?.message ?? err)))
    rpc('status')
      .then((raw) => { setStatus(readStatus(raw)); setStatusError(null) })
      .catch((err) => setStatusError(String(err?.message ?? err)))
    rpc('agents')
      .then((raw) => {
        if (errorText(raw)) return
        const list = (raw as { agents?: Array<{ slug?: string }> }).agents ?? []
        setAgentNames(new Map(list.map((a) => [String(a.slug ?? ''), String(a.slug ?? '')])))
      })
      .catch(() => { /* The tree also works with the slug; this would only give a nicer name. */ })
  }, [rpc])

  useEffect(() => { refresh() }, [refresh])

  /**
   * DELETING IS A MOVE TO THE TRASH, NOT A REMOVAL.
   *
   * `delete` sets `deleted_at`; the document leaves the tree and turns up
   * under Trash, where "Restore" brings it back and "Delete forever" is the
   * one irreversible button on this page. The undo is one click away and
   * visible in the same column, which is why this asks nothing first.
   *
   * It lives here rather than in the tree because it acts on the OPEN
   * document: the editor has to be closed in the same step, or it goes on
   * autosaving into a row nothing shows any more.
   */
  const handleDelete = useCallback(() => {
    if (!activeId) return
    rpc('delete', { id: activeId })
      .then(() => { setActiveId(null); refresh() })
      .catch(() => refresh())
  }, [activeId, rpc, refresh])

  const titles = useMemo(() => new Set(tree?.titles ?? []), [tree])

  return (
    <div className="docs-page">
      {status && !status.rootOk && (
        <p className="docs-bar docs-bar-alert" role="alert">
          The docs root is not reachable: {status.rootError ?? status.configuredRoot}. Set it in the Docs extension
          settings, then reload this page.
        </p>
      )}
      {statusError && <p className="docs-bar docs-bar-alert" role="alert">Status could not be read: {statusError}</p>}
      {status && status.migrationBlocked.map((b) => (
        <p key={b.from} className="docs-bar docs-bar-alert" role="alert">
          The <code>{b.from}</code> folder could not be renamed to <code>{b.to}</code> because <code>{b.to}</code> already
          exists. Merge the two by hand; the rename runs by itself on the next load after that.
        </p>
      ))}
      {status?.rootOk && !status.watcherRunning && (
        <p className="docs-bar">
          Watching for outside edits is stopped{status.watcherError ? `: ${status.watcherError}` : ''}. Changes made
          in Finder or Obsidian will not show in search until you restart it.
          <button type="button" onClick={() => { rpc('restartWatcher').then(refresh).catch(() => refresh()) }}>
            Restart
          </button>
          <button type="button" onClick={() => { rpc('reindex').then(refresh).catch(() => refresh()) }}>
            Reindex now
          </button>
        </p>
      )}

      <div className={`docs-columns${panelOpen ? ' docs-columns-with-details' : ''}`}>
        <TreeColumn
          rpc={rpc}
          tree={tree}
          treeError={treeError}
          activeId={activeId}
          onOpen={setActiveId}
          onChanged={refresh}
          onNewDoc={setFreshDocId}
          agentNames={agentNames}
        />
        <Editor
          rpc={rpc}
          id={activeId}
          titles={titles}
          onSaved={refresh}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((prev) => !prev)}
          onDelete={handleDelete}
          focusTitle={freshDocId !== null && freshDocId === activeId}
          onTitleFocused={() => setFreshDocId(null)}
        />
        {panelOpen && <DetailsPanel rpc={rpc} id={activeId} onChanged={refresh} />}
      </div>
    </div>
  )
}

/**
 * Registration happens at top-level script scope, where
 * `document.currentScript` still names the tag the loader injected. The
 * extension id comes from that tag: the registry keys pages on the extension
 * file's id and refuses a registration under any other, so it is read rather
 * than written here.
 *
 * Guarded on `document` so the same module can be imported by the tests, which
 * have no host to register with.
 */
if (typeof document !== 'undefined') {
  const host = hostOf()
  const opts = { react: hostReact(), extensionId: currentExtensionId() ?? '' }
  host.registerPage('docs', DocsPage, opts)
  host.registerPage('panel:doc', DocPanel, opts)
}
