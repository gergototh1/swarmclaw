import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Conflict, Doc, Rpc } from './api'
import { errorText, isConflict, readDoc } from './api'
import { shouldSaveOnModeSwitch } from './editor-dirty'
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
 */

const AUTOSAVE_MS = 800

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; conflict: Conflict; mine: string }

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

export function Editor({ rpc, id, titles, onSaved, panelOpen, onTogglePanel, onDelete, focusTitle, onTitleFocused, extensionId }: {
  rpc: Rpc
  id: string | null
  titles: Set<string>
  onSaved: () => void
  panelOpen: boolean
  onTogglePanel?: () => void
  onDelete: () => void
  focusTitle: boolean
  onTitleFocused: () => void
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  const editor = useEditor({
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content: '',
    editorProps: { attributes: { class: 'docs-prose', 'aria-label': 'The doc text' } },
  })

  // Loading: the editor's content is only replaced when a different doc was
  // actually opened -- otherwise every save would bounce the caret back.
  useEffect(() => {
    if (!id || !editor) { setDoc(null); return }
    let stale = false
    setLoadError(null)
    rpc('read', { id })
      .then((raw) => {
        if (stale) return
        const loaded = readDoc(raw)
        setDoc(loaded)
        setVersion(loaded.version)
        setTitle(loaded.title)
        savedMd.current = loaded.content
        setRawText(loaded.content)
        editor.commands.setContent(mdToHtml(loaded.content, titles))
        dirty.current = false
        setSaveState({ kind: 'idle' })
      })
      .catch((err) => { if (!stale) setLoadError(String(err?.message ?? err)) })
    return () => { stale = true }
    // `titles` is deliberately not in the list: a change to the title set is
    // not a reason to reload the editor's content, that would take the caret
    // away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, editor, rpc])

  const save = useCallback((md: string, base: number) => {
    if (!id) return
    setSaveState({ kind: 'saving' })
    rpc('save', { id, content: md, baseVersion: base })
      .then((raw) => {
        if (isConflict(raw)) { setSaveState({ kind: 'conflict', conflict: raw, mine: md }); return }
        const message = errorText(raw)
        if (message) { setSaveState({ kind: 'error', message }); return }
        const next = (raw as { version?: number }).version
        if (typeof next === 'number') setVersion(next)
        savedMd.current = md
        dirty.current = false
        setSaveState({ kind: 'saved', at: Date.now() })
        onSaved()
      })
      .catch((err) => setSaveState({ kind: 'error', message: String(err?.message ?? err) }))
  }, [id, rpc, onSaved])

  /** The markdown on screen, saved or not: the textarea in markdown mode, the editor otherwise. */
  const currentMd = useCallback(
    () => (mode === 'markdown' ? rawText : editor ? htmlToMd(editor.getHTML()) : savedMd.current),
    [mode, rawText, editor],
  )

  /**
   * Switching views carries the text across and saves what is pending first:
   * a change typed a moment ago in one view must not be lost to the other
   * view's copy.
   */
  const switchMode = useCallback((next: EditorMode) => {
    if (next === mode || !editor) return
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const md = currentMd()
    if (shouldSaveOnModeSwitch(dirty.current, md, savedMd.current)) save(md, version)
    if (next === 'markdown') setRawText(md)
    else editor.commands.setContent(mdToHtml(md, titles))
    setMode(next)
    writeEditorMode(next)
  }, [mode, editor, currentMd, save, version, titles])

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

  /** Autosave for the raw view, on the same delay as the editor's. */
  const onRawChange = useCallback((text: string) => {
    setRawText(text)
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (text === savedMd.current) return
      save(text, version)
    }, AUTOSAVE_MS)
  }, [save, version])

  /**
   * Renaming goes through the same `save` call as the body, because a title is
   * stored in the document's own front matter -- there is no separate rename.
   * It is sent on blur and on Enter rather than on every keystroke: a rename
   * writes a version, and one per letter would bury the real history.
   */
  const saveTitle = useCallback(() => {
    if (!id) return
    const trimmed = title.trim()
    if (trimmed === '' || trimmed === doc?.title) { setTitle(doc?.title ?? ''); return }
    setSaveState({ kind: 'saving' })
    rpc('save', { id, content: savedMd.current, title: trimmed, baseVersion: version })
      .then((raw) => {
        if (isConflict(raw)) { setSaveState({ kind: 'conflict', conflict: raw, mine: savedMd.current }); return }
        const message = errorText(raw)
        if (message) { setSaveState({ kind: 'error', message }); return }
        const next = (raw as { version?: number }).version
        if (typeof next === 'number') setVersion(next)
        setDoc((prev) => (prev ? { ...prev, title: trimmed } : prev))
        setSaveState({ kind: 'saved', at: Date.now() })
        onSaved()
      })
      .catch((err) => setSaveState({ kind: 'error', message: String(err?.message ?? err) }))
  }, [id, title, doc, rpc, version, onSaved])

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
  // server last confirmed.
  useEffect(() => {
    if (!editor || !id) return
    const handler = () => {
      dirty.current = true
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const md = htmlToMd(editor.getHTML())
        if (md === savedMd.current) return
        save(md, version)
      }, AUTOSAVE_MS)
    }
    editor.on('update', handler)
    return () => { editor.off('update', handler); if (timer.current) clearTimeout(timer.current) }
  }, [editor, id, version, save])

  // Cmd+S / Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (id) save(currentMd(), version)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, version, save, currentMd])

  if (!id) {
    return (
      <section className="docs-column docs-editor docs-editor-empty">
        <p className="docs-muted">Pick a doc from the tree on the left, or create a new one.</p>
      </section>
    )
  }

  return (
    <section className="docs-column docs-editor">
      {loadError && <p className="docs-error" role="alert">{loadError}</p>}

      {saveState.kind === 'conflict' && (
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
            <button type="button" onClick={() => save(saveState.mine, saveState.conflict.currentVersion)}>
              Keep mine
            </button>
            <button
              type="button"
              onClick={() => {
                const theirs = saveState.conflict.theirs ?? ''
                savedMd.current = theirs
                setRawText(theirs)
                setVersion(saveState.conflict.currentVersion)
                editor?.commands.setContent(mdToHtml(theirs, titles))
                dirty.current = false
                setSaveState({ kind: 'idle' })
              }}
            >
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
              onClick={onDelete}
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
