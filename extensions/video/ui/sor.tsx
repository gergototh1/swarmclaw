import type { Board, BoardCard } from './api'
import { formatDate, renderStatusLabel, sapkaSzoveg, statusLabel } from './format'

/**
 * The queue: one column per status in the module's own vocabulary, in the
 * order `board.statusok` gives them.
 *
 * The server sends a total map -- every status is a key, empty columns
 * included -- and this view does not silently drop the empty ones, because
 * "no video is waiting for review" is a fact the operator reads off the
 * board. It does collapse them into one line, so eleven empty columns do not
 * push the one with rows off the screen; the line names each empty status, so
 * nothing disappears.
 *
 * Every string on a card is a stranger's text or an agent's summary of one,
 * and every one of them is a React text child. A card carries no url and no
 * link: the source url lives in the source text, and the Video view is where
 * it is shown, behind `safeHref`.
 */

function Kartya({ card, onOpen }: { card: BoardCard; onOpen: (id: string) => void }) {
  const status = statusLabel(card.status)
  const verdikt = card.utolsoVerdikt
  const render = card.render
  return (
    <button type="button" className="vid-card" data-video-id={card.id} onClick={() => onOpen(card.id)}>
      <span className="vid-card-title">{card.cim}</span>
      <span className="vid-card-meta">
        <span className={status.known ? 'vid-badge' : 'vid-badge vid-badge-bad'}>{status.label}</span>
        <span>forrás: {card.forrasTipus}</span>
        <span>{card.tervVerzio === null ? 'még nincs terv' : `v${card.tervVerzio}`}</span>
        <span>{formatDate(card.createdAt)}</span>
      </span>
      <span className="vid-card-meta">
        {/*
          Four different facts, four different sentences. A video with no
          verdict is not a video that passed, and a video with no render is
          not a render that failed; each says which it is.
        */}
        <span>
          {verdikt === null
            ? 'lektorálva: még nem'
            : `lektor: ${verdikt.verdikt}${verdikt.talalatok > 0 ? ` (${verdikt.talalatok} találat)` : ''}`}
        </span>
        <span>
          {render === null
            ? 'render: még nem indult'
            : `render: ${renderStatusLabel(render.status)}${render.hiba ? ` (${render.hiba.kod})` : ''}`}
        </span>
        <span>
          {card.qa === null
            ? 'QA: nincs érvényes sor'
            : card.qa.ok
              ? 'QA: ok'
              : `QA: bukott (${card.qa.bukasok.join(', ')})`}
        </span>
      </span>
    </button>
  )
}

export function Sor({ board, onOpen }: { board: Board; onOpen: (id: string) => void }) {
  const teli = board.statusok.filter((s) => (board.oszlopok[s] ?? []).length > 0)
  const ures = board.statusok.filter((s) => (board.oszlopok[s] ?? []).length === 0)
  const sapkak = board.sapkak
  return (
    <div className="vid-sor">
      {teli.length === 0 && (
        <p className="vid-muted">Egyetlen videó sincs a sorban. A modul akkor nyit videót, amikor a gyártó ügynök lefut.</p>
      )}
      <div className="vid-columns">
        {teli.map((status) => {
          const label = statusLabel(status)
          const cards = board.oszlopok[status] ?? []
          return (
            <section key={status} className="vid-column" data-status={status}>
              <h3 className={label.known ? '' : 'vid-badge-bad'}>{label.label} ({cards.length})</h3>
              {cards.map((card) => <Kartya key={card.id} card={card} onOpen={onOpen} />)}
            </section>
          )
        })}
      </div>
      {ures.length > 0 && (
        <p className="vid-muted vid-ures">Üres: {ures.map((s) => statusLabel(s).label).join(', ')}</p>
      )}
      <p className="vid-sapkak">
        <span>Nyitott javaslatok: {sapkaSzoveg(sapkak.nyitottJavaslat.db, sapkak.nyitottJavaslat.sapka)}</span>
        <span>Backlog szabály: {sapkaSzoveg(sapkak.backlog.szabaly.db, sapkak.backlog.szabaly.sapka)}</span>
        <span>Backlog sablon: {sapkaSzoveg(sapkak.backlog.sablon.db, sapkak.backlog.sablon.sapka)}</span>
        <span>Videó: {board.counts.videos} · terv: {board.counts.tervek} · render: {board.counts.renderek} · QA ok: {board.counts.qaOk}</span>
      </p>
    </div>
  )
}
