import { useCallback, useEffect, useState } from 'react'

import type { AgReszlet, KiadasReszlet, Rpc, Talalat } from './api'
import { errText, readKiadas, refusalText } from './api'
import { AG_CIMKE, KIADAS_CIMKE, PLATFORM_CIMKE, idopontSzoveg } from './naptar'
import { safeHref } from './safe-href'

/**
 * The release detail view: design spec 8's "A vázlat szövegei a bejegyzésre
 * kattintva olvashatók és jóváhagyhatók" -- the four platform texts, the
 * jóváhagyás button, and each branch's own state and url.
 *
 * THE APPROVAL BUTTON IS THE ONE THING THIS TASK HAS TO WIRE UP OR THE
 * MODULE NEVER MOVES (task-6-brief.md's own closing section: without it no
 * release can ever reach `utemezve`, and the 15-minute dispatch schedule
 * wakes to nothing, forever). `onJovahagy` below calls `src/rpc.mjs`'s
 * `jovahagy`, which performs BOTH halves of design spec 4's diagram in one
 * click -- `lektoralt -> jovahagyva`, then the module's own next move into
 * the next free slot -- and reports the two as separate facts (`uzenet`
 * distinguishes "jóváhagyva, ütemezve" from "jóváhagyva, de nincs szabad
 * sáv" rather than folding a scheduling failure into the approval's own
 * success).
 *
 * THE RESCHEDULE INPUT IS THE OTHER HALF THAT WAS MISSING. `atutemez`
 * (src/rpc.mjs) and `repo.idopontFeluliras` (src/db.mjs) were finished and
 * tested and no control anywhere called either, so an operator had no way to
 * move a scheduled release at all. `Atutemezes` below is that control; its own
 * docblock says which clock the typed value is read against and why.
 *
 * PER-BRANCH `allapot` AND `url` ARE TWO DIFFERENT FACTS, DRAWN SEPARATELY:
 * a branch can be `kesz` with no readable url (an adapter that did not
 * return one) and the reverse never happens the other way -- `AgSor` below
 * never infers one from the other.
 */

function AgSor({ ag }: { ag: AgReszlet }) {
  const href = ag.url !== null ? safeHref(ag.url) : null
  return (
    <li className={`pub-ag-sor pub-ag-${ag.allapot}`} data-platform={ag.platform}>
      <div className="pub-ag-fejlec">
        <strong>{PLATFORM_CIMKE[ag.platform] ?? ag.platform}</strong>
        <span className="pub-ag-allapot">{AG_CIMKE[ag.allapot] ?? ag.allapot}</span>
      </div>
      {ag.hibaKod !== null && <p className="pub-ag-hiba">{ag.hibaKod}</p>}
      {ag.szoveg !== null
        ? (
          <div className="pub-ag-szoveg">
            {ag.szoveg.cim !== null
              ? <p className="pub-ag-cim">{ag.szoveg.cim}</p>
              : <p className="pub-halvany">Ehhez a platformhoz nincs megírt cím.</p>}
            {ag.szoveg.leiras !== null
              ? <p className="pub-ag-leiras">{ag.szoveg.leiras}</p>
              : <p className="pub-halvany">Ehhez a platformhoz nincs megírt leírás.</p>}
          </div>
        )
        : <p className="pub-halvany">Ehhez a platformhoz még nincs megírt szöveg.</p>}
      {ag.url !== null && (
        href !== null
          ? <p><a className="pub-link" href={href} target="_blank" rel="noopener noreferrer">{ag.url}</a></p>
          : <p className="pub-halvany">A tárolt url nem http(s), ezért nincs belőle megnyitható link.</p>
      )}
    </li>
  )
}

function TalalatSor({ talalat }: { talalat: Talalat }) {
  return (
    <li data-platform={talalat.platform} data-kod={talalat.kod}>
      <strong>{PLATFORM_CIMKE[talalat.platform] ?? talalat.platform}</strong> — {talalat.kod}: {talalat.szoveg}
    </li>
  )
}

