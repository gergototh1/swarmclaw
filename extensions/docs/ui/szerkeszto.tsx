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
import { createAutosave, type Autosave } from './autosave'
import { dontsUjraprobalni } from './utkozes-dontes'

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
  | { kind: 'hiba'; uzenet: string }
  | { kind: 'utkozes'; utkozes: Utkozes; sajat: string }

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

export function Szerkeszto({ rpc, id, cimek, onMentve, panelNyitva, onPanelValt, onTorol, fokuszCim, onCimFokuszalva, onCim }: {
  rpc: Rpc
  id: string | null
  cimek: Set<string>
  onMentve: () => void
  panelNyitva: boolean
  onPanelValt: () => void
  onTorol: () => void
  fokuszCim: boolean
  onCimFokuszalva: () => void
  /** A nyitott doksi címe betöltéskor és átnevezés után; null, ha nincs nyitott doksi. */
  onCim?: (cim: string | null) => void
}) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [betoltesHiba, setBetoltesHiba] = useState<string | null>(null)
  const [allas, setAllas] = useState<Allas>({ kind: 'nyugalom' })
  const [verzio, setVerzio] = useState<number>(0)
  const savedMd = useRef<string>('')
  // A cím szerkeszthető, ezért saját mezőállapota van. A `doc.cim` a szerverről
  // jött érték; ez az, amit épp gépelnek.
  const [cim, setCim] = useState('')
  const cimMezo = useRef<HTMLInputElement | null>(null)

  // `ment`/`mentCim` mentése aszinkron: mire visszajön a válasz, lehet, hogy a
  // felhasználó már másik doksit nyitott meg. `verzioRef` a legfrissebb
  // verziót tartja (az autosave ebből olvas, ld. lent), `nyitottIdRef` pedig
  // azt, hogy melyik doksi van épp nyitva -- mindkettő szinkronban frissül a
  // lenti ref-sync effektben, hogy a visszaérkező válasz eldönthesse, van-e
  // még kire alkalmazni.
  const verzioRef = useRef(verzio)
  const nyitottIdRef = useRef<string | null>(id)
  // Hány `ment()` hívás van épp úton dokumentumonként. Egy saját korábbi
  // mentésünk lehet az oka egy ütközésnek (a debounce és egy flush/Cmd+S
  // versenyez ugyanarra a doksira) -- ez a térkép mondja meg `ment`-nek, hogy
  // ilyenkor volt-e már másik mentés folyamatban ugyanahhoz a doksihoz.
  const folyamatbanRef = useRef<Map<string, number>>(new Map())

  const editor = useEditor({
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content: '',
    editorProps: { attributes: { class: 'docs-proza', 'aria-label': 'A doksi szövege' } },
  })

  // Betöltés: a szerkesztő tartalmát csak akkor cseréljük, ha tényleg más
  // doksit nyitottunk — különben minden mentés visszaugrasztaná a kurzort.
  useEffect(() => {
    if (!id || !editor) { setDoc(null); onCim?.(null); return }
    let elavult = false
    setBetoltesHiba(null)
    rpc('olvas', { id })
      .then((raw) => {
        if (elavult) return
        const loaded = readDoc(raw)
        setDoc(loaded)
        setVerzio(loaded.verzio)
        verzioRef.current = loaded.verzio
        setCim(loaded.cim)
        savedMd.current = loaded.tartalom
        editor.commands.setContent(mdToHtml(loaded.tartalom, cimek))
        setAllas({ kind: 'nyugalom' })
        onCim?.(loaded.cim)
      })
      .catch((err) => { if (!elavult) setBetoltesHiba(String(err?.message ?? err)) })
    return () => { elavult = true }
    // `cimek` szándékosan nincs a listában: a címhalmaz változása nem ok a
    // szerkesztő tartalmának újratöltésére, az elvenné a kurzort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, editor, rpc, onCim])

  // `ment` explicit dokumentum-kötésű: az elsó paramétere melyik doksinak
  // szól, nem a komponens aktuális `id`-jét zárja magába. Ez azért fontos,
  // mert egy lebontáskori flush a RÉGI doksi id-jét kell hogy elküldje, akkor
  // is, ha `id` időközben már a másikra váltott -- a hívó (az autosave és a
  // Cmd+S) mindig azt az id-t adja át, amelyikhez a mentés ténylegesen
  // tartozik.
  //
  // A válasz csak akkor kerül alkalmazásra -- beleértve a kezdő "mentés…"
  // állapotot is --, ha még ugyanaz a doksi van nyitva, mint amelyikre a
  // mentés elindult. Enélkül egy doksiváltás közben beérkező válasz (flush a
  // lebontáskor) a most nyitott másik doksi verzióját, mentett-alapját és
  // akár az ütközés-sávját is felülírná a régi doksi adataival.
  //
  // ÖNOKOZOTT ÜTKÖZÉS. Egy debounce és egy flush/Cmd+S versenyezhet ugyanarra
  // a doksira: amíg az egyik mentés úton van, a másik is elindulhat a régi
  // verzióval. Ha a szerver ütközést jelez, és ekkor MÁR volt egy másik
  // mentés folyamatban ugyanehhez a doksihoz, az ütközés valószínűleg a saját
  // korábbi mentésünk, ami közben landolt -- ilyenkor egyszer, azonnal
  // újrapróbáljuk a szerver által jelzett verzióval. `folyamatbanRef` tartja
  // számon dokumentumonként a folyamatban lévő mentések számát, hogy a
  // döntés (`dontsUjraprobalni`) tudja, volt-e ilyen verseny -- egy retry
  // legfeljebb egyszer futhat le hívásonként, kör nem alakulhat ki.
  const ment = useCallback((docId: string, md: string, base: number): Promise<void> => {
    const terkep = folyamatbanRef.current
    const masikMentesFolyamatban = (terkep.get(docId) ?? 0) > 0
    terkep.set(docId, (terkep.get(docId) ?? 0) + 1)
    if (nyitottIdRef.current === docId) setAllas({ kind: 'mentes' })

    const probalkozas = (baseVersion: number, marUjraprobalt: boolean): Promise<void> =>
      rpc('ment', { id: docId, tartalom: md, baseVersion })
        .then((raw) => {
          if (isConflict(raw)) {
            if (dontsUjraprobalni({ masikMentesFolyamatban, marUjraprobalt })) {
              return probalkozas(raw.jelenlegiVerzio, true)
            }
            if (nyitottIdRef.current !== docId) return
            setAllas({ kind: 'utkozes', utkozes: raw, sajat: md })
            return
          }
          if (nyitottIdRef.current !== docId) return
          const message = errorText(raw)
          if (message) { setAllas({ kind: 'hiba', uzenet: message }); return }
          const uj = (raw as { verzio?: number }).verzio
          if (typeof uj === 'number') { verzioRef.current = uj; setVerzio(uj) }
          savedMd.current = md
          setAllas({ kind: 'mentve', mikor: Date.now() })
          onMentve()
        })
        .catch((err) => {
          if (nyitottIdRef.current !== docId) return
          setAllas({ kind: 'hiba', uzenet: String(err?.message ?? err) })
        })

    return probalkozas(base, false).finally(() => {
      const jelenlegi = terkep.get(docId) ?? 0
      if (jelenlegi <= 1) terkep.delete(docId)
      else terkep.set(docId, jelenlegi - 1)
    })
  }, [rpc, onMentve])

  // Az autosave a legfrissebb verziót és mentőt olvassa, de nem épül újra
  // tőlük: ha újraépülne, egy mentés visszaigazolása (új `verzio`) eldobná a
  // közben gépelt szöveg időzítőjét. Lebontáskor a ref még az előző doksi
  // értékeit tartja (a React minden cleanupot a következő setupok előtt
  // futtat), így a függő mentés a régi doksiba megy, ahová való -- és ugyanez
  // igaz `nyitottIdRef`-re is, ezért a fenti guard helyesen viselkedik a
  // lebontás alatt lefutó flush-nál is.
  const mentRef = useRef(ment)
  useEffect(() => {
    verzioRef.current = verzio
    mentRef.current = ment
    nyitottIdRef.current = id
  })
  // A nyitott doksi autosave-je, hogy a törlés eldobhassa a függő mentést:
  // egy kukába tett doksiba nem írunk utólag új verziót. `torolveRef` ennek a
  // másik fele: a cancel() csak az épp várakozó mentést dobja el, de a
  // szerkesztő a törlési kérés alatt is felkerül marad, és további gépelés
  // újraindítaná az időzítőt. A jelző ezt zárja le a törlés gombra kattintás
  // után; a lenti autosave-effekt nyitja meg újra, amikor egy másik doksira
  // épül újra ([editor, id] függőség).
  const autosaveRef = useRef<Autosave | null>(null)
  const torolveRef = useRef(false)
  const torolj = useCallback(() => {
    autosaveRef.current?.cancel()
    torolveRef.current = true
    onTorol()
  }, [onTorol])

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
    const sajatId = id
    setAllas({ kind: 'mentes' })
    rpc('ment', { id, tartalom: savedMd.current, cim: tiszta, baseVersion: verzio })
      .then((raw) => {
        if (nyitottIdRef.current !== sajatId) return
        if (isConflict(raw)) { setAllas({ kind: 'utkozes', utkozes: raw, sajat: savedMd.current }); return }
        const message = errorText(raw)
        if (message) { setAllas({ kind: 'hiba', uzenet: message }); return }
        const uj = (raw as { verzio?: number }).verzio
        if (typeof uj === 'number') { verzioRef.current = uj; setVerzio(uj) }
        setDoc((elozo) => (elozo ? { ...elozo, cim: tiszta } : elozo))
        setAllas({ kind: 'mentve', mikor: Date.now() })
        onCim?.(tiszta)
        onMentve()
      })
      .catch((err) => {
        if (nyitottIdRef.current !== sajatId) return
        setAllas({ kind: 'hiba', uzenet: String(err?.message ?? err) })
      })
  }, [id, cim, doc, rpc, verzio, onMentve, onCim])

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
  // szerver utoljára visszaigazolt. Doksiváltáskor, elnavigáláskor és a lap
  // elhagyásakor (`pagehide`) a függő mentés lefut, nem vész el.
  useEffect(() => {
    if (!editor || !id) return
    const sajatId = id
    torolveRef.current = false
    const autosave = createAutosave({
      delayMs: AUTOSAVE_MS,
      read: () => htmlToMd(editor.getHTML()),
      saved: () => savedMd.current,
      // `sajatId` az effekt saját id-je, nem a ref: lebontáskor egy flush így
      // biztosan a doksihoz megy, amelyikhez az autosave tartozott, akkor is,
      // ha `id` (és `nyitottIdRef`) már a következő doksira váltott.
      save: (md) => { mentRef.current(sajatId, md, verzioRef.current) },
    })
    autosaveRef.current = autosave
    const onUpdate = () => { if (!torolveRef.current) autosave.schedule() }
    const onPageHide = () => autosave.flushPending()
    editor.on('update', onUpdate)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      editor.off('update', onUpdate)
      window.removeEventListener('pagehide', onPageHide)
      autosave.flushPending()
      if (autosaveRef.current === autosave) autosaveRef.current = null
    }
  }, [editor, id])

  // Cmd+S / Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (editor && id) ment(id, htmlToMd(editor.getHTML()), verzio)
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

      {allas.kind === 'utkozes' && (
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
            <button type="button" onClick={() => ment(id, allas.sajat, allas.utkozes.jelenlegiVerzio)}>
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
              onClick={torolj}
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
        {allas.kind === 'hiba' && <span className="docs-hiba">{allas.uzenet}</span>}
      </header>

      <Eszkoztar editor={editor} />
      </div>

      <EditorContent editor={editor} className="docs-editor" />
    </section>
  )
}
