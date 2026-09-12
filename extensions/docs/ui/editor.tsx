import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Conflict, Doc, Rpc } from './api'
import { errorText, isConflict, readDoc } from './api'
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

export function Editor({ rpc, id, titles, onSaved, panelOpen, onTogglePanel, onDelete, focusTitle, onTitleFocused }: {
  rpc: Rpc
  id: string | null
  titles: Set<string>
  onSaved: () => void
  panelOpen: boolean
  onTogglePanel?: () => void
  onDelete: () => void
  focusTitle: boolean
  onTitleFocused: () => void
}) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const [version, setVersion] = useState<number>(0)
  const savedMd = useRef<string>('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
        editor.commands.setContent(mdToHtml(loaded.content, titles))
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
        setSaveState({ kind: 'saved', at: Date.now() })
        onSaved()
      })
      .catch((err) => setSaveState({ kind: 'error', message: String(err?.message ?? err) }))
  }, [id, rpc, onSaved])

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
        if (editor && id) save(htmlToMd(editor.getHTML()), version)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, id, version, save])

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
                setVersion(saveState.conflict.currentVersion)
                editor?.commands.setContent(mdToHtml(theirs, titles))
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
            {onTogglePanel && (
              <button
                type="button"
                className={`docs-details-toggle${panelOpen ? ' docs-active' : ''}`}
                aria-pressed={panelOpen}
                onClick={onTogglePanel}
              >
                Details
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

      <Toolbar editor={editor} />
      </div>

      <EditorContent editor={editor} className="docs-editor-body" />
    </section>
  )
}
