import { useEffect, useState } from 'react'

import type { Kiserletek, Rpc } from './api'
import { errorText, readKiserletek } from './api'
import { ajtoLabel, formatDate } from './format'

/**
 * The refused outbound attempts: when, through which door, with which code,
 * and what was asked for.
 *
 * THIS IS THE VIEW WHERE AN INJECTION IS VISIBLE. A newsletter sentence that
 * tried to address a letter gets no further than a row here with
 * `gmail_cimzett_cim_literal` on it, because the only route from a string to
 * an address is the form on the Recipients view. The `mit` column is what
 * somebody asked this module to do, cut to 2000 characters and stored
 * verbatim, and it is the one field on this page written by whoever was
 * trying.
 *
 * SO IT IS LABELLED AS SOMEBODY ELSE'S TEXT, ABOVE THE BOX, not styled to look
 * like it. The label sits outside the box and the box holds nothing but a text
 * child; there is no markup in it, no link out of it, and it is height-capped
 * and scrolls, so a 2000-character line cannot cover the row under it.
 *
 * IT IS ITS OWN REQUEST AND NOT PART OF `board`. This is the one view an
 * operator opens on purpose, and a board that carried a refusal log would
 * fetch one on every page load for everybody who never looks at it.
 *
 * A REFUSED `attempts` SHOWS ITS REFUSAL. An empty list here means "nothing
 * was refused", which is the good news; a request that failed means nobody
 * knows. The two are drawn as two, and the failure never as the empty list.
 */

/** The loaded state, split out so the test can render it without an effect. */
export function KiserletekTabla({ data }: { data: Kiserletek }) {
  if (data.items.length === 0) {
    return <p className="gm-muted">Nincs visszautasított kimenő kérés. Ha lenne, itt látszana, hogy melyik ajtón és milyen kóddal.</p>
  }
  return (
    <>
      <p className="gm-line gm-muted">A legutóbbi {data.items.length} visszautasított kérés, legújabb elöl. A lap egyszerre {data.limit} sort kér le.</p>
      {data.items.map((sor) => (
        <div key={sor.id} className="gm-kiserlet" data-kiserlet-id={sor.id}>
          <div className="gm-sor-fej">
            <span className="gm-badge gm-badge-bad">{sor.kod}</span>
            <span className="gm-muted">{formatDate(sor.at)}</span>
            <span className="gm-muted">{ajtoLabel(sor.ajto)}</span>
          </div>
          <p className="gm-szoveg-cimke gm-warn">Idegen szöveg: ezt a kérő írta, nem ez a modul. Szövegként jelenik meg, és semmi nem értelmezi.</p>
          <pre className="gm-szoveg">{sor.mit}</pre>
        </div>
      ))}
    </>
  )
}

export function KiserletekNezet({ rpc }: { rpc: Rpc }) {
  const [data, setData] = useState<Kiserletek | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    rpc('attempts')
      .then((raw) => { if (!stale) { setData(readKiserletek(raw)); setError(null) } })
      .catch((err: unknown) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [rpc])

  if (error !== null && data === null) {
    return <p className="gm-error" role="alert">A kísérleteket nem sikerült lekérdezni, tehát nem tudni, volt-e visszautasított kérés: {error}</p>
  }
  if (data === null) return <p className="gm-muted">Betöltés…</p>

  return (
    <div className="gm-kiserletek">
      {error !== null && <p className="gm-error" role="alert">A frissítés nem sikerült, a lenti lista a korábbi betöltésé: {error}</p>}
      <KiserletekTabla data={data} />
    </div>
  )
}
