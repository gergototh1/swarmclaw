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
import { letrehozMentesSor, type Sorba } from './mentes-sor'
import { dontsUtkozesrol, valaszElavult } from './utkozes-dontes'

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
  /** Kéri a törlést; a visszaadott ígéret azt mondja meg, hogy a törlés meg is történt-e (ld. `torolj` lent). */
  onTorol: () => Promise<boolean>
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
  // Dokumentumonként sorba állítja a mentéseket, hogy egy adott doksira soha
  // ne legyen két mentés egyszerre úton -- lásd `mentes-sor.ts` fejlécét.
  // Ez teszi lehetővé, hogy `ment` a bázisverziót csak a várakozás UTÁN
  // olvassa ki (`verzioRef.current`-ből), amikorra az előző mentés válasza már
  // szinkronban beírta a magáét.
  const sorRef = useRef<Sorba>(letrehozMentesSor())

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
      .catch((err) => {
        if (elavult) return
        setBetoltesHiba(String(err?.message ?? err))
        // Egy sikertelen betöltés (törölt vagy nem létező id) nem hagyhatja
        // képernyőn az ELŐZŐ doksi szövegét és mentett-alapját -- a terv
        // szerint ilyenkor üres szerkesztő jár, a fa látszik. `onCim(null)`
        // nélkül a régi cím is a fejlécben maradna.
        setDoc(null)
        setCim('')
        savedMd.current = ''
        verzioRef.current = 0
        setVerzio(0)
        editor.commands.setContent('')
        onCim?.(null)
      })
    return () => { elavult = true }
    // `cimek` szándékosan nincs a listában: a címhalmaz változása nem ok a
    // szerkesztő tartalmának újratöltésére, az elvenné a kurzort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, editor, rpc, onCim])

  // `ment` explicit dokumentum-kötésű: az elsó paramétere melyik doksinak
  // szól, nem a komponens aktuális `id`-jét zárja magába. Ez azért fontos,
  // mert egy lebontáskori flush a RÉGI doksi id-jét kell hogy elküldje, akkor
  // is, ha `id` időközben már a másikra váltott -- a hívó (az autosave, a
  // Cmd+S és a cím-mentés is) mindig azt az id-t adja át, amelyikhez a mentés
  // ténylegesen tartozik.
  //
  // A harmadik, opcionális paraméter a cím: ha meg van adva, ez a hívás egy
  // átnevezés (ld. `mentCim` lent) -- ugyanazon az úton megy, mint a törzs
  // mentése, mert a cím a dokumentum saját front matterjében van tárolva,
  // nincs külön átnevező végpont. Ez azért fontos, mert az átnevezésnek
  // pontosan ugyanaz az ütközés- és elavultság-döntése kell, mint a törzs
  // mentésének: egy külön, e két szabályt meg nem kapó út volt az az elavult
  // hiba, amit ez a réteg korábban máshol már kijavított.
  //
  // A negyedik, opcionális paraméter EGYSZER kell: az ütközés-sáv "Az enyém
  // maradjon" gombja, ami a szerver által JELENTETT verzióra akar újrapróbálni
  // (nem arra, amit mi tartunk -- azt épp elavultnak láttuk). Enélkül az
  // argumentum nélkül `ment` a bázisverziót magától, `verzioRef.current`-ből
  // olvassa -- de csak AZUTÁN, hogy a lenti sor (`sorRef.current`) megvárta,
  // amíg ugyanerre a doksira szóló korábbi mentés lezárul. Ez a sorrend a
  // lényeg: mire ez a mentés ténylegesen elindul, az előző mentés válasza már
  // szinkronban beírta a saját verzióját, tehát amit itt olvasunk, mindig
  // friss -- nincs mit "önokozott ütközésként" kitalálni, mert két mentés
  // ugyanarra a doksira soha nincs egyszerre úton (ld. `mentes-sor.ts`).
  //
  // A válasz csak akkor kerül alkalmazásra -- beleértve a kezdő "mentés…"
  // állapotot is --, ha még ugyanaz a doksi van nyitva, mint amelyikre a
  // mentés elindult. Enélkül egy doksiváltás közben beérkező válasz (flush a
  // lebontáskor) a most nyitott másik doksi verzióját, mentett-alapját és
  // akár az ütközés-sávját is felülírná a régi doksi adataival.
  const ment = useCallback((docId: string, md: string, cim?: string, kikenyszeritettAlap?: number): Promise<void> => {
    const futas = (): Promise<void> => {
      const baseVersion = kikenyszeritettAlap ?? verzioRef.current
      if (nyitottIdRef.current === docId) setAllas({ kind: 'mentes' })
      return rpc('ment', { id: docId, tartalom: md, baseVersion, ...(cim !== undefined ? { cim } : {}) })
        .then((raw) => {
          // Ez a két őr az EGÉSZ válasz-kezelőre vonatkozik, ütközés és
          // siker ágra egyaránt, és ebben a sorrendben: az azonosság-ellenőrzés
          // (van-e még mire alkalmazni a választ) mindig előbb fut, mint
          // bármelyik verzió-összehasonlítás -- egy másik doksira váltás után
          // `verzioRef` már AZT a doksit tartja, és egy ütközés-válasz
          // `jelenlegiVerzio`-ja nem hasonlítható hozzá. A kuka-gomb tiltása
          // pedig ezután jön, DOKSI-AZONOSSÁGGAL (nem puszta jelzőbittel): egy
          // törlés alatt álló doksira sem verziót, sem mentett-alapot, sem
          // "mentve"/"ütközés" állapotot nem írunk, de ha a törlés kérése
          // meghiúsul, `torolj` (lent) ugyanerre az id-re feloldja a zárat, és
          // az ezt követő mentések már átjutnak ezen az őrön.
          if (nyitottIdRef.current !== docId) return
          if (torolveRef.current === docId) return
          if (isConflict(raw)) {
            const dontes = dontsUtkozesrol({ jelenlegiVerzio: raw.jelenlegiVerzio, jelenlegi: verzioRef.current })
            if (dontes === 'eldob') return
            setAllas({ kind: 'utkozes', utkozes: raw, sajat: md })
            return
          }
          const message = errorText(raw)
          if (message) { setAllas({ kind: 'hiba', uzenet: message }); return }
          const uj = (raw as { verzio?: number }).verzio
          // Egy doksiváltással vagy egy közvetlenül utána induló átnevezéssel
          // versenyző válasz verziója már nem újabb, mint amit egy közben
          // landolt válasz beállított -- ezt nem szabad alkalmazni, különben a
          // verzió és a mentett-alap visszaugrana, és a következő autosave
          // hamis ütközést váltana ki.
          if (valaszElavult({ uj, jelenlegi: verzioRef.current })) return
          if (typeof uj === 'number') { verzioRef.current = uj; setVerzio(uj) }
          savedMd.current = md
          if (cim !== undefined) {
            setDoc((elozo) => (elozo ? { ...elozo, cim } : elozo))
            onCim?.(cim)
          }
          setAllas({ kind: 'mentve', mikor: Date.now() })
          onMentve()
        })
        .catch((err) => {
          if (nyitottIdRef.current !== docId) return
          if (torolveRef.current === docId) return
          setAllas({ kind: 'hiba', uzenet: String(err?.message ?? err) })
        })
    }

    return sorRef.current(docId, futas)
  }, [rpc, onMentve, onCim])

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
  // újraindítaná az időzítőt, ha nem lenne ez a zár.
  //
  // A zár a DOKSI ID-JÉHEZ van kötve (nem egy puszta boolean), és két helyen
  // oldódik fel: a lenti autosave-effekt nyitja meg újra, amikor egy másik
  // doksira épül újra ([editor, id] függőség) -- de ha a törlés meghiúsul, a
  // doksi NYITVA MARAD (`onTorol` catch ága csak frissít, ld. `main.tsx`), és
  // az `id` nem változik, tehát az az effekt nem fut újra. Enélkül a zár örökre
  // fenn maradna: `onUpdate` sosem ütemezne új mentést, minden visszaérkező
  // mentés/átnevezés-válasz elakadna ennél az őrnél, és a felhasználó
  // gépelése soha nem menne el. Ezért `torolj` maga oldja fel a zárat, ha a
  // törlés nem sikerült -- csak akkor, és csak ugyanarra a doksira, amelyikre
  // felrakta (egy közben elindult, másik doksira szóló zárat nem törölhet le).
  const autosaveRef = useRef<Autosave | null>(null)
  const torolveRef = useRef<string | null>(null)
  // Melyik doksira fut épp egy törlés-kérés -- ez tiltja le a kuka-gombot.
  // Külön állapot `torolveRef`-től, mert az egy ref (nem vált ki renderelést);
  // ez pedig kifejezetten a gomb `disabled`-jéhez kell. A kettő mindig
  // szinkronban indul/oldódik.
  const [torlesFolyamatbanId, setTorlesFolyamatbanId] = useState<string | null>(null)
  const torolj = useCallback(() => {
    if (!id) return
    // Újrabelépés-védelem: két gyors kattintás ugyanarra a doksira csak egy
    // törlés-kérést indít. A `torolveRef` ellenőrzése szinkron, tehát ez akkor
    // is tart, ha a második kattintás a `torlesFolyamatbanId` állapot még be
    // nem érkezett újrarenderelése előtt érkezik.
    if (torolveRef.current === id) return
    const sajatId = id
    autosaveRef.current?.cancel()
    torolveRef.current = sajatId
    setTorlesFolyamatbanId(sajatId)
    onTorol().then((megtortent) => {
      if (!megtortent && torolveRef.current === sajatId) {
        torolveRef.current = null
        setTorlesFolyamatbanId((elozo) => (elozo === sajatId ? null : elozo))
      }
    })
  }, [id, onTorol])

  /**
   * Renaming goes through the exact same `ment` call as the body (its
   * optional third argument), because a title is stored in the document's own
   * front matter -- there is no separate rename -- and because a rename can
   * race an autosave for the same document exactly like two body saves can.
   * Routing it through `ment` means it shares `sorRef`'s per-document
   * serialization and the same success-staleness check, instead of repeating
   * a thinner copy of both that wasn't kept in sync. The base version is
   * `verzioRef.current`, read only once `ment`'s queued turn actually starts
   * -- see `ment`'s own comment for why that ordering is what makes the base
   * always fresh.
   *
   * It is sent on blur and on Enter rather than on every keystroke: a rename
   * writes a version, and one per letter would bury the real history.
   */
  const mentCim = useCallback(() => {
    if (!id) return
    const tiszta = cim.trim()
    if (tiszta === '' || tiszta === doc?.cim) { setCim(doc?.cim ?? ''); return }
    ment(id, savedMd.current, tiszta)
  }, [id, cim, doc, ment])

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
    // Egy másik (vagy ugyanerre a doksira korábban felrakott, de a törlés
    // sikere miatt már lezárult) zár nem élhet túl egy új doksira épülést --
    // ez az effekt csak akkor fut újra, ha `id` tényleg váltott, tehát ez a
    // pont sosem törli le egy ÉPP AKTÍV zárat ugyanerre a doksira.
    torolveRef.current = null
    const autosave = createAutosave({
      delayMs: AUTOSAVE_MS,
      read: () => htmlToMd(editor.getHTML()),
      saved: () => savedMd.current,
      // `sajatId` az effekt saját id-je, nem a ref: lebontáskor egy flush így
      // biztosan a doksihoz megy, amelyikhez az autosave tartozott, akkor is,
      // ha `id` (és `nyitottIdRef`) már a következő doksira váltott.
      save: (md) => { mentRef.current(sajatId, md) },
    })
    autosaveRef.current = autosave
    const onUpdate = () => { if (torolveRef.current !== sajatId) autosave.schedule() }
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
        if (editor && id) ment(id, htmlToMd(editor.getHTML()))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, id, ment])

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
            <button type="button" onClick={() => ment(id, allas.sajat, undefined, allas.utkozes.jelenlegiVerzio)}>
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
              disabled={torlesFolyamatbanId === id}
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
