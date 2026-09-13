import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Conflict, Doc, Rpc } from './api'
import { errorText, isConflict, readDoc } from './api'
import { createAutosave, type Autosave } from './autosave'
import {
  bumpGeneration,
  confirmed,
  failedEdits,
  generationOf,
  saveQueue,
  type ConfirmedDoc,
  type FailedEdit,
} from './doc-store'
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
 *
 * NOTHING TYPED IS DROPPED, AND NOTHING LANDS IN THE WRONG DOC. Each rule below
 * closes a way an edit used to go missing:
 *
 * - A pending autosave is flushed, not cleared, when the editor moves to
 *   another doc, unmounts or the page is hidden (`autosave.ts`).
 * - Reads and saves for one doc run one at a time (`save-queue.ts`), and a
 *   save reads its base version when it starts. The last confirmed version and
 *   body are kept per doc id, so a save for a doc the reader has already left
 *   still uses, and still records, that doc's own version.
 * - A response only touches what is on screen while its doc is still the open
 *   one.
 * - Nothing is saved until the open doc has loaded: until then the editor is
 *   still showing the previous doc's text.
 * - The queue, the confirmed record and the generation count are shared by
 *   every editor this bundle mounts (`doc-store.ts`), so the Docs page and the
 *   chat panel wait for each other's saves on the same doc.
 * - The conflict bar belongs to one doc: it goes away when another doc opens,
 *   and its buttons act only while that doc is open and loaded.
 * - "Keep theirs" voids every save for the doc queued before the click, and
 *   applies theirs through the queue, after whatever is already out.
 * - An edit typed while a delete is out is still marked dirty, so a failed
 *   delete saves it.
 * - A save that fails while its doc is not on screen is kept, and shown the
 *   next time that doc opens.
 */

const AUTOSAVE_MS = 800

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  /**
   * `title` is set when the refused save was a rename, so "Keep mine" sends it
   * again. `restored` is set when the conflict came from a save made while the
   * doc was not on screen: the editor then shows the doc as loaded, not `mine`.
   */
  | { kind: 'conflict'; docId: string; conflict: Conflict; mine: string; title?: string; restored?: boolean }
  /** A save made while the doc was not on screen failed for a reason other than a conflict. */
  | { kind: 'unsaved'; docId: string; mine: string; message: string }

/**
 * The bar for an edit that failed while its doc was not on screen. A conflict
 * is compared against the doc as just loaded, which is what the server holds
 * now, not what it held when the save was refused.
 */
function stateForFailedEdit(docId: string, failed: FailedEdit, current: ConfirmedDoc): SaveState {
  if (failed.conflict) {
    return {
      kind: 'conflict',
      docId,
      conflict: { ...failed.conflict, currentVersion: current.version, theirs: current.content },
      mine: failed.mine,
      title: failed.title,
      restored: true,
    }
  }
  return { kind: 'unsaved', docId, mine: failed.mine, message: failed.message ?? 'The save failed.' }
}

/** The autosave of every mounted editor, so leaving the page can flush them all. */
const mountedAutosaves = new Set<Autosave>()

/**
 * Saves every pending edit in every mounted editor now, and resolves once every
 * read and save out at that moment has settled. For a link that leaves the page
 * with a full load, where the `pagehide` flush may be cut off.
 */
