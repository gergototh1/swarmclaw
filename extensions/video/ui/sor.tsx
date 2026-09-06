import { useCallback, useState } from 'react'

import type { Board, BoardCard, Rpc } from './api'
import { errorText, refusalText } from './api'
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
 *
 * Above the columns is the one thing this view can DO rather than show:
 * opening a video from text the operator pastes. It is the first link of the
 * chain and the only one no agent can start on the operator's behalf, which
 * is why the queue -- and not some settings screen -- is where it stands.
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

/**
 * The manual-source open box, drawn from what the shell holds.
 *
 * Split out for the reason `VideoBody` and `SablonokBody` are: what a state
 * LOOKS like is pinned by rendering this with that state in the props, and a
 * server render runs no effect and no click.
 *
 * ONE SOURCE KIND ON PURPOSE. `nyit` also opens a video from a saved signal
 * card, and this box does not offer that: picking a card is a choice the
 * module already makes on its own (`pickSignal`), and a second, hand-driven
 * way to make it would be a second answer to the same question. What was
 * missing was the source the module cannot reach by itself -- text the
 * operator has in front of them -- so that is what the box takes.
 *
 * The title is optional because the service already has a rule for an absent
 * one: `cimOf` falls back to a title derived from the source text. A blank
 * field here is that fallback being chosen, not a field left unfilled, and
 * the placeholder says so.
 */
export function UjVideoBody({ forrasSzoveg, cim, kuldes, uzenet, onForras, onCim, onKuld }: {
  forrasSzoveg: string
  cim: string
  kuldes: boolean
  uzenet: string | null
  onForras: (value: string) => void
  onCim: (value: string) => void
  onKuld: () => void
}) {
  // Disabled exactly when there is a sentence saying why, and never
  // otherwise: the rule the preview button on the Sablonok view is built on.
  const ok = forrasSzoveg.trim() === ''
    ? 'Forrás szöveg nélkül nem nyílik videó.'
    : kuldes ? 'A nyitás elment, a válaszra várok.' : null
  return (
    <section className="vid-uj-video">
      <h3>Új videó kézi forrásból</h3>
      <form onSubmit={(e) => { e.preventDefault(); onKuld() }}>
        <label>
          Forrás szövege
          <textarea className="vid-input" rows={4} value={forrasSzoveg} onChange={(e) => onForras(e.target.value)} />
        </label>
        <label>
          Cím
          <input className="vid-input" type="text" value={cim} onChange={(e) => onCim(e.target.value)} placeholder="üresen hagyva a modul a forrás szövegéből ad címet" />
        </label>
        <div className="vid-lepes">
          <button type="submit" className="vid-btn" disabled={ok !== null}>Új videó</button>
          {ok !== null && <span className="vid-muted vid-lepes-ok">{ok}</span>}
        </div>
      </form>
      {uzenet !== null && <p className="vid-notice" role="status">{uzenet}</p>}
    </section>
  )
}

/**
 * The box's state and its one request.
 *
 * `nyit` RESOLVES with its refusals (the daily cap, a source text longer than
 * the column takes), so the answer is read with `refusalText` before anything
 * says a video opened; a rejected promise is the other fact -- the request
 * never reached the module -- and gets its own sentence. Neither is folded
 * into "sikertelen".
 *
 * On a real open the board is reloaded through `onNyitva`, because the new
 * video belongs in the queue behind this box and nothing else would put it
 * there.
 */
function UjVideo({ rpc, onNyitva }: { rpc: Rpc; onNyitva: () => void }) {
  const [forrasSzoveg, setForrasSzoveg] = useState('')
  const [cim, setCim] = useState('')
  const [kuldes, setKuldes] = useState(false)
  const [uzenet, setUzenet] = useState<string | null>(null)

  const onKuld = useCallback(() => {
    setKuldes(true)
    // The text goes as it was pasted. `nyissVideot` stores a source byte for
    // byte and the Video view is where it is labelled as a stranger's text;
    // trimming it here would be this page editing a source nobody asked it to
    // edit.
    rpc('nyit', { forras: 'kezi', forrasSzoveg, cim })
      .then((raw) => {
        const hiba = refusalText(raw)
        if (hiba !== null) { setUzenet(`A videó nem nyílt meg — ${hiba}`); return }
        setUzenet('A videó megnyílt, és a sor frissült.')
        setForrasSzoveg('')
        setCim('')
        onNyitva()
      })
      .catch((err: unknown) => setUzenet(`A nyitás kérése el sem jutott a modulhoz: ${errorText(err)}`))
      .finally(() => setKuldes(false))
  }, [rpc, forrasSzoveg, cim, onNyitva])

  return (
    <UjVideoBody
      forrasSzoveg={forrasSzoveg}
      cim={cim}
      kuldes={kuldes}
      uzenet={uzenet}
      onForras={setForrasSzoveg}
      onCim={setCim}
      onKuld={onKuld}
    />
  )
}

export function Sor({ board, onOpen, rpc, onNyitva }: { board: Board; onOpen: (id: string) => void; rpc: Rpc; onNyitva: () => void }) {
  const teli = board.statusok.filter((s) => (board.oszlopok[s] ?? []).length > 0)
  const ures = board.statusok.filter((s) => (board.oszlopok[s] ?? []).length === 0)
  const sapkak = board.sapkak
  return (
    <div className="vid-sor">
      <UjVideo rpc={rpc} onNyitva={onNyitva} />
      {teli.length === 0 && (
        <p className="vid-muted">
          {/*
            The sentence used to name the producing agent as the only way a
            video is opened, which stopped being true the moment the box above
            appeared. An empty queue with a live control on the same screen
            has to say that the control is the other way.
          */}
          Egyetlen videó sincs a sorban. A modul akkor nyit videót, amikor a gyártó ügynök lefut — vagy amikor te nyitsz egyet a fenti dobozban.
        </p>
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
