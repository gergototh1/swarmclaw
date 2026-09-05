import { useState } from 'react'

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

/**
 * Everything the bar says once it is open: the last sweep and its note, the
 * earlier runs, the mailbox and the label, the schedule. Nothing here is
 * folded together, which is why it is a list of rows and not a verdict.
 *
 * Split out from the shell because the shell owns the fold, and a server
 * render never runs a click: the tests that pin what a state LOOKS like
 * render this half directly.
 */
export function StatusBarBody({ board, managed }: { board: Board; managed: ManagedStatus | null }) {
  const last = board.sweeps[0]
  const gmail = describeGmail(board.gmail)
  const schedule = describeManaged(managed)
  const sweepsCap = cappedNote(board.sweeps.length, board.counts.sweeps, 'futás')
  return (
    <>
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
    </>
  )
}

/**
 * The one line the bar shows while it is closed.
 *
 * The bar opens closed (the operator asked for that), which puts a duty on
 * this line: NOTHING THAT STOPS THE SWEEP IS HIDDEN BEHIND THE FOLD. A
 * mailbox that cannot be reached and a schedule that does not exist are both
 * named here, in that order, because either one means no new cards will
 * appear no matter how long the operator waits. Only when both are fine does
 * the line fall back to the number the operator came for: how many cards are
 * still undecided.
 */
function osszefoglalo(board: Board, scheduleText: string, scheduleTrouble: boolean, gmailText: string): { text: string; kind: 'plain' | 'warn' } {
  if (board.gmail.status !== 'ready') return { text: gmailText, kind: 'warn' }
  if (scheduleTrouble) return { text: scheduleText, kind: 'warn' }
  if (board.sweeps.length === 0) return { text: 'még nem futott sweep', kind: 'warn' }
  return { text: `${board.undecided} eldöntetlen`, kind: 'plain' }
}

export function StatusBar({ board, managed, onRefresh }: { board: Board; managed: ManagedStatus | null; onRefresh: () => void }) {
  const gmail = describeGmail(board.gmail)
  const schedule = describeManaged(managed)
  // Closed by default: the operator reads the deck on this page, not the bar.
  const [nyitva, setNyitva] = useState(false)
  const ossz = osszefoglalo(board, schedule.text, schedule.trouble, gmail.text)
  return (
    <div className="ais-status">
      <div className="ais-status-head">
        <button
          type="button"
          className="ais-status-toggle"
          aria-expanded={nyitva}
          onClick={() => setNyitva((v) => !v)}
        >
          <span className="ais-caret" aria-hidden="true">{nyitva ? '▾' : '▸'}</span>
          <strong>Állapot</strong>
          <span className={ossz.kind === 'plain' ? 'ais-muted' : 'ais-warn'}>{ossz.text}</span>
        </button>
        <button type="button" className="ais-btn ais-btn-small" onClick={onRefresh}>Frissítés</button>
      </div>
      {nyitva && <StatusBarBody board={board} managed={managed} />}
    </div>
  )
}
