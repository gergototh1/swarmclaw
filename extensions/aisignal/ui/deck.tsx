import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

import type { Board, Item } from './api'
import { createDeckController, deckKeyAction, remainingUndecided, stampFor, type DecideFn, type DeckDecision } from './deck-state'
import { formatDate, formatScore } from './format'
import { safeHref } from './safe-href'

/**
 * One card at a time. Drag past a quarter of the card's width, or press an
 * arrow key, and the decision is written; `u` or Cmd/Ctrl+Z takes the newest
 * one back, ten deep. The state lives in `createDeckController`, which is
 * where the optimistic write and every rollback are, and which
 * test/ui.test.mjs drives without a DOM.
 *
 * Every field of the card is a stranger's text and is rendered as a React
 * child, which React escapes. The one place that text becomes anything else
 * is the link, and it goes through `safeHref` first: a url that is not
 * `http(s)` is shown as text under a warning instead.
 *
 * The parent remounts this component (by `key`) whenever the board is reloaded,
 * so the controller is created once per board and never has to reconcile a
 * new deck with an old undo stack.
 */

function Card({ item, drag, onPointerDown, onPointerMove, onPointerEnd, cardRef }: {
  item: Item
  drag: { x: number; width: number } | null
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerEnd: (e: ReactPointerEvent<HTMLDivElement>) => void
  cardRef: RefObject<HTMLDivElement | null>
}) {
  const ratio = drag ? drag.x / drag.width : 0
  const stamp = stampFor(ratio)
  const href = safeHref(item.url)
  return (
    <div
      ref={cardRef}
      className={`ais-card${drag ? ' ais-card-dragging' : ''}`}
      style={drag ? { transform: `translateX(${drag.x}px) rotate(${ratio * 8}deg)` } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {stamp && (
        <div className={`ais-stamp ais-stamp-${stamp}`} aria-hidden="true">{stamp === 'save' ? 'mentve' : 'archív'}</div>
      )}
      <div className="ais-meta ais-mono">
        <span>{item.source_name || '—'}</span>
        <span>{formatDate(item.sent_at)}</span>
        <span>alkalmazhatóság {formatScore(item.apply_score)} · hírérték {formatScore(item.score)}</span>
        {item.link_read === 0 && <span className="ais-warn">LINK NEM OLVASVA</span>}
      </div>
      <h2>{item.headline}</h2>
      <p>{item.summary}</p>
      {item.why && <p className="ais-why">{item.why}</p>}
      {href
        ? <a className="ais-link" href={href} target="_blank" rel="noopener noreferrer">{href}</a>
        : item.url
          ? <span className="ais-warn">A link nem megnyitható (nem http/https): {item.url}</span>
          : null}
    </div>
  )
}

export function Deck({ board, decide, onChanged }: { board: Board; decide: DecideFn; onChanged: () => void }) {
  const [controller] = useState(() => createDeckController(board.deck, decide))
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const [drag, setDrag] = useState<{ startX: number; x: number; width: number } | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const top: Item | undefined = state.queue[0]

  const commit = useCallback((decision: DeckDecision) => {
    setDrag(null)
    void controller.commit(decision)
  }, [controller])
  const undoLast = useCallback(() => { void controller.undoLast() }, [controller])
  const openTop = useCallback(() => {
    const href = safeHref(top?.url)
    if (href) window.open(href, '_blank', 'noopener')
  }, [top])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = deckKeyAction(e)
      if (!action) return
      e.preventDefault()
      if (action === 'archive') commit('archive')
      else if (action === 'save') commit('save')
      else if (action === 'open') openTop()
      else undoLast()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit, undoLast, openTop])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // A press on the link or a button inside the card is a click, not a drag.
    if (e.target instanceof Element && e.target.closest('a, button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ startX: e.clientX, x: 0, width: cardRef.current?.offsetWidth || 1 })
  }, [])
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    setDrag((d) => (d ? { ...d, x: e.clientX - d.startX } : d))
  }, [])
  const onPointerEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    if (e.type === 'pointercancel') { setDrag(null); return }
    const decision = stampFor(drag.x / drag.width)
    if (decision) commit(decision)
    else setDrag(null)
  }, [drag, commit])

  const remaining = remainingUndecided(board.undecided, state)
  const item = top

  if (!item) {
    return (
      <div className="ais-empty">
        {state.toast && <div className="ais-toast" role="status" onClick={controller.dismissToast}>{state.toast}</div>}
        <p>
          {board.sweeps.length === 0
            ? 'Még nem futott sweep, így nincs mit eldönteni.'
            : remaining > 0
              ? `Ez a köteg kész. Még ${remaining} eldöntetlen signal vár; a Frissítés hozza a következő köteget.`
              : 'Ez a köteg kész, minden eldöntve.'}
        </p>
        <div className="ais-actions">
          <button type="button" className="ais-btn" onClick={undoLast} disabled={state.undo.length === 0}>Visszavon (u)</button>
          <button type="button" className="ais-btn ais-btn-primary" onClick={onChanged}>Frissítés</button>
        </div>
      </div>
    )
  }

  return (
    <div className="ais-deck">
      {state.toast && <div className="ais-toast" role="status" onClick={controller.dismissToast}>{state.toast}</div>}
      <div className="ais-card-stack">
        {state.queue.slice(1, 3).map((q, i) => (
          <div key={q.id} className={`ais-card ais-card-behind ais-card-behind-${i + 1}`} aria-hidden="true" />
        ))}
        <Card
          key={item.id}
          item={item}
          drag={drag ? { x: drag.x, width: drag.width } : null}
          cardRef={cardRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerEnd={onPointerEnd}
        />
      </div>
      <div className="ais-actions">
        <button type="button" className="ais-btn" onClick={() => commit('archive')}>← Archivál</button>
        <button type="button" className="ais-btn" onClick={undoLast} disabled={state.undo.length === 0}>Visszavon (u)</button>
        <button type="button" className="ais-btn ais-btn-primary" onClick={() => commit('save')}>Ment →</button>
      </div>
      <p className="ais-muted ais-mono">
        Még {state.queue.length} a pakliban · {remaining} eldöntetlen összesen
        {board.undecided > board.deck.length ? ` · a pakli ${board.deckLimit} kártyás, a többi a Frissítéssel jön` : ''}
      </p>
    </div>
  )
}
