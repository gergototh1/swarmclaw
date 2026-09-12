import { useEffect, useMemo, useState } from 'react'

import type { DocRow, Rpc, SearchHit, Tree, TrashItem } from './api'
import { errorText, readList, readSearchHit, readTrashItem } from './api'

/**
 * The left column: a folder tree, a search box and the trash.
 *
 * The tree is derived from the document paths rather than stored, so it cannot
 * disagree with what is actually on disk. Folders that hold nothing still
 * appear, because `tree` returns them separately -- an empty folder the
 * operator just made would otherwise vanish until they put something in it.
 */

interface Node {
  name: string
  path: string
  folders: Node[]
  docs: DocRow[]
}

function buildTree(tree: Tree): Node {
  const root: Node = { name: '', path: '', folders: [], docs: [] }
  const find = (folder: string): Node => {
    if (folder === '') return root
    let node = root
    let sofar = ''
    for (const part of folder.split('/')) {
      sofar = sofar === '' ? part : `${sofar}/${part}`
      let next = node.folders.find((f) => f.name === part)
      if (!next) {
        next = { name: part, path: sofar, folders: [], docs: [] }
        node.folders.push(next)
      }
      node = next
    }
    return node
  }
  for (const folder of tree.folders) find(folder)
  for (const doc of tree.docs) {
    const parts = doc.path.split('/')
    parts.pop()
    find(parts.join('/')).docs.push(doc)
  }
  const sort = (node: Node) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, 'hu'))
    node.docs.sort((a, b) => a.title.localeCompare(b.title, 'hu'))
    node.folders.forEach(sort)
  }
  sort(root)
  return root
}

