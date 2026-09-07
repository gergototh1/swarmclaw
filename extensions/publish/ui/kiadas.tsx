import { useCallback, useEffect, useState } from 'react'

import type { AgReszlet, KiadasReszlet, Rpc, Talalat } from './api'
import { errText, readKiadas, refusalText } from './api'
import { KIADAS_CIMKE, PLATFORM_CIMKE } from './naptar'
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
 * PER-BRANCH `allapot` AND `url` ARE TWO DIFFERENT FACTS, DRAWN SEPARATELY:
 * a branch can be `kesz` with no readable url (an adapter that did not
 * return one) and the reverse never happens the other way -- `AgSor` below
 * never infers one from the other.
 */

const AG_CIMKE: Record<string, string> = {
  var: 'vár',
  kesz: 'kiment',
  hiba: 'elbukott',
  nincs_fiok: 'nincs fiók',
}

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
            <p className="pub-ag-cim">{ag.szoveg.cim}</p>
            <p className="pub-ag-leiras">{ag.szoveg.leiras}</p>
          </div>
        )
        : <p className="pub-halvany">Ehhez a platformhoz még nincs megírt szöveg.</p>}
      {ag.url !== null && (
        href !== null
          ? <p><a className="pub-link" href={href} target="_blank" rel="noopener noreferrer">{ag.url}</a></p>
          : <p className="pub-halvany">A tárolt url nem http(s), ezért nincs megnyitható link: {ag.url}</p>
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

export function KiadasBody({ reszlet, hiba, uzenet, kuldes, onJovahagy, onBack, onFrissit }: {
  reszlet: KiadasReszlet | null
  hiba: string | null
  uzenet: string | null
  kuldes: boolean
  onJovahagy: () => void
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
  const jovahagyhato = reszlet.allapot === 'lektoralt'

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

      <div className="pub-jovahagyas">
        <button type="button" disabled={!jovahagyhato || kuldes} onClick={onJovahagy}>Jóváhagyás</button>
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

  return <KiadasBody reszlet={reszlet} hiba={hiba} uzenet={uzenet} kuldes={kuldes} onJovahagy={onJovahagy} onBack={onBack} onFrissit={tolt} />
}
