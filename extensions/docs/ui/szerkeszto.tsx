import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Doc, Rpc, Utkozes } from './api'
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

type Allas =
  | { kind: 'nyugalom' }
  | { kind: 'mentes' }
  | { kind: 'mentve'; mikor: number }
  | { kind: 'hiba'; message: string }
  | { kind: 'conflict'; utkozes: Utkozes; sajat: string }

function Eszkoztar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null
  const gomb = (cimke: string, aktiv: boolean, hat: () => void, leiras: string) => (
    <button
      type="button"
      className={aktiv ? 'docs-aktiv' : undefined}
      onClick={hat}
      aria-label={leiras}
      title={leiras}
    >
      {cimke}
    </button>
  )
  return (
    <div className="docs-eszkoztar" role="toolbar" aria-label="Formázás">
      {gomb('H1', editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), 'Címsor 1')}
      {gomb('H2', editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'Címsor 2')}
      {gomb('H3', editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'Címsor 3')}
      {gomb('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Félkövér')}
      {gomb('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'Dőlt')}
      {gomb('• lista', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), 'Felsorolás')}
      {gomb('1. lista', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), 'Számozott lista')}
      {gomb('” idézet', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), 'Idézet')}
      {gomb('kód', editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run(), 'Kódblokk')}
      {gomb('táblázat', false, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), 'Táblázat beszúrása')}
      {gomb('—', false, () => editor.chain().focus().setHorizontalRule().run(), 'Elválasztó')}
    </div>
  )
}