export async function flushAllEditors(): Promise<void> {
  for (const autosave of mountedAutosaves) autosave.flushPending()
  await saveQueue.whenIdle()
}

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

  useEffect(() => {
    openIdRef.current = id
    onTitleRef.current = onTitle
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

  // Loading: the editor's content is only replaced when a different doc was
  // actually opened -- otherwise every save would bounce the caret back. The
  // read waits behind any save still out for the same doc, so a doc reopened
  // mid-save is read with that save already in it.
  useEffect(() => {
    loadedIdRef.current = null
    // The previous doc's bar, conflict included, must not stay up over this one.
    setSaveState({ kind: 'idle' })
    if (deleteBlockRef.current !== id) deleteBlockRef.current = null
    if (!id || !editor) { setDoc(null); onTitleRef.current?.(null); return }
    const docId = id
    let stale = false
    setLoadError(null)
    void saveQueue(docId, async () => {
      try {
        const loaded = readDoc(await rpc('read', { id: docId }))
        if (stale) return
        const current = { version: loaded.version, content: loaded.content }
        confirmed.set(docId, current)
        setDoc(loaded)
        setVersion(loaded.version)
        setTitle(loaded.title)
        savedMd.current = loaded.content
        setRaw(loaded.content)
        editor.commands.setContent(mdToHtml(loaded.content, titles))
        dirty.current = false
        const failed = failedEdits.get(docId)
        failedEdits.delete(docId)
        setSaveState(failed ? stateForFailedEdit(docId, failed, current) : { kind: 'idle' })
        loadedIdRef.current = docId
        onTitleRef.current?.(loaded.title)
      } catch (err) {
        if (stale) return
        // A doc that cannot be read must not leave the previous doc's text on
        // screen under this doc's URL.
        setDoc(null)
        setVersion(0)
        setTitle('')
        savedMd.current = ''
        setRaw('')
        editor.commands.setContent('')
        dirty.current = false
        setSaveState({ kind: 'idle' })
        setLoadError(err instanceof Error ? err.message : String(err))
        onTitleRef.current?.(null)
      }
    })
    return () => { stale = true }
    // `titles` is deliberately not in the list: a change to the title set is
    // not a reason to reload the editor's content, that would take the caret
    // away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, editor, rpc])

  /** The markdown on screen, saved or not: the textarea in markdown mode, the editor otherwise. */
  const currentMd = useCallback(
    () => (modeRef.current === 'markdown' ? rawTextRef.current : editor ? htmlToMd(editor.getHTML()) : savedMd.current),
    [editor],
  )

  /**
   * Every save goes through here: the body, a rename, Cmd+S, a flush, a view
   * switch and "Keep mine". It is queued per doc and reads that doc's base
   * version when it starts. `md` null means a rename: it sends the body as
   * confirmed when the rename starts, so it cannot undo a body save queued
   * ahead of it.
   *
   * The doc's generation is taken when `save` is called: if "Keep theirs" has
   * bumped it by the time the run starts, the run does nothing, and a response
   * that lands after the bump touches nothing on screen. A conflict or an error
   * for a doc that is not on screen is kept in `failedEdits` for its next open.
   */
  const save = useCallback((docId: string, md: string | null, opts?: { title?: string; baseVersion?: number }): Promise<void> => {
    const generation = generationOf(docId)
    return saveQueue(docId, async () => {
      const current = () => generationOf(docId) === generation
      if (!current() || deleteBlockRef.current === docId) return
      const content = md ?? confirmed.get(docId)?.content
      if (content === undefined) return
      // Loaded, not merely open: a doc reopened while this save was out is read
      // after it, and that load would wipe a bar put up before it.
      const onScreen = () =>
        openIdRef.current === docId && loadedIdRef.current === docId && deleteBlockRef.current !== docId
      const fail =(conflict: Conflict | null, message: string | null) => {
        if (!current()) return
        if (!onScreen()) {
          failedEdits.set(docId, { mine: content, title: opts?.title, conflict, message })
          return
        }
        if (conflict) setSaveState({ kind: 'conflict', docId, conflict, mine: content, title: opts?.title })
        else setSaveState({ kind: 'error', message: message ?? 'The save failed.' })
      }
      if (onScreen()) setSaveState({ kind: 'saving' })
      const baseVersion = opts?.baseVersion ?? confirmed.get(docId)?.version ?? 0
      try {
        const raw = await rpc('save', opts?.title === undefined
          ? { id: docId, content, baseVersion }
          : { id: docId, content, title: opts.title, baseVersion })
        if (isConflict(raw)) {
          fail(raw, null)
          return
        }
        const message = errorText(raw)
        if (message) {
          fail(null, message)
          return
        }
        const next = (raw as { version?: number }).version
        confirmed.set(docId, { version: typeof next === 'number' ? next : baseVersion, content })
        failedEdits.delete(docId)
        onSaved()
        if (!onScreen() || !current()) return
        if (typeof next === 'number') setVersion(next)
        savedMd.current = content
        // Text typed while this save was out is still unsaved.
        if (currentMd() === content) dirty.current = false
        if (opts?.title !== undefined) {
          const renamed = opts.title
          setDoc((prev) => (prev ? { ...prev, title: renamed } : prev))
          onTitleRef.current?.(renamed)
        }
        setSaveState({ kind: 'saved', at: Date.now() })
      } catch (err) {
        fail(null, err instanceof Error ? err.message : String(err))
      }
    })
  }, [rpc, onSaved, currentMd])

  /**
   * Switching views carries the text across and saves what is pending first:
   * a change typed a moment ago in one view must not be lost to the other
   * view's copy.
   */
  const switchMode = useCallback((next: EditorMode) => {
    if (next === mode || !editor) return
    autosaveRef.current?.cancel()
    const md = currentMd()
    if (id && loadedIdRef.current === id && shouldSaveOnModeSwitch(dirty.current, md, savedMd.current)) void save(id, md)
    if (next === 'markdown') setRaw(md)
    else editor.commands.setContent(mdToHtml(md, titles))
    modeRef.current = next
    setMode(next)
    writeEditorMode(next)
  }, [mode, editor, currentMd, id, save, setRaw, titles])

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
    if (!id || loadedIdRef.current !== id) return
    dirty.current = true
    if (deleteBlockRef.current === id) return
    autosaveRef.current?.schedule()
  }, [id, setRaw])

  /**
   * Renaming goes through the same `save` call as the body, because a title is
   * stored in the document's own front matter -- there is no separate rename.
   * It is sent on blur and on Enter rather than on every keystroke: a rename
   * writes a version, and one per letter would bury the real history.
   */
  const saveTitle = useCallback(() => {
    if (!id || loadedIdRef.current !== id) return
    const trimmed = title.trim()
    if (trimmed === '' || trimmed === doc?.title) { setTitle(doc?.title ?? ''); return }
    void save(id, null, { title: trimmed })
  }, [id, title, doc, save])

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
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save })
  useEffect(() => {
    if (!editor || !id) return
    const docId = id
    const autosave = createAutosave({
      delayMs: AUTOSAVE_MS,
      read: currentMd,
      saved: () => savedMd.current,
      save: (md) => { void saveRef.current(docId, md) },
    })
    autosaveRef.current = autosave
    mountedAutosaves.add(autosave)
    const onEdit = () => {
      if (loadedIdRef.current !== docId) return
      // Dirty even while a delete is out: if the delete fails, this is saved.
      dirty.current = true
      if (deleteBlockRef.current === docId) return
      autosave.schedule()
    }
    const onPageHide = () => autosave.flushPending()
    editor.on('update', onEdit)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      editor.off('update', onEdit)
      window.removeEventListener('pagehide', onPageHide)
      autosave.flushPending()
      mountedAutosaves.delete(autosave)
      if (autosaveRef.current === autosave) autosaveRef.current = null
    }
  }, [editor, id, currentMd])

  // Cmd+S / Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!id || loadedIdRef.current !== id || deleteBlockRef.current === id) return
        autosaveRef.current?.cancel()
        void save(id, currentMd())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, save, currentMd])

  /**
   * The trash button. While the delete is out, this doc takes no saves and the
   * button takes no second click. If the doc turns out not to be gone, saving
   * comes back on and the screen is brought back in line with what the server
   * confirmed meanwhile: a save that was out when the button was pressed
   * landed without touching the screen. Then any text that differs from the
   * saved text is scheduled, whether it was typed before the click or after.
   */
  const handleDelete = useCallback(async () => {
    if (!id || deleteBlockRef.current === id) return
    const docId = id
    deleteBlockRef.current = docId
    autosaveRef.current?.cancel()
    setDeletingId(docId)
    let gone = false
    try {
      gone = await onDelete()
    } catch {
      gone = false
    }
    setDeletingId((current) => (current === docId ? null : current))
    if (gone || deleteBlockRef.current !== docId) return
    deleteBlockRef.current = null
    if (openIdRef.current !== docId || loadedIdRef.current !== docId) return
    const known = confirmed.get(docId)
    if (known) {
      setVersion(known.version)
      if (!dirty.current) savedMd.current = known.content
    }
    setSaveState((state) => (state.kind === 'saving' ? { kind: 'idle' } : state))
    if (currentMd() !== savedMd.current) autosaveRef.current?.schedule()
  }, [id, onDelete, currentMd])

  if (!id) {
    return (
      <section className="docs-column docs-editor docs-editor-empty">
        <p className="docs-muted">Pick a doc from the tree on the left, or create a new one.</p>
      </section>
    )
  }

  /** A bar's buttons act only while its doc is the open one and has loaded. */
  const barIsLive = (docId: string) => docId === id && loadedIdRef.current === id

  const keepMine = () => {
    if (saveState.kind !== 'conflict' || !barIsLive(saveState.docId)) return
    const { mine, title: mineTitle, conflict, restored } = saveState
    if (restored) {
      // The editor shows the doc as loaded, not the kept text: put it there.
      autosaveRef.current?.cancel()
      setRaw(mine)
      editor?.commands.setContent(mdToHtml(mine, titles))
      dirty.current = true
      if (mineTitle !== undefined) setTitle(mineTitle)
    }
    void save(id, mine, { baseVersion: conflict.currentVersion, title: mineTitle })
  }

  /**
   * Every save for this doc queued before the click is void from here on, and
   * theirs is applied in the queue, after whatever is already out. The newest
   * text the server is known to hold wins over an older conflict's.
   */
  const keepTheirs = () => {
    if (saveState.kind !== 'conflict' || !barIsLive(saveState.docId)) return
    const { docId, conflict, title: refusedTitle } = saveState
    autosaveRef.current?.cancel()
    const generation = bumpGeneration(docId)
    const titleBefore = doc?.title ?? ''
    setSaveState({ kind: 'idle' })
    void saveQueue(docId, async () => {
      if (generationOf(docId) !== generation) return
      const known = confirmed.get(docId)
      const theirs = known && known.version > conflict.currentVersion
        ? known
        : { version: conflict.currentVersion, content: conflict.theirs ?? '' }
      confirmed.set(docId, theirs)
      if (openIdRef.current !== docId || loadedIdRef.current !== docId) return
      savedMd.current = theirs.content
      setRaw(theirs.content)
      setVersion(theirs.version)
      editor?.commands.setContent(mdToHtml(theirs.content, titles))
      dirty.current = false
      if (refusedTitle !== undefined) setTitle(titleBefore)
      setSaveState({ kind: 'idle' })
    })
  }

  const restoreUnsaved = () => {
    if (saveState.kind !== 'unsaved' || !barIsLive(saveState.docId)) return
    const { mine } = saveState
    setRaw(mine)
    editor?.commands.setContent(mdToHtml(mine, titles))
    dirty.current = true
    setSaveState({ kind: 'idle' })
    if (deleteBlockRef.current !== id) autosaveRef.current?.schedule()
  }

  const discardUnsaved = () => {
    if (saveState.kind !== 'unsaved' || !barIsLive(saveState.docId)) return
    setSaveState({ kind: 'idle' })
  }

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