function Folder({ node, expandedFolders, setExpandedFolders, activeId, onOpen, onDrop, agentName }: {
  node: Node
  expandedFolders: Set<string>
  setExpandedFolders: (next: Set<string>) => void
  activeId: string | null
  onOpen: (id: string) => void
  onDrop: (id: string, folder: string) => void
  agentName: (slug: string) => string | null
}) {
  const open = expandedFolders.has(node.path)
  const toggle = () => {
    const next = new Set(expandedFolders)
    if (open) next.delete(node.path)
    else next.add(node.path)
    setExpandedFolders(next)
  }
  const agentLabel = node.path.startsWith('agents/') && node.path.split('/').length === 2
    ? agentName(node.name)
    : null

  return (
    <li className="docs-tree-folder">
      <button
        type="button"
        className="docs-tree-folder-name"
        onClick={toggle}
        aria-expanded={open}
        onDragOver={(e) => { e.preventDefault() }}
        onDrop={(e) => { e.preventDefault(); onDrop(e.dataTransfer.getData('text/plain'), node.path) }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {agentLabel ? <span aria-hidden="true">🤖</span> : null}
        {agentLabel ?? node.name}
      </button>
      {open && (
        <ul className="docs-tree-list">
          {node.folders.map((f) => (
            <Folder key={f.path} node={f} expandedFolders={expandedFolders} setExpandedFolders={setExpandedFolders} activeId={activeId} onOpen={onOpen} onDrop={onDrop} agentName={agentName} />
          ))}
          {node.docs.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', d.id)}
                className={`docs-tree-doc${d.id === activeId ? ' docs-active' : ''}`}
                onClick={() => onOpen(d.id)}
              >
                <span className="docs-tree-doc-title">{d.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** The title a document is born with, until its author replaces it. */
export const UNTITLED_DOC_TITLE = 'Untitled doc'

export function TreeColumn({ rpc, tree, treeError, activeId, onOpen, onChanged, onNewDoc, agentNames }: {
  rpc: Rpc
  tree: Tree | null
  treeError: string | null
  activeId: string | null
  onOpen: (id: string) => void
  onChanged: () => void
  onNewDoc: (id: string) => void
  agentNames: Map<string, string>
}) {
  const [q, setQ] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [trashItems, setTrashItems] = useState<TrashItem[] | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['agents']))
  const [actionError, setActionError] = useState<string | null>(null)
  // Creating a folder asks -- the path cannot be guessed. Not for a doc: the
  // page creates it, opens it, and the title can be edited in the editor. See
  // the comment above `submitNewFolder` for why this is a field and not
  // `window.prompt`.
  const [creating, setCreating] = useState<null | 'folder'>(null)
  const [newName, setNewName] = useState('')

  const rootNode = useMemo(() => (tree ? buildTree(tree) : null), [tree])

  // An empty search field is not state, it follows from the field's own
  // content. While it was state, the effect called a synchronous setState,
  // which kicks off a needless render chain on every keystroke.
  const searchActive = q.trim() !== ''

  useEffect(() => {
    if (!searchActive) return undefined
    const timer = setTimeout(() => {
      rpc('search', { q })
        .then((raw) => { setSearchHits(readList('search', 'results', raw, readSearchHit)); setSearchError(null) })
        .catch((err) => { setSearchHits(null); setSearchError(String(err?.message ?? err)) })
    }, 250)
    return () => clearTimeout(timer)
  }, [q, searchActive, rpc])

  const loadTrash = () => {
    rpc('trash')
      .then((raw) => setTrashItems(readList('trash', 'items', raw, readTrashItem)))
      .catch((err) => setActionError(String(err?.message ?? err)))
  }

  const runAction = (method: string, body: object) => {
    setActionError(null)
    rpc(method, body)
      .then((raw) => {
        const message = errorText(raw)
        if (message) { setActionError(message); return }
        onChanged()
        if (trashOpen) loadTrash()
      })
      .catch((err) => setActionError(String(err?.message ?? err)))
  }

/**
 * THE NAME COMES FROM A FIELD, NOT `window.prompt`.
 *
 * This module also runs in the desktop app, and Electron does not implement
 * `window.prompt`: the call does not throw, it just returns `undefined` and
 * writes to the console. So both creation buttons stayed silent -- clicking
 * them did nothing visible, and the page had no way to know either. A field of
 * its own runs in the same document as the rest of the page, so there is no
 * runtime where this difference would come up.
 */
  const submitNewFolder = (name: string) => {
    const trimmed = name.trim()
    setCreating(null)
    setNewName('')
    if (trimmed) runAction('createFolder', { folder: trimmed })
  }

  const newDoc = (folder: string, title: string) => {
    if (!title) return
    rpc('create', { folder, title })
      .then((raw) => {
        const message = errorText(raw)
        if (message) { setActionError(message); return }
        onChanged()
        const id = (raw as { id?: string })?.id
        if (id) { onOpen(id); onNewDoc(id) }
      })
      .catch((err) => setActionError(String(err?.message ?? err)))
  }

  return (
    <aside className="docs-column docs-tree">
      <header className="docs-tree-title">
        <h1>Docs</h1>
        <div className="docs-tree-title-buttons">
          <button type="button" onClick={() => { setCreating('folder'); setNewName('') }}>+ Folder</button>
          <button
            type="button"
            className="docs-primary"
            onClick={() => newDoc(tree?.sharedFolderName ?? 'kozos', UNTITLED_DOC_TITLE)}
          >
            + Doc
          </button>
        </div>
      </header>

      <div className="docs-tree-header">
        <input
          type="search"
          value={q}
          placeholder="Search docs…"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search docs"
        />
      </div>

      {creating && (
        <div
          className="docs-modal-backdrop"
          role="presentation"
          onClick={() => { setCreating(null); setNewName('') }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setCreating(null); setNewName('') } }}
        >
          <div
            className="docs-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="docs-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="docs-modal-title">New folder</h2>
            <p className="docs-muted">
              The path is relative to the docs root. An intermediate folder is created on its own.
            </p>
            <form onSubmit={(e) => { e.preventDefault(); submitNewFolder(newName) }}>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. kozos/projects"
                aria-label="The new folder's path"
              />
              <div className="docs-modal-buttons">
                <button type="button" onClick={() => { setCreating(null); setNewName('') }}>Cancel</button>
                <button type="submit" className="docs-primary" disabled={newName.trim() === ''}>
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {actionError && <p className="docs-error" role="alert">{actionError}</p>}

      {searchActive ? (
        <div className="docs-results">
          {searchError && <p className="docs-error" role="alert">{searchError}</p>}
          {searchHits !== null && searchHits.length === 0 && !searchError && <p className="docs-muted">No results.</p>}
          {searchHits?.map((hit) => (
            <button key={hit.id} type="button" className="docs-result" onClick={() => onOpen(hit.id)}>
              <strong>{hit.title}</strong>
              <span className="docs-muted">{hit.path}</span>
              <span>{hit.snippet}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          {treeError && <p className="docs-error" role="alert">{treeError}</p>}
          {!tree && !treeError && <p className="docs-muted">Loading…</p>}
          {rootNode && <p className="docs-label">Docs</p>}
          {rootNode && (
            <ul className="docs-tree-list docs-tree-root">
              {rootNode.folders.map((f) => (
                <Folder
                  key={f.path}
                  node={f}
                  expandedFolders={expandedFolders}
                  setExpandedFolders={setExpandedFolders}
                  activeId={activeId}
                  onOpen={onOpen}
                  onDrop={(id, folder) => runAction('move', { id, newFolder: folder })}
                  agentName={(slug) => agentNames.get(slug) ?? slug}
                />
              ))}
              {rootNode.docs.map((d) => (
                <li key={d.id}>
                  <button type="button" className={`docs-tree-doc${d.id === activeId ? ' docs-active' : ''}`} onClick={() => onOpen(d.id)}>
                    <span className="docs-tree-doc-title">{d.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="docs-trash">
        <p className="docs-label">Trash</p>
        <button
          type="button"
          className="docs-tree-folder-name"
          aria-expanded={trashOpen}
          onClick={() => { const next = !trashOpen; setTrashOpen(next); if (next) loadTrash() }}
        >
          <span aria-hidden="true">{trashOpen ? '▾' : '▸'}</span> Trash
        </button>
        {trashOpen && (
          <ul className="docs-tree-list">
            {trashItems === null && <li className="docs-muted">Loading…</li>}
            {trashItems?.length === 0 && <li className="docs-muted">The trash is empty.</li>}
            {trashItems?.map((item) => (
              <li key={item.id} className="docs-trash-item">
                <span>{item.title}</span>
                <button type="button" onClick={() => runAction('restore', { id: item.id })}>Restore</button>
                <button
                  type="button"
                  className="docs-dangerous"
                  onClick={() => runAction('purge', { id: item.id })}
                >
                  Delete forever
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
