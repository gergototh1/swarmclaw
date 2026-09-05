import { useCallback, useEffect, useState } from 'react'

import type { Backlink, Doc, Rpc, Verzio } from './api'
import { errorText, readBacklink, readDoc, readList, readVerzio } from './api'

/**
 * The right column: what this document is, what it used to say, and who points
 * at it.
 *
 * Each of the three loads independently and reports its own failure. A version
 * list that could not be read must not hide the backlinks, and neither should
 * take the metadata down with it -- three questions, three answers, three
 * states.
 */

/**
 * A loaded answer, tagged with the document it belongs to.
 *
 * Everything here is keyed by id and compared on render rather than cleared in
 * an effect. Clearing synchronously inside an effect is what triggers a
 * cascading render, and the state it clears is state the render can simply
 * decline to use.
 */
type Tolt<T> = { id: string; ertek: T | null; hiba: string | null }

export function Panel({ rpc, id, onValtozott }: { rpc: Rpc; id: string | null; onValtozott: () => void }) {
  const [docAllas, setDocAllas] = useState<Tolt<Doc> | null>(null)
  const [verzioAllas, setVerzioAllas] = useState<Tolt<Verzio[]> | null>(null)
  const [backlinkAllas, setBacklinkAllas] = useState<Tolt<Backlink[]> | null>(null)
  // A doksi id-je is benne van, hogy egy másik doksira váltás magától
  // érvénytelenítse -- effektbeli szinkron setState nélkül, ami render-láncot
  // indítana.
  const [elonezet, setElonezet] = useState<{ id: string; verzio: number; tartalom: string } | null>(null)
  const [muveletHiba, setMuveletHiba] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!id) return
    const felold = <T,>(
      method: string,
      olvas: (raw: unknown) => T,
      set: (next: Tolt<T>) => void,
    ) => {
      rpc(method, { id })
        .then((raw) => set({ id, ertek: olvas(raw), hiba: null }))
        .catch((err) => set({ id, ertek: null, hiba: String(err?.message ?? err) }))
    }
    felold('olvas', readDoc, setDocAllas)
    felold('verziok', (raw) => readList('verziok', 'verziok', raw, readVerzio), setVerzioAllas)
    felold('hivatkozok', (raw) => readList('hivatkozok', 'backlinkek', raw, readBacklink), setBacklinkAllas)
  }, [id, rpc])

  useEffect(() => { load() }, [load])

  // Egy másik doksira váltás után a régi válasz még itt van; nem töröljük,
  // csak nem használjuk.
  const mieink = <T,>(allas: Tolt<T> | null) => (allas && allas.id === id ? allas : null)
  const doc = mieink(docAllas)?.ertek ?? null
  const docHiba = mieink(docAllas)?.hiba ?? null
  const verziok = mieink(verzioAllas)?.ertek ?? null
  const verzioHiba = mieink(verzioAllas)?.hiba ?? null
  const backlinkek = mieink(backlinkAllas)?.ertek ?? null
  const backlinkHiba = mieink(backlinkAllas)?.hiba ?? null
  const latszik = elonezet && elonezet.id === id ? elonezet : null

  const visszaallit = (verzio: number) => {
    if (!id || !doc) return
    setMuveletHiba(null)
    rpc('visszaallitVerzio', { id, verzio, baseVersion: doc.verzio })
      .then((raw) => {
        const message = errorText(raw)
        if (message) { setMuveletHiba(message); return }
        setElonezet(null)
        load()
        onValtozott()
      })
      .catch((err) => setMuveletHiba(String(err?.message ?? err)))
  }

  if (!id) return <aside className="docs-oszlop docs-panel" />

  return (
    <aside className="docs-oszlop docs-panel">
      <section>
        <h3>Adatok</h3>
        {docHiba && <p className="docs-hiba" role="alert">{docHiba}</p>}
        {doc && (
          <dl className="docs-meta">
            <dt>Útvonal</dt><dd>{doc.utvonal}</dd>
            <dt>Tulajdonos</dt><dd>{doc.tulajdonos}</dd>
            <dt>Létrehozva</dt><dd>{doc.letrehozva.slice(0, 16).replace('T', ' ')}</dd>
            <dt>Módosítva</dt><dd>{doc.frissitve.slice(0, 16).replace('T', ' ')}</dd>
            <dt>Verzió</dt><dd>{doc.verzio}</dd>
            <dt>Címkék</dt><dd>{doc.tagek.length ? doc.tagek.join(', ') : '—'}</dd>
          </dl>
        )}
      </section>

      <section>
        <h3>Verziók</h3>
        {muveletHiba && <p className="docs-hiba" role="alert">{muveletHiba}</p>}
        {verzioHiba && <p className="docs-hiba" role="alert">{verzioHiba}</p>}
        {verziok?.length === 0 && <p className="docs-halvany">Még nincs korábbi verzió.</p>}
        <ul className="docs-verziok">
          {verziok?.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                onClick={() => {
                  if (latszik?.verzio === v.version) { setElonezet(null); return }
                  rpc('verzio', { id, verzio: v.version })
                    .then((raw) => {
                      const message = errorText(raw)
                      if (message) { setMuveletHiba(message); return }
                      setElonezet({ id, verzio: v.version, tartalom: String((raw as { content?: string }).content ?? '') })
                    })
                    .catch((err) => setMuveletHiba(String(err?.message ?? err)))
                }}
              >
                v{v.version} · {v.author || '—'} · {v.createdAt.slice(0, 16).replace('T', ' ')}
              </button>
              {doc && v.version !== doc.verzio && (
                <button type="button" className="docs-masodlagos" onClick={() => visszaallit(v.version)}>
                  Visszaállít
                </button>
              )}
              {latszik?.verzio === v.version && <pre className="docs-elonezet">{latszik.tartalom}</pre>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Ide hivatkozik</h3>
        {backlinkHiba && <p className="docs-hiba" role="alert">{backlinkHiba}</p>}
        {backlinkek?.length === 0 && <p className="docs-halvany">Erre a doksira még senki nem hivatkozik.</p>}
        <ul className="docs-backlinkek">
          {backlinkek?.map((b) => (
            <li key={b.fromId}>
              <strong>{b.title}</strong>
              <span className="docs-halvany">{b.path}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}