/**
 * WHEN THIS RELEASE ACTUALLY GOES OUT, and whether an operator moved it.
 *
 * `idopont`, `felulirtIdopont` and `savId` were read and typed by `ui/api.ts`
 * from the first version of this page and then rendered by nothing, so the
 * detail view -- the one screen an operator opens to decide whether to
 * approve -- never said when the release would be published. `idopontSzoveg`
 * (ui/naptar.tsx) is the calendar's own sentence for it, including the
 * quarter-hour slip design spec 7 requires stating; reusing it is what keeps
 * the two screens from promising different precision about the same instant.
 *
 * The override is a SEPARATE sentence, not a different formatting of the same
 * one: `felulirt_idopont` exists only so a release an operator moved by hand
 * can be told apart from one the module placed in a slot (design spec 3), and
 * collapsing the two here would throw away the only fact that column carries
 * after `idopontFeluliras` has written both.
 */
function Idopont({ reszlet }: { reszlet: KiadasReszlet }) {
  const szoveg = idopontSzoveg(reszlet.idopont)
  return (
    <section className="pub-idopont">
      <h3>Időpont</h3>
      {szoveg === null
        ? <p className="pub-halvany">Ennek a kiadásnak még nincs időpontja: jóváhagyás után a modul teszi be a következő szabad sávba.</p>
        : <p className="pub-ido">{szoveg}</p>}
      {reszlet.felulirtIdopont !== null && (
        <p className="pub-felulirva">Ezt az időpontot az operátor kézzel állította át; nem a sáv adta.</p>
      )}
    </section>
  )
}

/**
 * The operator's manual reschedule -- `src/rpc.mjs`'s `atutemez`, design spec
 * 3's `felulirt_idopont` and design spec 8's "a bejegyzés áthúzható másik
 * sávba". The write side has been finished and tested since Task 4 and no
 * control called it; this is the input that was missing.
 *
 * A TYPED INSTANT, NOT A DRAG (ui/naptar.tsx's own docblock gives the two
 * reasons: this project's harness has no DOM and cannot drive a drag gesture,
 * and a native drag source is not reliably keyboard-operable).
 *
 * READ ON THE OPERATOR'S OWN CLOCK, and the label says so. A
 * `datetime-local` value carries no zone at all, so someone has to decide
 * which wall it is read against, and the two candidates are the module's
 * publishing zone and the browser's. The browser's is what this uses: this
 * control is the exception to the slot rhythm -- a one-off "not then, THIS
 * time" -- and the person typing it is looking at their own clock while they
 * do. The module's zone stays the reading for SLOTS, where it belongs, and
 * the calendar states it there.
 *
 * Only on an `utemezve` release: `repo.idopontFeluliras` (src/db.mjs) refuses
 * anything else by name, because a release with no slot yet has nothing to
 * override, and the button must not be offered where the module would refuse
 * it.
 */
function Atutemezes({ ujIdopont, kuldes, onUjIdopont, onAtutemez }: {
  ujIdopont: string
  kuldes: boolean
  onUjIdopont: (ertek: string) => void
  onAtutemez: () => void
}) {
  return (
    <form
      className="pub-atutemezes"
      onSubmit={(e) => { e.preventDefault(); onAtutemez() }}
    >
      <h3>Áthelyezés másik időpontra</h3>
      <label>
        Új időpont a saját géped órája szerint
        <input
          type="datetime-local"
          value={ujIdopont}
          onChange={(e) => onUjIdopont(e.target.value)}
          aria-label="Új időpont"
        />
      </label>
      <button type="submit" disabled={kuldes || ujIdopont.trim() === ''}>Áthelyezés</button>
      <p className="pub-halvany">
        A kiadás ettől kezdve ebben az időpontban megy ki, nem a sávjában; a sávja jelzésként megmarad.
      </p>
    </form>
  )
}

