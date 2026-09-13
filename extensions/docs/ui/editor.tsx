import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Doc, Rpc } from './api'
import { createAutosave, type Autosave } from './autosave'
import { createDocSaver, trackMountedEditor, type DocScreen, type SaveState } from './doc-saver'
import { saveQueue } from './doc-store'
import { readEditorMode, writeEditorMode, type EditorMode } from './editor-mode'
import { downloadBlob } from './export/download'
import { exportFileName } from './export/file-name'
import { loadExportBundle } from './export/load-export-bundle'
import { buildPrintHtml, fetchEmbeddedFontsCss } from './export/print-html'
import { hostOf } from './host'
import { htmlToMd, mdToHtml } from './markdown'

/**
 * The middle column: the document, edited as formatted text and saved as
 * markdown.
 *
 * SAVING IS DEBOUNCED AND VERSIONED. Every save carries the version the editor
 * loaded, and the server refuses one built on a version somebody else has
 * already replaced. That refusal is not an error state here -- it is a bar with
 * three buttons, because the merge is a decision and the page does not have
 * enough to make it. The refusal arrives with the other side's text attached,
 * so showing the difference costs no second request.
 *
 * `savedMd` is what the server last confirmed. The editor is only saved when
 * the converted markdown differs from it, which is what stops merely opening a
 * document from rewriting it -- an important property when the file may have
 * been written by hand or by another tool.
 *
 * WHAT SAVES, WHEN, AND WHERE A RESPONSE MAY LAND is decided in `doc-saver.ts`,
 * which also lists the rules that keep an edit from being dropped or saved
 * into the wrong doc. This component holds the refs, effects and rendering,
 * and implements that module's `DocScreen` over them.
 */

const AUTOSAVE_MS = 800

/**
 * Icons for the editor header's icon-only buttons, drawn in the same style as
 * the delete button already there: 24x24 viewBox, `currentColor` stroke,
 * `aria-hidden` since the button carries the label as `title`/`aria-label`.
 */
function MarkdownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="8 6 2 12 8 18" />
      <polyline points="16 6 22 12 16 18" />
    </svg>
  )
}

function DetailsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}

function ExportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

/** The document-with-a-W glyph for the "Word (.docx)" export item. */
function WordDocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <polyline points="7 12 8.5 18 10.5 13 12.5 18 14 12" />
    </svg>
  )
}

/** The document-with-a-"PDF"-tag glyph for the "PDF" export item. */
function PdfDocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <text x="6.3" y="17" fontSize="6.5" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
    </svg>
  )
}

function Toolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null
  const btn = (label: string, active: boolean, onClick: () => void, description: string) => (
    <button
      type="button"
      className={active ? 'docs-active' : undefined}
      onClick={onClick}
      aria-label={description}
      title={description}
    >
      {label}
    </button>
  )
  return (
    <div className="docs-toolbar" role="toolbar" aria-label="Formatting">
      {btn('H1', editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), 'Heading 1')}
      {btn('H2', editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'Heading 2')}
      {btn('H3', editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'Heading 3')}
      {btn('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold')}
      {btn('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'Italic')}
      {btn('• list', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), 'Bulleted list')}
      {btn('1. list', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), 'Numbered list')}
      {btn('" quote', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), 'Quote')}
      {btn('code', editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run(), 'Code block')}
      {btn('table', false, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), 'Insert table')}
      {btn('—', false, () => editor.chain().focus().setHorizontalRule().run(), 'Divider')}
    </div>
  )
}

