import { useCallback, useEffect, useState } from 'react'

import type { Decision, ListStatus, Rpc } from './api'
import { errorText, readDecideResult } from './api'
import type { DecideFn } from './deck-state'
import { cappedNote, formatDate, formatScore, statusBadge } from './format'
import { loadList, type ListState } from './list-state'
import { safeHref } from './safe-href'

const CHIPS: ReadonlyArray<{ key: ListStatus; label: string }> = [
  { key: 'all', label: 'Mind' },
  { key: 'saved', label: 'Mentett' },
  { key: 'archived', label: 'Archivált' },
  { key: 'new', label: 'Eldöntetlen' },
]

/**
 * The searchable list: four status chips, a search box, and the three
 * decisions on every row.
 *
 * `limit` is the cap `board.allLimit` reports rather than a number of this
 * file's own, and when `total` says more rows match than were returned the
 * list says so under the rows. A query the rpc layer refused is shown as its
 * message, never as an empty list; see `loadList`.
 *
 * A reply is applied only while its query is still the current one: the
 * effect's cleanup marks an earlier request stale, so a slow reply to an
 * earlier keystroke cannot overwrite the page for the current one.
 */
export function List({ rpc, decide, limit, onChanged }: { rpc: Rpc; decide: DecideFn; limit: number; onChanged: () => void }) {
  const [status, setStatus] = useState<ListStatus>('all')
  const [q, setQ] = useState('')
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  // Bumped after a decision so the effect below re-reads the same query.
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let stale = false
    void loadList(rpc, { status, q, limit }).then((next) => { if (!stale) setState(next) })
    return () => { stale = true }
  }, [rpc, status, q, limit, reload])

  const act = useCallback(async (id: string, decision: Decision) => {
    try {
      const result = readDecideResult(await decide(id, decision))
      setNotice(result.ok ? null : 'Ez a kártya időközben eltűnt az adatbázisból, a döntés nem íródott le sehova.')
    } catch (err) {
      setNotice(`A döntés nem mentődött el: ${errorText(err)}`)
    }
    setReload((n) => n + 1)
    onChanged()
  }, [decide, onChanged])

  return <ListBody state={state} status={status} q={q} notice={notice} onStatus={setStatus} onQuery={setQ} onNotice={setNotice} onAct={act} />
}

/**
 * The list as drawn for one state. Split from `List` so the test can render
 * the refused and the capped states directly: the stateful half loads in an
 * effect, which a server render never runs.
 */
export function ListBody({ state, status, q, notice, onStatus, onQuery, onNotice, onAct }: {
  state: ListState
  status: ListStatus
  q: string
  notice: string | null
  onStatus: (status: ListStatus) => void
  onQuery: (q: string) => void
  onNotice: (notice: string | null) => void
  onAct: (id: string, decision: Decision) => Promise<void>
}) {
  return (
    <div className="ais-list">
      <div className="ais-chips">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`ais-chip${status === c.key ? ' ais-chip-active' : ''}`}
            onClick={() => onStatus(c.key)}
          >
            {c.label}
          </button>
        ))}
        <input
          className="ais-search"
          type="search"
          placeholder="Keresés a címsorban és a leírásban"
          value={q}
          onChange={(e) => onQuery(e.target.value)}
        />
        {state.kind === 'ok' && <span className="ais-muted ais-mono">{state.page.total} sor</span>}
      </div>
      {notice && <div className="ais-toast" role="status" onClick={() => onNotice(null)}>{notice}</div>}
      {state.kind === 'loading' && <p className="ais-muted">Betöltés…</p>}
      {state.kind === 'refused' && (
        <p className="ais-error" role="alert">A lekérdezést a szerver elutasította, a lista nem tölthető be: {state.message}</p>
      )}
      {state.kind === 'ok' && state.page.items.length === 0 && (
        <p className="ais-muted">Nincs ilyen sor{q ? ' erre a keresésre' : ''}.</p>
      )}
      {state.kind === 'ok' && state.page.items.map((it) => {
        const href = safeHref(it.url)
        const badge = statusBadge(it.status)
        return (
          <div key={it.id} className="ais-row">
            <div className="ais-meta ais-mono">
              <span>{formatScore(it.apply_score)} / {formatScore(it.score)}</span>
              <span>{it.source_name || '—'}</span>
              <span>{formatDate(it.sent_at)}</span>
              <span className={badge.known ? 'ais-badge' : 'ais-badge ais-badge-bad'}>{badge.label}</span>
              {it.link_read === 0 && <span className="ais-warn">LINK NEM OLVASVA</span>}
            </div>
            <strong>{it.headline}</strong>
            <p>{it.summary}</p>
            {href
              ? <a className="ais-link" href={href} target="_blank" rel="noopener noreferrer">{href}</a>
              : it.url
                ? <span className="ais-warn">A link nem megnyitható (nem http/https): {it.url}</span>
                : null}
            <div className="ais-actions">
              <button type="button" className="ais-btn ais-btn-small" onClick={() => { void onAct(it.id, 'save') }}>Ment</button>
              <button type="button" className="ais-btn ais-btn-small" onClick={() => { void onAct(it.id, 'archive') }}>Archivál</button>
              <button type="button" className="ais-btn ais-btn-small" onClick={() => { void onAct(it.id, 'undo') }}>Visszavon</button>
            </div>
          </div>
        )
      })}
      {state.kind === 'ok' && cappedNote(state.page.items.length, state.page.total, 'sor') && (
        <p className="ais-muted ais-capped">{cappedNote(state.page.items.length, state.page.total, 'sor')}. Szűkítsd a keresést, hogy a többi is látszódjon.</p>
      )}
    </div>
  )
}
