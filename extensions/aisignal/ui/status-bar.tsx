import type { Board, Sweep } from './api'
import { cappedNote, describeGmail, describeOutcome, formatDateTime, kindLabel, noteSegments, sweepOutcome } from './format'

/**
 * The line the operator reads before the deck: what the last run did, whether
 * Gmail can be swept at all, and which label is being read.
 *
 * Nothing here is folded together. A sweep that is not closed, one that
 * failed, one that read the label and found nothing, and one that found rows
 * are four different sentences (see `describeOutcome`), and a Gmail credential
 * that is absent and a check that could not run are two (see `describeGmail`).
 * The connect link is offered only when the credential is known to be absent.
 *
 * The href is root-relative, the same shape the host's own `assetUrl` builds,
 * so it works wherever the app is served from without this bundle knowing the
 * origin. The route sits behind the host's auth cookie, which a plain link
 * navigation carries, and its callback returns to this page.
 */
const CONNECT_HREF = '/api/oauth/google/start?purpose=aisignal'

function SweepLine({ sweep }: { sweep: Sweep }) {
  const outcome = sweepOutcome(sweep)
  const trouble = outcome === 'unfinished' || outcome === 'failed'
  return (
    <>
      <span className="ais-mono">{formatDateTime(sweep.ran_at)}</span>
      <span> · {kindLabel(sweep.kind)}</span>
      <span className={trouble ? 'ais-warn' : ''}> · {describeOutcome(sweep)}</span>
      {sweep.leftover > 0 && <span className="ais-warn"> · {sweep.leftover} levél kimaradt a sapka miatt</span>}
      {outcome !== 'failed' && noteSegments(sweep.note).map((segment, i) => (
        <span key={i} className={segment.key === 'unavailable' || segment.key === 'unasked' ? 'ais-warn' : 'ais-muted'}> · {segment.text}</span>
      ))}
    </>
  )
}

export function StatusBar({ board, onRefresh }: { board: Board; onRefresh: () => void }) {
  const last = board.sweeps[0]
  const gmail = describeGmail(board.gmail)
  const sweepsCap = cappedNote(board.sweeps.length, board.counts.sweeps, 'futás')
  return (
    <div className="ais-status">
      <div className="ais-status-row">
        {last ? (
          <span>
            <span>Utolsó sweep: </span>
            <SweepLine sweep={last} />
            <span> · {board.undecided} eldöntetlen</span>
          </span>
        ) : (
          <span>Még nem futott sweep, így nincs mit eldönteni.</span>
        )}
        <button type="button" className="ais-btn ais-btn-small" onClick={onRefresh}>Frissítés</button>
      </div>
      {board.sweeps.length > 1 && (
        <details className="ais-sweeps">
          <summary>Korábbi futások{sweepsCap ? ` (${sweepsCap})` : ` (${board.sweeps.length})`}</summary>
          <ul>
            {board.sweeps.map((sweep) => (
              <li key={sweep.id}><SweepLine sweep={sweep} /></li>
            ))}
          </ul>
        </details>
      )}
      <div className="ais-status-row">
        <span>
          <span className={board.gmail.status === 'connected' ? '' : 'ais-warn'}>{gmail.text}</span>
          {gmail.canConnect && <a className="ais-link ais-connect" href={CONNECT_HREF}>Gmail bekötése</a>}
          <span className="ais-muted"> · címke: {board.label}</span>
        </span>
      </div>
    </div>
  )
}