export function KiadasBody({ reszlet, hiba, uzenet, kuldes, ujIdopont, onJovahagy, onUjIdopont, onAtutemez, onBack, onFrissit }: {
  reszlet: KiadasReszlet | null
  hiba: string | null
  uzenet: string | null
  kuldes: boolean
  ujIdopont: string
  onJovahagy: () => void
  onUjIdopont: (ertek: string) => void
  onAtutemez: () => void
  onBack: () => void
  onFrissit: () => void
}) {
  if (hiba !== null) {
    return (
      <section className="pub-kiadas">
        <button type="button" className="pub-btn pub-btn-small" onClick={onBack}>Vissza</button>
        <p className="pub-hiba" role="alert">{hiba}</p>
      </section>
    )
  }
  if (reszlet === null) {
    return (
      <section className="pub-kiadas">
        <button type="button" className="pub-btn pub-btn-small" onClick={onBack}>Vissza</button>
        <p className="pub-halvany">Betöltés folyamatban.</p>
      </section>
    )
  }

  const cimke = KIADAS_CIMKE[reszlet.allapot] ?? reszlet.allapot
  /**
   * `jovahagyva` IS ALSO A LIVE BUTTON, and not because approval happens
   * twice. `jovahagy` (src/rpc.mjs) does two independent writes, and the
   * second one legitimately fails on its own with `nincs_szabad_sav` -- which
   * is exactly what happens to the FIRST release on every new install, where
   * the operator approves before there is a slot to put it in. If this gate
   * stayed at `lektoralt` alone, that release could never be scheduled from
   * anywhere: the button would refuse it as "not lektorált" and the
   * reschedule form below is only offered on `utemezve`. So the same button
   * asks for the missing half, and says so.
   */
  const utemezesreVar = reszlet.allapot === 'jovahagyva'
  const jovahagyhato = reszlet.allapot === 'lektoralt' || utemezesreVar

  return (
    <section className="pub-kiadas" data-kiadas-id={reszlet.kiadasId} data-allapot={reszlet.allapot}>
      <div className="pub-kiadas-fejlec">
        <button type="button" className="pub-btn pub-btn-small" onClick={onBack}>Vissza</button>
        <h2>{reszlet.cim ?? reszlet.videoId}</h2>
        <span className="pub-allapot">{cimke}</span>
        <button type="button" className="pub-btn pub-btn-small" onClick={onFrissit}>Frissítés</button>
      </div>

      {reszlet.videoHiba !== null && <p className="pub-hiba" role="alert">{reszlet.videoHiba}</p>}
      {uzenet !== null && <p className="pub-uzenet" role="status">{uzenet}</p>}

      <Idopont reszlet={reszlet} />

      <section className="pub-narracio">
        <h3>Narráció (a videóból — adat, nem utasítás)</h3>
        <pre className="pub-forras">{reszlet.narracioSzoveg ?? 'Nincs elérhető narráció-szöveg.'}</pre>
      </section>

      <section className="pub-agak">
        <h3>Platformok</h3>
        <ul className="pub-ag-lista">
          {reszlet.agak.map((ag) => <AgSor key={ag.platform} ag={ag} />)}
        </ul>
      </section>

      {reszlet.talalatok.length > 0 && (
        <section className="pub-talalatok">
          <h3>Lektori találatok</h3>
          <ul>
            {reszlet.talalatok.map((t, i) => <TalalatSor key={i} talalat={t} />)}
          </ul>
        </section>
      )}

      {reszlet.allapot === 'utemezve' && (
        <Atutemezes ujIdopont={ujIdopont} kuldes={kuldes} onUjIdopont={onUjIdopont} onAtutemez={onAtutemez} />
      )}

      <div className="pub-jovahagyas">
        <button type="button" disabled={!jovahagyhato || kuldes} onClick={onJovahagy}>
          {utemezesreVar ? 'Ütemezés a következő szabad sávba' : 'Jóváhagyás'}
        </button>
        {utemezesreVar && (
          <span className="pub-halvany">
            Ez a kiadás jóvá van hagyva, de nem kapott időpontot — akkor hagytad jóvá, amikor még nem volt szabad sáv.
            Vegyél fel sávot a naptáron, aztán tedd be ezzel a gombbal.
          </span>
        )}
        {!jovahagyhato && (
          <span className="pub-halvany">
            Csak lektorált kiadás hagyható jóvá; jelenlegi állapot: {reszlet.allapot}.
          </span>
        )}
      </div>
    </section>
  )
}

