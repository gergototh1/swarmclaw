import { useEffect, useMemo, useState } from 'react'

import type { DocRow, Fa, KukaElem, Rpc, Talalat } from './api'
import { errorText, readKukaElem, readList, readTalalat } from './api'

/**
 * The left column: a folder tree, a search box and the trash.
 *
 * The tree is derived from the document paths rather than stored, so it cannot
 * disagree with what is actually on disk. Folders that hold nothing still
 * appear, because `fa` returns them separately -- an empty folder the operator
 * just made would otherwise vanish until they put something in it.
 */

interface Node {
  nev: string
  ut: string
  mappak: Node[]
  doksik: DocRow[]
}

function buildTree(fa: Fa): Node {
  const root: Node = { nev: '', ut: '', mappak: [], doksik: [] }
  const find = (folder: string): Node => {
    if (folder === '') return root
    let node = root
    let sofar = ''
    for (const part of folder.split('/')) {
      sofar = sofar === '' ? part : `${sofar}/${part}`
      let next = node.mappak.find((m) => m.nev === part)
      if (!next) {
        next = { nev: part, ut: sofar, mappak: [], doksik: [] }
        node.mappak.push(next)
      }
      node = next
    }
    return node
  }
  for (const folder of fa.mappak) find(folder)
  for (const doc of fa.doksik) {
    const parts = doc.utvonal.split('/')
    parts.pop()
    find(parts.join('/')).doksik.push(doc)
  }
  const sort = (node: Node) => {
    node.mappak.sort((a, b) => a.nev.localeCompare(b.nev, 'hu'))
    node.doksik.sort((a, b) => a.cim.localeCompare(b.cim, 'hu'))
    node.mappak.forEach(sort)
  }
  sort(root)
  return root
}