export function Szerkeszto({ rpc, id, cimek, onMentve, panelNyitva, onPanelValt, onTorol, fokuszCim, onCimFokuszalva }: {
  rpc: Rpc
  id: string | null
  cimek: Set<string>
  onMentve: () => void
  panelNyitva: boolean
  onPanelValt: () => void
  onTorol: () => void
  fokuszCim: boolean
  onCimFokuszalva: () => void
}) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [betoltesHiba, setBetoltesHiba] = useState<string | null>(null)
  const [allas, setAllas] = useState<Allas>({ kind: 'nyugalom' })
  const [verzio, setVerzio] = useState<number>(0)
  const savedMd = useRef<string>('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A cím szerkeszthető, ezért saját mezőállapota van. A `doc.cim` a szerverről
  // jött érték; ez az, amit épp gépelnek.
  const [cim, setCim] = useState('')
  const cimMezo = useRef<HTMLInputElement | null>(null)

  const editor = useEditor({
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content: '',
    editorProps: { attributes: { class: 'docs-proza', 'aria-label': 'A doksi szövege' } },
  })

  // Betöltés: a szerkesztő tartalmát csak akkor cseréljük, ha tényleg más
  // doksit nyitottunk — különben minden mentés visszaugrasztaná a kurzort.
  useEffect(() => {
    if (!id || !editor) { setDoc(null); return }
    let elavult = false
    setBetoltesHiba(null)
    rpc('olvas', { id })
      .then((raw) => {
        if (elavult) return
        const loaded = readDoc(raw)
        setDoc(loaded)
        setVerzio(loaded.verzio)
        setCim(loaded.cim)
        savedMd.current = loaded.tartalom
        editor.commands.setContent(mdToHtml(loaded.tartalom, cimek))
        setAllas({ kind: 'nyugalom' })
      })
      .catch((err) => { if (!elavult) setBetoltesHiba(String(err?.message ?? err)) })
    return () => { elavult = true }
    // `cimek` szándékosan nincs a listában: a címhalmaz változása nem ok a
    // szerkesztő tartalmának újratöltésére, az elvenné a kurzort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, editor, rpc])

  const ment = useCallback((md: string, base: number) => {
    if (!id) return
    setAllas({ kind: 'mentes' })
    rpc('ment', { id, tartalom: md, baseVersion: base })
      .then((raw) => {
        if (isConflict(raw)) { setAllas({ kind: 'conflict', utkozes: raw, sajat: md }); return }
        const message = errorText(raw)
        if (message) { setAllas({ kind: 'hiba', message }); return }
        const uj = (raw as { verzio?: number }).verzio
        if (typeof uj === 'number') setVerzio(uj)
        savedMd.current = md
        setAllas({ kind: 'mentve', mikor: Date.now() })
        onMentve()
      })
      .catch((err) => setAllas({ kind: 'hiba', message: String(err?.message ?? err) }))
  }, [id, rpc, onMentve])

  /**
   * Renaming goes through the same `ment` call as the body, because a title is
   * stored in the document's own front matter -- there is no separate rename.
   * It is sent on blur and on Enter rather than on every keystroke: a rename
   * writes a version, and one per letter would bury the real history.
   */
  const mentCim = useCallback(() => {
    if (!id) return
    const tiszta = cim.trim()
    if (tiszta === '' || tiszta === doc?.cim) { setCim(doc?.cim ?? ''); return }
    setAllas({ kind: 'mentes' })
    rpc('ment', { id, tartalom: savedMd.current, cim: tiszta, baseVersion: verzio })
      .then((raw) => {
        if (isConflict(raw)) { setAllas({ kind: 'conflict', utkozes: raw, sajat: savedMd.current }); return }
        const message = errorText(raw)
        if (message) { setAllas({ kind: 'hiba', message }); return }
        const uj = (raw as { verzio?: number }).verzio
        if (typeof uj === 'number') setVerzio(uj)
        setDoc((elozo) => (elozo ? { ...elozo, cim: tiszta } : elozo))
        setAllas({ kind: 'mentve', mikor: Date.now() })
        onMentve()
      })
      .catch((err) => setAllas({ kind: 'hiba', message: String(err?.message ?? err) }))
  }, [id, cim, doc, rpc, verzio, onMentve])

  // Egy frissen létrehozott doksi címe a helykitöltő; a kurzor odamegy, és a
  // szöveg ki van jelölve, hogy gépelni lehessen rá.
  useEffect(() => {
    if (!fokuszCim || !doc) return
    const mezo = cimMezo.current
    if (!mezo) return
    mezo.focus()
    mezo.select()
    onCimFokuszalva()
  }, [fokuszCim, doc, onCimFokuszalva])

  // Automatikus mentés: csak akkor, ha a markdown tényleg más, mint amit a
  // szerver utoljára visszaigazolt.
  useEffect(() => {
    if (!editor || !id) return
    const handler = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const md = htmlToMd(editor.getHTML())
        if (md === savedMd.current) return
        ment(md, verzio)
      }, AUTOSAVE_MS)
    }
    editor.on('update', handler)
    return () => { editor.off('update', handler); if (timer.current) clearTimeout(timer.current) }
  }, [editor, id, verzio, ment])

  // Cmd+S / Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (editor && id) ment(htmlToMd(editor.getHTML()), verzio)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, id, verzio, ment])

  if (!id) {
    return (
      <section className="docs-oszlop docs-szerkeszto docs-szerkeszto-ures">
        <p className="docs-halvany">Válassz egy doksit a bal oldali fából, vagy hozz létre újat.</p>
      </section>
    )
  }

  return (
    <section className="docs-oszlop docs-szerkeszto">
      {betoltesHiba && <p className="docs-hiba" role="alert">{betoltesHiba}</p>}

      {allas.kind === 'conflict' && (
        <div className="docs-utkozes" role="alert">
          <p>
            <strong>Ezt a doksit közben módosította: {allas.utkozes.modositotta ?? 'valaki más'}.</strong>{' '}
            A te szerkesztésed nincs elmentve.
          </p>
          <details>
            <summary>Megnézem a különbséget</summary>
            <div className="docs-diff">
              <div>
                <h4>Az övék (v{allas.utkozes.jelenlegiVerzio})</h4>
                <pre>{allas.utkozes.ovek ?? '(nem elérhető)'}</pre>
              </div>
              <div>
                <h4>A tiéd</h4>
                <pre>{allas.sajat}</pre>
              </div>
            </div>
          </details>
          <div className="docs-utkozes-gombok">
            <button type="button" onClick={() => ment(allas.sajat, allas.utkozes.jelenlegiVerzio)}>
              Az enyém maradjon
            </button>
            <button
              type="button"
              onClick={() => {
                const ovek = allas.utkozes.ovek ?? ''
                savedMd.current = ovek
                setVerzio(allas.utkozes.jelenlegiVerzio)
                editor?.commands.setContent(mdToHtml(ovek, cimek))
                setAllas({ kind: 'nyugalom' })
              }}
            >
              Az övék maradjon
            </button>
          </div>
        </div>
      )}

      <div className="docs-szerkeszto-teteje">
      <header className="docs-szerkeszto-fejlec">
        <div className="docs-szerkeszto-cim">
          <input
            ref={cimMezo}
            className="docs-cim"
            value={cim}
            placeholder="A doksi címe"
            aria-label="A doksi címe"
            onChange={(e) => setCim(e.target.value)}
            onBlur={mentCim}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
              if (e.key === 'Escape') { setCim(doc?.cim ?? ''); e.currentTarget.blur() }
            }}
          />
          <div className="docs-fejgombok">
            <button
              type="button"
              className={`docs-panelvalt${panelNyitva ? ' docs-aktiv' : ''}`}
              aria-pressed={panelNyitva}
              onClick={onPanelValt}
            >
              Adatok
            </button>
            <button
              type="button"
              className="docs-torol"
              aria-label="A doksi a kukába"
              title="A kukába"
              onClick={onTorol}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6M10 11v6M14 11v6" />
              </svg>
            </button>
          </div>
        </div>
        <span className="docs-halvany">
          {doc?.utvonal} · v{verzio}
          {allas.kind === 'mentes' && ' · mentés…'}
          {allas.kind === 'mentve' && ' · mentve'}
        </span>
        {allas.kind === 'hiba' && <span className="docs-hiba">{allas.message}</span>}
      </header>

      <Eszkoztar editor={editor} />
      </div>

      <EditorContent editor={editor} className="docs-editor" />
    </section>
  )
}
