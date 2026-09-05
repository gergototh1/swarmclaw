import type { Board, ManagedStatus, Sweep } from './api'
import { cappedNote, describeGmail, describeManaged, describeOutcome, formatDateTime, kindLabel, noteSegments, sweepOutcome } from './format'

/**
 * The line the operator reads before the deck: what the last run did, whether a
 * mailbox can be reached at all, and which label is being read.
 *
 * Nothing here is folded together. A sweep that is not closed, one that
 * failed, one that read the label and found nothing, and one that found rows
 * are four different sentences (see `describeOutcome`), and a mailbox contract
 * that does not resolve and a check that could not run are two more (see
 * `describeGmail`). The link to the Gmail page is offered only where that page
 * is the operator's next step, which `describeGmail` decides.
 *
 * The schedule line is the same rule applied to the one seam the sweep rows
 * cannot cover: "no sweep has run yet" is true both on an install whose two
 * schedules are waiting for their first slot and on one where the operator
 * never pressed Reconcile and nothing is scheduled at all. `managed` is the
 * host's answer to which (see managed-state.ts), and `null` is "not answered
 * yet", which is worded as such rather than as either.
 *
 * The href is root-relative, the same shape the host's own `assetUrl` builds,
 * so it works wherever the app is served from without this bundle knowing the
 * origin. It is an ordinary in-app page behind the host's auth cookie, which a
 * plain link navigation carries. It is NOT an OAuth route: the consent this
 * extension used to start is the `gmail` extension's now, and that page is
 * where the operator connects the mailbox.
 */
const GMAIL_PAGE_HREF = '/x/gmail'

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

export function StatusBar({ board, managed, onRefresh }: { board: Board; managed: ManagedStatus | null; onRefresh: () => void }) {
  const last = board.sweeps[0]
  const gmail = describeGmail(board.gmail)
  const schedule = describeManaged(managed)
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
          <span className={board.gmail.status === 'ready' ? '' : 'ais-warn'}>{gmail.text}</span>
          {gmail.page && <a className="ais-link ais-gmail-page" href={GMAIL_PAGE_HREF}>Gmail lap</a>}
          <span className="ais-muted"> · címke: {board.label}</span>
        </span>
      </div>
      <div className="ais-status-row">
        <span className={schedule.trouble ? 'ais-warn' : ''}>{schedule.text}</span>
      </div>
    </div>
  )
}
