import type { GmailStatus, ManagedStatus, Sweep } from './api'

/**
 * The words the page puts next to the numbers, kept out of the components so
 * test/ui.test.mjs can pin each phrase against the fact it reports.
 *
 * Everything here returns plain strings for a component to render as text.
 * None of it builds markup, and none of it reads a stored row's content for
 * anything but display: a sweep `note` is split on the separator `db.mjs`
 * joins it with, and the pieces are shown, never acted on.
 */

/** `new Date(value)` is only trusted when it parsed; otherwise the stored text is shown as text. */
function dateOf(value: string): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A stored timestamp as a Hungarian date, or '' for none, or the raw text when it does not parse. */
export function formatDate(value: string | null | undefined): string {
  if (typeof value !== 'string' || value === '') return ''
  const date = dateOf(value)
  return date ? date.toLocaleDateString('hu-HU') : value
}

/** As `formatDate`, with the time of day. */
export function formatDateTime(value: string | null | undefined): string {
  if (typeof value !== 'string' || value === '') return ''
  const date = dateOf(value)
  return date ? date.toLocaleString('hu-HU') : value
}

/** A score to two decimals, or a placeholder for a row whose column is not a number. */
export function formatScore(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '?'
}

/** The statuses `db.mjs` writes and the word the page shows for each. */
export const STATUS_HU: Readonly<Record<string, string>> = Object.freeze({
  new: 'eldöntetlen',
  saved: 'mentett',
  archived: 'archivált',
})

/**
 * A status badge: the Hungarian word for a known status, or the raw stored
 * value flagged as unknown. A row with a status this page has no word for is
 * shown with that status rather than folded into one it does have a word for,
 * because "this row is in a state the page does not know" is the fact.
 */
export function statusBadge(status: unknown): { label: string; known: boolean } {
  if (typeof status === 'string' && Object.prototype.hasOwnProperty.call(STATUS_HU, status)) {
    return { label: STATUS_HU[status], known: true }
  }
  if (typeof status !== 'string' || status === '') return { label: '(üres státusz)', known: false }
  return { label: status, known: false }
}

/** The sweep kinds `db.mjs` and `research.mjs` write, and the word for each; anything else is shown raw. */
export function kindLabel(kind: unknown): string {
  if (kind === 'mail') return 'levél'
  if (kind === 'research') return 'kutatás'
  return typeof kind === 'string' && kind !== '' ? kind : '(ismeretlen fajta)'
}

/**
 * The Gmail line. Three states, three sentences, and the reconnect link is
 * offered for exactly one of them: `error` means the host could not read its
 * own credential store, and sending an operator to reconnect an account that
 * may be connected is the false report `gmailHealth` in rpc.mjs refuses to
 * make. `canConnect` is what the status bar keys the link on.
 */
export function describeGmail(gmail: GmailStatus): { text: string; canConnect: boolean } {
  if (gmail.status === 'connected') return { text: 'Gmail: bekötve', canConnect: false }
  if (gmail.status === 'missing') return { text: 'Gmail: nincs bekötve', canConnect: true }
  return {
    text: `Gmail: az ellenőrzés nem sikerült (${gmail.code ?? 'ismeretlen ok'}), nem tudni, be van-e kötve`,
    canConnect: false,
  }
}

/**
 * What a sweep row says happened, as four facts that must never be confused.
 *
 *   - `unfinished`: `finished_at` is null. The run is still going or its
 *     process died; the row cannot tell which and neither can this page.
 *   - `failed`: `ok` is 0. The run blew up; `note` carries the code.
 *   - `nothing`: the run closed cleanly and found no rows. It asked.
 *   - `found`: the run closed cleanly with rows.
 */
export type SweepOutcome = 'unfinished' | 'failed' | 'nothing' | 'found'

export function sweepOutcome(sweep: Sweep): SweepOutcome {
  if (sweep.finished_at === null) return 'unfinished'
  if (sweep.ok === 0) return 'failed'
  return sweep.found > 0 ? 'found' : 'nothing'
}

/** The sentence for each outcome. `note` for a failure is the stored text, shown as text. */
export function describeOutcome(sweep: Sweep): string {
  switch (sweepOutcome(sweep)) {
    case 'unfinished':
      return 'nincs lezárva: vagy még fut, vagy megszakadt a lezárás előtt'
    case 'failed':
      return `hiba: ${sweep.note || '(a sor nem mondja meg, mi történt)'}`
    case 'nothing':
      return 'lefutott, 0 új sort talált'
    case 'found':
      return `${sweep.found} új sor`
  }
}

/**
 * One segment of a sweep note. `db.mjs` joins segments with '; ' and the
 * research sweep writes `unavailable=a,b`, `unasked=c` and `dropped=N`; the
 * two source lists are different facts (a source that failed when asked, and
 * one this run could not put its question to at all) and get different words.
 * The mail sweep writes `frontier_ahead=<iso>` when it set a stored frontier
 * aside for being ahead of the clock, and `finishSweep` writes
 * `frontier_held=clock_ahead` when it held the frontier for the same reason.
 * Any other segment is shown as it was stored.
 */
export interface NoteSegment {
  key: string
  text: string
}

export function noteSegments(note: string | null | undefined): NoteSegment[] {
  if (typeof note !== 'string' || note.trim() === '') return []
  return note.split('; ').filter((s) => s !== '').map((segment) => {
    const eq = segment.indexOf('=')
    const key = eq === -1 ? '' : segment.slice(0, eq)
    const value = eq === -1 ? segment : segment.slice(eq + 1)
    if (key === 'unavailable') return { key, text: `nem válaszolt: ${value.split(',').join(', ')}` }
    if (key === 'unasked') return { key, text: `meg sem lett kérdezve: ${value.split(',').join(', ')}` }
    if (key === 'dropped') return { key, text: `${value} jelölt kimaradt a sapka miatt` }
    if (key === 'frontier_held') return { key, text: 'a vízjel nem mozdult: a gép órája előrébb járt a lezáráskor' }
    if (key === 'frontier_ahead') return { key, text: `a tárolt vízjel (${value}) a jövőben volt, a futás a korábbi biztos ablaktól indult` }
    return { key, text: segment }
  })
}

/**
 * The line under a capped list. Empty when the list is whole; otherwise it
 * names both numbers, so a full page is never read as all there is.
 */
export function cappedNote(shown: number, total: number, noun: string): string {
  if (total <= shown) return ''
  return `${shown} ${noun} látszik, összesen ${total}`
}

/**
 * The schedule line. Three states, three sentences, and the remedy is named
 * for exactly one of them: `unscheduled` sends the operator to the Reconcile
 * button, because that is the only thing that creates the runs; `unknown`
 * sends them nowhere, because a check that could not be made says nothing
 * about whether the runs exist. The missing names are the declared display
 * names, shown as text.
 */
export function describeManaged(managed: ManagedStatus | null): { text: string; trouble: boolean } {
  if (managed === null) return { text: 'Ütemezés: ellenőrzés folyamatban', trouble: false }
  if (managed.kind === 'ready') return { text: `Ütemezés: mind a ${managed.schedules} futás be van állítva`, trouble: false }
  if (managed.kind === 'unscheduled') {
    return {
      text: `Ütemezés: ${managed.missing.length} a ${managed.total} futásból nincs beállítva (${managed.missing.join(', ')}). Magától egyetlen sweep sem indul el, amíg az Extensions → Managed resources oldalon meg nem nyomod a Reconcile gombot.`,
      trouble: true,
    }
  }
  return { text: `Ütemezés: az ellenőrzés nem sikerült (${managed.reason}), nem tudni, be van-e állítva`, trouble: true }
}