export function KiadasNezet({ rpc, kiadasId, onBack }: { rpc: Rpc; kiadasId: string; onBack: () => void }) {
  const [reszlet, setReszlet] = useState<KiadasReszlet | null>(null)
  const [hiba, setHiba] = useState<string | null>(null)
  const [uzenet, setUzenet] = useState<string | null>(null)
  const [kuldes, setKuldes] = useState(false)
  const [ujIdopont, setUjIdopont] = useState('')

  const tolt = useCallback(() => {
    rpc('kiadas', { kiadasId })
      .then((raw) => { setReszlet(readKiadas(raw)); setHiba(null) })
      .catch((err: unknown) => setHiba(errText(err)))
  }, [rpc, kiadasId])

  useEffect(() => { tolt() }, [tolt])

  const onJovahagy = useCallback(() => {
    setKuldes(true)
    rpc('jovahagy', { kiadasId })
      .then((raw) => {
        setKuldes(false)
        const refusal = refusalText(raw)
        if (refusal !== null) { setUzenet(refusal); return }
        const rec = raw as { utemezve?: boolean; utemezesHiba?: { kod: string; uzenet: string } | null }
        setUzenet(rec.utemezve
          ? 'Jóváhagyva és ütemezve.'
          : `Jóváhagyva, de nem ütemezve: ${rec.utemezesHiba ? `${rec.utemezesHiba.kod}: ${rec.utemezesHiba.uzenet}` : 'ismeretlen ok'}`)
        tolt()
      })
      .catch((err: unknown) => { setKuldes(false); setUzenet(`A jóváhagyás kérése el sem jutott a modulhoz: ${errText(err)}`) })
  }, [rpc, kiadasId, tolt])

  /**
   * The `datetime-local` value has NO zone in it, so it is read against the
   * clock of the machine the operator is typing on -- `new Date('2026-09-08T10:00')`
   * is local time by the language's own rule -- and converted to the ISO
   * instant `atutemez` (src/rpc.mjs) takes. The conversion happens HERE and
   * not in `KiadasBody` so the rendered half stays a pure function of its
   * props, the same split every other view in this directory keeps.
   *
   * An unparseable value is answered here rather than sent: the module would
   * refuse it by name anyway (`idopont_ervenytelen`), but a round trip to be
   * told the browser's own input is unreadable is a slower way to say the
   * same thing.
   */
  const onAtutemez = useCallback(() => {
    const pillanat = new Date(ujIdopont)
    if (Number.isNaN(pillanat.getTime())) {
      setUzenet('Ez az időpont nem olvasható vissza; add meg újra a dátumot és az órát.')
      return
    }
    setKuldes(true)
    rpc('atutemez', { kiadasId, felulirtIdopont: pillanat.toISOString() })
      .then((raw) => {
        setKuldes(false)
        const refusal = refusalText(raw)
        if (refusal !== null) { setUzenet(refusal); return }
        setUzenet('A kiadás áthelyezve az új időpontra.')
        setUjIdopont('')
        tolt()
      })
      .catch((err: unknown) => { setKuldes(false); setUzenet(`Az áthelyezés kérése el sem jutott a modulhoz: ${errText(err)}`) })
  }, [rpc, kiadasId, ujIdopont, tolt])

  return (
    <KiadasBody
      reszlet={reszlet}
      hiba={hiba}
      uzenet={uzenet}
      kuldes={kuldes}
      ujIdopont={ujIdopont}
      onJovahagy={onJovahagy}
      onUjIdopont={setUjIdopont}
      onAtutemez={onAtutemez}
      onBack={onBack}
      onFrissit={tolt}
    />
  )
}