function Mappa({ node, nyitva, setNyitva, aktivId, onOpen, onDrop, agentNev }: {
  node: Node
  nyitva: Set<string>
  setNyitva: (next: Set<string>) => void
  aktivId: string | null
  onOpen: (id: string) => void
  onDrop: (id: string, mappa: string) => void
  agentNev: (slug: string) => string | null
}) {
  const open = nyitva.has(node.ut)
  const toggle = () => {
    const next = new Set(nyitva)
    if (open) next.delete(node.ut)
    else next.add(node.ut)
    setNyitva(next)
  }
  const agent = node.ut.startsWith('agents/') && node.ut.split('/').length === 2
    ? agentNev(node.nev)
    : null

  return (
    <li className="docs-fa-mappa">
      <button
        type="button"
        className="docs-fa-mappanev"
        onClick={toggle}
        aria-expanded={open}
        onDragOver={(e) => { e.preventDefault() }}
        onDrop={(e) => { e.preventDefault(); onDrop(e.dataTransfer.getData('text/plain'), node.ut) }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {agent ? <span aria-hidden="true">🤖</span> : null}
        {agent ?? node.nev}
      </button>
      {open && (
        <ul className="docs-fa-lista">
          {node.mappak.map((m) => (
            <Mappa key={m.ut} node={m} nyitva={nyitva} setNyitva={setNyitva} aktivId={aktivId} onOpen={onOpen} onDrop={onDrop} agentNev={agentNev} />
          ))}
          {node.doksik.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', d.id)}
                className={`docs-fa-doksi${d.id === aktivId ? ' docs-aktiv' : ''}`}
                onClick={() => onOpen(d.id)}
              >
                {d.cim}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function FaOszlop({ rpc, fa, faHiba, aktivId, onOpen, onValtozott, agentNevek }: {
  rpc: Rpc
  fa: Fa | null
  faHiba: string | null
  aktivId: string | null
  onOpen: (id: string) => void
  onValtozott: () => void
  agentNevek: Map<string, string>
}) {
  const [q, setQ] = useState('')
  const [talalatok, setTalalatok] = useState<Talalat[] | null>(null)
  const [keresHiba, setKeresHiba] = useState<string | null>(null)
  const [kuka, setKuka] = useState<KukaElem[] | null>(null)
  const [kukaNyitva, setKukaNyitva] = useState(false)
  const [nyitva, setNyitva] = useState<Set<string>>(new Set(['agents']))
  const [muveletHiba, setMuveletHiba] = useState<string | null>(null)

  const tree = useMemo(() => (fa ? buildTree(fa) : null), [fa])

  // Az üres keresőmező nem állapot, hanem a mező tartalmából következik. Amíg
  // állapot volt, az effekt szinkron setState-et hívott, ami fölösleges
  // render-láncot indít minden billentyűleütésre.
  const keresAktiv = q.trim() !== ''

  useEffect(() => {
    if (!keresAktiv) return undefined
    const timer = setTimeout(() => {
      rpc('keres', { q })
        .then((raw) => { setTalalatok(readList('keres', 'talalatok', raw, readTalalat)); setKeresHiba(null) })
        .catch((err) => { setTalalatok(null); setKeresHiba(String(err?.message ?? err)) })
    }, 250)
    return () => clearTimeout(timer)
  }, [q, keresAktiv, rpc])

  const loadKuka = () => {
    rpc('kuka')
      .then((raw) => setKuka(readList('kuka', 'elemek', raw, readKukaElem)))
      .catch((err) => setMuveletHiba(String(err?.message ?? err)))
  }

  const muvelet = (method: string, body: object) => {
    setMuveletHiba(null)
    rpc(method, body)
      .then((raw) => {
        const message = errorText(raw)
        if (message) { setMuveletHiba(message); return }
        onValtozott()
        if (kukaNyitva) loadKuka()
      })
      .catch((err) => setMuveletHiba(String(err?.message ?? err)))
  }

  const ujDoksi = (mappa: string) => {
    const cim = window.prompt('Az új doksi címe:')
    if (!cim) return
    rpc('letrehoz', { mappa, cim })
      .then((raw) => {
        const message = errorText(raw)
        if (message) { setMuveletHiba(message); return }
        onValtozott()
        const id = (raw as { id?: string })?.id
        if (id) onOpen(id)
      })
      .catch((err) => setMuveletHiba(String(err?.message ?? err)))
  }

  const ujMappa = () => {
    const mappa = window.prompt('Az új mappa útvonala (pl. kozos/projektek):')
    if (!mappa) return
    muvelet('mappaLetrehoz', { mappa })
  }

  return (
    <aside className="docs-oszlop docs-fa">
      <div className="docs-fa-fejlec">
        <input
          type="search"
          value={q}
          placeholder="Keresés a doksikban…"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Keresés a doksikban"
        />
        <div className="docs-fa-gombok">
          <button type="button" onClick={() => ujDoksi(fa?.kozosMappaNev ?? 'kozos')}>+ Doksi</button>
          <button type="button" onClick={ujMappa}>+ Mappa</button>
        </div>
      </div>

      {muveletHiba && <p className="docs-hiba" role="alert">{muveletHiba}</p>}

      {keresAktiv ? (
        <div className="docs-talalatok">
          {keresHiba && <p className="docs-hiba" role="alert">{keresHiba}</p>}
          {talalatok !== null && talalatok.length === 0 && !keresHiba && <p className="docs-halvany">Nincs találat.</p>}
          {talalatok?.map((t) => (
            <button key={t.id} type="button" className="docs-talalat" onClick={() => onOpen(t.id)}>
              <strong>{t.title}</strong>
              <span className="docs-halvany">{t.path}</span>
              <span>{t.reszlet}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          {faHiba && <p className="docs-hiba" role="alert">{faHiba}</p>}
          {!fa && !faHiba && <p className="docs-halvany">Betöltés…</p>}
          {tree && (
            <ul className="docs-fa-lista docs-fa-gyoker">
              {tree.mappak.map((m) => (
                <Mappa
                  key={m.ut}
                  node={m}
                  nyitva={nyitva}
                  setNyitva={setNyitva}
                  aktivId={aktivId}
                  onOpen={onOpen}
                  onDrop={(id, mappa) => muvelet('mozgat', { id, ujMappa: mappa })}
                  agentNev={(slug) => agentNevek.get(slug) ?? slug}
                />
              ))}
              {tree.doksik.map((d) => (
                <li key={d.id}>
                  <button type="button" className={`docs-fa-doksi${d.id === aktivId ? ' docs-aktiv' : ''}`} onClick={() => onOpen(d.id)}>
                    {d.cim}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="docs-kuka">
        <button
          type="button"
          className="docs-fa-mappanev"
          aria-expanded={kukaNyitva}
          onClick={() => { const next = !kukaNyitva; setKukaNyitva(next); if (next) loadKuka() }}
        >
          <span aria-hidden="true">{kukaNyitva ? '▾' : '▸'}</span> Kuka
        </button>
        {kukaNyitva && (
          <ul className="docs-fa-lista">
            {kuka === null && <li className="docs-halvany">Betöltés…</li>}
            {kuka?.length === 0 && <li className="docs-halvany">A kuka üres.</li>}
            {kuka?.map((e) => (
              <li key={e.id} className="docs-kuka-elem">
                <span>{e.cim}</span>
                <button type="button" onClick={() => muvelet('visszaallit', { id: e.id })}>Vissza</button>
                <button
                  type="button"
                  className="docs-veszelyes"
                  onClick={() => muvelet('veglegesTorol', { id: e.id })}
                >
                  Végleg
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