export function Editor({ rpc, id, titles, onSaved, panelOpen, onTogglePanel, onDelete, focusTitle, onTitleFocused, onTitle, extensionId }: {
  rpc: Rpc
  id: string | null
  titles: Set<string>
  onSaved: () => void
  panelOpen: boolean
  onTogglePanel?: () => void
  /** Moves the open doc to the trash. Resolves true when it is gone, false when it is not. */
  onDelete: () => Promise<boolean>
  focusTitle: boolean
  onTitleFocused: () => void
  /** The open doc's title after every load and rename; null when no doc is open or it could not be read. */
  onTitle?: (title: string | null) => void
  extensionId: string
}) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const [version, setVersion] = useState<number>(0)
  const [mode, setMode] = useState<EditorMode>(() => readEditorMode())
  const [rawText, setRawText] = useState('')
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  // Read once per render, not cached in a ref: the host installs
  // `window.swarmclaw` before this component can mount (see `host.ts`), so
  // there is nothing to race, and re-reading is cheap. `HostDropdown`/
  // `HostDropdownItem` are `undefined` on a host older than this feature --
  // the JSX below falls back to the plain `<details>` menu in that case.
  const HostDropdown = hostOf().ui?.Dropdown
  const HostDropdownItem = hostOf().ui?.DropdownItem
  const savedMd = useRef<string>('')
  /** The doc on screen now, for a response that lands after the reader moved on. */
  const openIdRef = useRef<string | null>(id)
  /** The doc whose content is in the editor; nothing is saved before it loads. */
  const loadedIdRef = useRef<string | null>(null)
  const autosaveRef = useRef<Autosave | null>(null)
  /** The doc whose trash button was pressed: it takes no saves until the delete settles. */
  const deleteBlockRef = useRef<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  /** The view and the markdown text as of the last event, readable from a timer. */
  const modeRef = useRef<EditorMode>(mode)
  const rawTextRef = useRef('')
  const onTitleRef = useRef(onTitle)
  /**
   * Whether the viewer edited the doc since it was loaded (or last saved).
   * This is NOT derived from comparing text: `editor.commands.setContent`
   * (used on load, on mode switch, and to apply "keep theirs") is called
   * with `emitUpdate` left at its default of `false`, so it never fires the
   * `update` event below -- only a genuine keystroke or toolbar command
   * does. That is what makes this ref a true "did the viewer touch it"
   * signal rather than a "does the text differ" one; see `editor-dirty.ts`.
   */
  const dirty = useRef(false)
  // The title is editable, so it has its own field state. `doc.title` is what
  // came from the server; this is what is being typed right now.
  const [title, setTitle] = useState('')
  const titleInput = useRef<HTMLInputElement | null>(null)
  /** The latest props and doc, for the saver's screen, which outlives a render. */
  const rpcRef = useRef(rpc)
  const onSavedRef = useRef(onSaved)
  const titlesRef = useRef(titles)
  const docRef = useRef<Doc | null>(null)

  useEffect(() => {
    openIdRef.current = id
    onTitleRef.current = onTitle
    rpcRef.current = rpc
    onSavedRef.current = onSaved
    titlesRef.current = titles
    docRef.current = doc
  })
  // An unmounted editor shows no doc: a save flushed on the way out lands off
  // screen, so a failure is kept for the next open instead of vanishing.
  useEffect(() => () => {
    openIdRef.current = null
    loadedIdRef.current = null
  }, [])

  const setRaw = useCallback((text: string) => {
    rawTextRef.current = text
    setRawText(text)
  }, [])

  const editor = useEditor({
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content: '',
    editorProps: { attributes: { class: 'docs-prose', 'aria-label': 'The doc text' } },
  })
  const editorRef = useRef<ReturnType<typeof useEditor>>(null)
  useEffect(() => { editorRef.current = editor })

  /** The editor as `doc-saver.ts` sees it: one object for the component's life. */
  const [screen] = useState<DocScreen>(() => ({
    openId: () => openIdRef.current,
    loadedId: () => loadedIdRef.current,
    setLoadedId: (docId) => { loadedIdRef.current = docId },
    isDeleteBlocked: (docId) => deleteBlockRef.current === docId,
    setDeleteBlocked: (docId) => { deleteBlockRef.current = docId },
    showDeleting: (docId, deleting) => {
      if (deleting) setDeletingId(docId)
      else setDeletingId((current) => (current === docId ? null : current))
    },
    // The textarea in markdown mode, the editor otherwise.
    currentMd: () => {
      const shown = editorRef.current
      return modeRef.current === 'markdown' ? rawTextRef.current : shown ? htmlToMd(shown.getHTML()) : savedMd.current
    },
    savedMd: () => savedMd.current,
    setSavedMd: (md) => { savedMd.current = md },
    isDirty: () => dirty.current,
    setDirty: (value) => { dirty.current = value },
    setSaveState,
    setVersion,
    docTitle: () => docRef.current?.title ?? null,
    setDoc: (next) => {
      setDoc(next)
      onTitleRef.current?.(next ? next.title : null)
    },
    setDocTitle: (renamed) => {
      setDoc((prev) => (prev ? { ...prev, title: renamed } : prev))
      onTitleRef.current?.(renamed)
    },
    setTitleField: setTitle,
    setRawText: setRaw,
    setEditorContent: (md) => { editorRef.current?.commands.setContent(mdToHtml(md, titlesRef.current)) },
    setLoadError,
    cancelAutosave: () => { autosaveRef.current?.cancel() },
    scheduleAutosave: () => { autosaveRef.current?.schedule() },
    onSaved: () => { onSavedRef.current() },
  }))
  const [saver] = useState(() => createDocSaver({
    rpc: (method, body) => rpcRef.current(method, body),
    queue: saveQueue,
    screen,
  }))
  const currentMd = screen.currentMd

  // Loading: the editor's content is only replaced when a different doc was
  // actually opened -- otherwise every save would bounce the caret back.
  useEffect(() => {
    return saver.open(id, editor ? (md) => { editor.commands.setContent(mdToHtml(md, titles)) } : null)
    // `titles` is deliberately not in the list: a change to the title set is
    // not a reason to reload the editor's content, that would take the caret
    // away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, editor, rpc, saver])

  /**
   * Switching views carries the text across; `leaveView` saves what is pending
   * first.
   */
  const switchMode = useCallback((next: EditorMode) => {
    if (next === mode || !editor) return
    const md = saver.leaveView(id)
    if (next === 'markdown') setRaw(md)
    else editor.commands.setContent(mdToHtml(md, titles))
    modeRef.current = next
    setMode(next)
    writeEditorMode(next)
  }, [mode, editor, id, saver, setRaw, titles])

  const exportTitle = (title.trim() || doc?.title || 'doc')

  const exportDocx = useCallback(async () => {
    setExportError(null)
    try {
      const api = await loadExportBundle(extensionId)
      const blob = await api.markdownToDocx(currentMd(), exportTitle)
      downloadBlob(blob, exportFileName(exportTitle, 'docx'))
    } catch (err) {
      setExportError(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [extensionId, currentMd, exportTitle])

  const exportPdf = useCallback(async () => {
    setExportError(null)
    try {
      const host = hostOf()
      if (typeof host.savePdf !== 'function') throw new Error('this SwarmClaw version cannot save PDFs; update the app')
      const embeddedFontsCss = await fetchEmbeddedFontsCss()
      await host.savePdf({ html: buildPrintHtml(currentMd(), exportTitle, embeddedFontsCss), fileName: exportFileName(exportTitle, 'pdf') })
    } catch (err) {
      setExportError(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [currentMd, exportTitle])

  /**
   * The raw view autosaves through the same debouncer as the formatted one. An
   * edit is dirty even while a delete is out; only the countdown waits for it.
   */
  const onRawChange = useCallback((text: string) => {
    setRaw(text)
    saver.edited(id)
  }, [id, setRaw, saver])

  /** Renaming is sent on blur and on Enter; see `rename` in `doc-saver.ts`. */
  const saveTitle = useCallback(() => {
    void saver.rename(id, title)
  }, [id, title, saver])

  // A freshly created doc's title is the placeholder; the caret goes there and
  // the text is selected, so it can be typed over.
  useEffect(() => {
    if (!focusTitle || !doc) return
    const field = titleInput.current
    if (!field) return
    field.focus()
    field.select()
    onTitleFocused()
  }, [focusTitle, doc, onTitleFocused])

  // Autosave: only when the markdown is actually different from what the
  // server last confirmed. Moving to another doc, unmounting and hiding the
  // page flush the pending edit instead of dropping it.
  useEffect(() => {
    if (!editor || !id) return
    const docId = id
    const autosave = createAutosave({
      delayMs: AUTOSAVE_MS,
      read: screen.currentMd,
      saved: screen.savedMd,
      save: (md) => { void saver.save(docId, md) },
    })
    autosaveRef.current = autosave
    const untrack = trackMountedEditor({ flush: () => autosave.flushPending(), queue: saveQueue })
    const onEdit = () => saver.edited(docId)
    const onPageHide = () => autosave.flushPending()
    editor.on('update', onEdit)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      editor.off('update', onEdit)
      window.removeEventListener('pagehide', onPageHide)
      autosave.flushPending()
      untrack()
      if (autosaveRef.current === autosave) autosaveRef.current = null
    }
  }, [editor, id, screen, saver])

  // Cmd+S / Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saver.saveNow(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, saver])

  /** The trash button; see `remove` in `doc-saver.ts`. */
  const handleDelete = useCallback(() => saver.remove(id, onDelete), [id, onDelete, saver])

  if (!id) {
    return (
      <section className="docs-column docs-editor docs-editor-empty">
        <p className="docs-muted">Pick a doc from the tree on the left, or create a new one.</p>
      </section>
    )
  }

  // A bar's buttons act only while its doc is the open one and has loaded;
  // `doc-saver.ts` checks that.
  const keepMine = () => { void saver.keepMine(saveState) }
  const keepTheirs = () => { void saver.keepTheirs(saveState) }
  const restoreUnsaved = () => saver.restoreUnsaved(saveState)
  const discardUnsaved = () => saver.discardUnsaved(saveState)

  return (
    <section className="docs-column docs-editor">
      {loadError && <p className="docs-error" role="alert">{loadError}</p>}

      {saveState.kind === 'unsaved' && saveState.docId === id && (
        <div className="docs-conflict" role="alert">
          <p>
            <strong>An earlier edit to this doc was not saved.</strong>{' '}
            {saveState.message}
          </p>
          <div className="docs-conflict-buttons">
            <button type="button" onClick={restoreUnsaved}>
              Restore it
            </button>
            <button type="button" onClick={discardUnsaved}>
              Discard
            </button>
          </div>
        </div>
      )}

      {saveState.kind === 'conflict' && saveState.docId === id && (
        <div className="docs-conflict" role="alert">
          <p>
            <strong>This doc was changed in the meantime by: {saveState.conflict.modifiedBy ?? 'someone else'}.</strong>{' '}
            Your edit is not saved.
          </p>
          <details>
            <summary>See the difference</summary>
            <div className="docs-diff">
              <div>
                <h4>Theirs (v{saveState.conflict.currentVersion})</h4>
                <pre>{saveState.conflict.theirs ?? '(not available)'}</pre>
              </div>
              <div>
                <h4>Yours</h4>
                <pre>{saveState.mine}</pre>
              </div>
            </div>
          </details>
          <div className="docs-conflict-buttons">
            <button type="button" onClick={keepMine}>
              Keep mine
            </button>
            <button type="button" onClick={keepTheirs}>
              Keep theirs
            </button>
          </div>
        </div>
      )}

      <div className="docs-editor-top">
      <header className="docs-editor-header">
        <div className="docs-editor-title-row">
          <input
            ref={titleInput}
            className="docs-title"
            value={title}
            placeholder="The doc's title"
            aria-label="The doc's title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
              if (e.key === 'Escape') { setTitle(doc?.title ?? ''); e.currentTarget.blur() }
            }}
          />
          <div className="docs-head-buttons">
            <button
              type="button"
              className={`docs-mode-toggle${mode === 'markdown' ? ' docs-active' : ''}`}
              aria-pressed={mode === 'markdown'}
              title={mode === 'markdown' ? 'Show formatted' : 'Show markdown source'}
              aria-label={mode === 'markdown' ? 'Show formatted' : 'Show markdown source'}
              onClick={() => switchMode(mode === 'markdown' ? 'formatted' : 'markdown')}
            >
              <MarkdownIcon />
            </button>
            {HostDropdown ? (
              <div className="docs-export">
                <button
                  type="button"
                  className={`docs-export-trigger${exportMenuOpen ? ' docs-active' : ''}`}
                  title="Export"
                  aria-label="Export"
                  aria-haspopup="menu"
                  aria-expanded={exportMenuOpen}
                  onClick={() => setExportMenuOpen((open) => !open)}
                >
                  <ExportIcon />
                </button>
                {/*
                  The host's own `Dropdown` already positions and styles the
                  floating panel (see `components/shared/dropdown.tsx`), so
                  its children go straight in rather than through another
                  `.docs-export-menu` wrapper -- nesting one absolutely
                  positioned menu shell inside another would fight the host's
                  own positioning instead of matching it.

                  `anchor="trigger"` is what keeps the menu next to the
                  Export button: the default `Dropdown` position is fixed to
                  the viewport corner, which drifts away from this trigger
                  because it sits in the editor's middle column rather than a
                  page corner, and drifts further still once the details
                  panel (toggled by the button right next to this one) opens
                  and narrows that column. `anchor="trigger"` instead
                  positions the menu absolutely against the nearest
                  positioned ancestor, which is `.docs-export` on the
                  wrapping `<div>` just below (see `style.css`).
                */}
                <HostDropdown open={exportMenuOpen} onClose={() => setExportMenuOpen(false)} anchor="trigger">
                  {HostDropdownItem ? (
                    <>
                      <HostDropdownItem onClick={() => { setExportMenuOpen(false); void exportDocx() }}>
                        <span className="docs-export-item">
                          <WordDocIcon />
                          <span>Word (.docx)</span>
                        </span>
                      </HostDropdownItem>
                      <HostDropdownItem onClick={() => { setExportMenuOpen(false); void exportPdf() }}>
                        <span className="docs-export-item">
                          <PdfDocIcon />
                          <span>PDF</span>
                        </span>
                      </HostDropdownItem>
                    </>
                  ) : (
                    <>
                      <button type="button" role="menuitem" className="docs-export-item" onClick={() => { setExportMenuOpen(false); void exportDocx() }}>
                        <WordDocIcon />
                        <span>Word (.docx)</span>
                      </button>
                      <button type="button" role="menuitem" className="docs-export-item" onClick={() => { setExportMenuOpen(false); void exportPdf() }}>
                        <PdfDocIcon />
                        <span>PDF</span>
                      </button>
                    </>
                  )}
                </HostDropdown>
              </div>
            ) : (
              <details className="docs-export">
                <summary className="docs-export-trigger" title="Export" aria-label="Export">
                  <ExportIcon />
                </summary>
                <div className="docs-export-menu" role="menu">
                  <button type="button" role="menuitem" className="docs-export-item" onClick={() => { void exportDocx() }}>
                    <WordDocIcon />
                    <span>Word (.docx)</span>
                  </button>
                  <button type="button" role="menuitem" className="docs-export-item" onClick={() => { void exportPdf() }}>
                    <PdfDocIcon />
                    <span>PDF</span>
                  </button>
                </div>
              </details>
            )}
            {onTogglePanel && (
              <button
                type="button"
                className={`docs-details-toggle${panelOpen ? ' docs-active' : ''}`}
                aria-pressed={panelOpen}
                title={panelOpen ? 'Hide details' : 'Show details'}
                aria-label={panelOpen ? 'Hide details' : 'Show details'}
                onClick={onTogglePanel}
              >
                <DetailsIcon />
              </button>
            )}
            <button
              type="button"
              className="docs-delete"
              aria-label="Move to trash"
              title="To the trash"
              disabled={deletingId === id}
              onClick={() => { void handleDelete() }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6M10 11v6M14 11v6" />
              </svg>
            </button>
          </div>
        </div>
        <span className="docs-muted">
          {doc?.path} · v{version}
          {saveState.kind === 'saving' && ' · saving…'}
          {saveState.kind === 'saved' && ' · saved'}
        </span>
        {saveState.kind === 'error' && <span className="docs-error">{saveState.message}</span>}
      </header>
      {exportError && <p className="docs-error" role="alert">{exportError}</p>}

      {mode === 'formatted' && <Toolbar editor={editor} />}
      </div>

      <div hidden={mode === 'markdown'}>
        <EditorContent editor={editor} className="docs-editor-body" />
      </div>
      {mode === 'markdown' && (
        <textarea
          className="docs-raw"
          value={rawText}
          onChange={(e) => onRawChange(e.target.value)}
          spellCheck={false}
          aria-label="Markdown source"
        />
      )}
    </section>
  )
}
