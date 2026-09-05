import type { ManagedStatus } from './api'

/**
 * The words the page puts next to the numbers, kept out of the components so
 * test/ui.test.mjs can pin each phrase against the fact it reports.
 *
 * Everything here returns plain strings for a component to render as text.
 * None of it builds markup, and none of it reads a stored row's content for
 * anything but display.
 */

/** `new Date(value)` is only trusted when it parsed; otherwise the stored text is shown as text. */
function dateOf(value: string): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A stored timestamp as a Hungarian date and time, or '' for none, or the raw text when it does not parse. */
export function formatDate(value: string | null | undefined): string {
  if (typeof value !== 'string' || value === '') return ''
  const date = dateOf(value)
  return date ? date.toLocaleString('hu-HU') : value
}

/**
 * A duration in milliseconds as `m:ss`, or `s,s mp` under a minute.
 *
 * A value that is not a finite number is `?`, not 0: a missing measurement
 * and a measurement of zero are different facts, and this module writes the
 * word `meretlen` elsewhere for the same reason.
 */
export function formatMs(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?'
  if (ms < 0) return '?'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} mp`
  const perc = Math.floor(ms / 60_000)
  const masodperc = Math.floor((ms % 60_000) / 1000)
  return `${perc}:${String(masodperc).padStart(2, '0')}`
}

/** Whole minutes, for the status bar's "N perce" on a running render. */
export function formatPerc(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '?'
  return String(Math.floor(ms / 60_000))
}

/**
 * The 2.3 statuses in words, and the render and proposal vocabularies beside
 * them.
 *
 * The stored values are already Hungarian identifiers (`qa_hiba`,
 * `render_hiba`), so this is not a translation: it is the difference between
 * a column heading a person reads and a database value. A status this map has
 * no word for is shown as the raw value and flagged, because "this row is in
 * a state the page does not know" is the fact, and folding it into a state
 * the page does know would be the false report the whole module is built to
 * avoid.
 */
export const STATUS_HU: Readonly<Record<string, string>> = Object.freeze({
  nyitott: 'Nyitott',
  terv: 'Terv',
  lektoralt: 'Lektorált',
  elbukott: 'Elbukott',
  narralt: 'Narrált',
  renderel: 'Renderel',
  render_hiba: 'Render-hiba',
  qa_ok: 'QA rendben',
  qa_hiba: 'QA-hiba',
  qa_meretlen: 'QA méretlen',
  lezart: 'Lezárt',
})

export function statusLabel(status: unknown): { label: string; known: boolean } {
  if (typeof status === 'string' && Object.prototype.hasOwnProperty.call(STATUS_HU, status)) {
    return { label: STATUS_HU[status], known: true }
  }
  if (typeof status !== 'string' || status === '') return { label: '(üres státusz)', known: false }
  return { label: status, known: false }
}

/** The render row's own statuses (`RENDER_STATUSOK`). Unknown values come through raw for the same reason. */
export const RENDER_STATUS_HU: Readonly<Record<string, string>> = Object.freeze({
  fut: 'fut',
  kesz: 'kész',
  hiba: 'hiba',
  elveszett: 'elveszett',
})

export function renderStatusLabel(status: unknown): string {
  if (typeof status === 'string' && Object.prototype.hasOwnProperty.call(RENDER_STATUS_HU, status)) return RENDER_STATUS_HU[status]
  return typeof status === 'string' && status !== '' ? status : '(ismeretlen render-státusz)'
}

/** The proposal kinds and the proposal statuses, for the Javaslatok headings. */
export function fajtaLabel(fajta: unknown): string {
  if (fajta === 'tanulsag') return 'tanulság'
  if (fajta === 'szabaly') return 'szabály'
  if (fajta === 'sablon') return 'sablon'
  return typeof fajta === 'string' && fajta !== '' ? fajta : '(ismeretlen fajta)'
}

/**
 * What an accepted proposal is waiting for, in the spec's own two phrases.
 * A `tanulsag` is not waiting for anything -- accepting one writes the lesson
 * in the same transaction -- so it never reaches this list.
 */
export function varakozikLabel(fajta: unknown): string {
  if (fajta === 'szabaly') return 'kódolásra vár'
  if (fajta === 'sablon') return 'a kitre vár'
  return 'elfogadva'
}

/** The counter the caps are shown as, e.g. `9/12`. */
export function sapkaSzoveg(db: unknown, sapka: unknown): string {
  const a = typeof db === 'number' && Number.isFinite(db) ? String(db) : '?'
  const b = typeof sapka === 'number' && Number.isFinite(sapka) ? String(sapka) : '?'
  return `${a}/${b}`
}

/** Whether a cap is full, and so whether the decision buttons are replaced by the sentence that says to decide first. */
export function sapkaBetelt(db: unknown, sapka: unknown): boolean {
  return typeof db === 'number' && typeof sapka === 'number' && db >= sapka
}

/**
 * A scene's props as text.
 *
 * `JSON.stringify` of everything except `tipus`, which is drawn as its own
 * heading. The result goes into a `<pre>` as a text child: it is a
 * stranger's newsletter turned into props by an agent, and the only thing
 * this page does with it is show it.
 */
export function propokSzoveg(jelenet: unknown): string {
  if (jelenet === null || typeof jelenet !== 'object' || Array.isArray(jelenet)) return JSON.stringify(jelenet, null, 2) ?? 'null'
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(jelenet as Record<string, unknown>)) if (key !== 'tipus') rest[key] = value
  return JSON.stringify(rest, null, 2)
}

/** A scene object's declared type, or a placeholder. Read for display only; never used to look anything up. */
export function jelenetTipus(jelenet: unknown): string {
  if (jelenet !== null && typeof jelenet === 'object' && !Array.isArray(jelenet)) {
    const tipus = (jelenet as Record<string, unknown>).tipus
    if (typeof tipus === 'string' && tipus !== '') return tipus
  }
  return '(nincs típus)'
}

/**
 * A QA measurement or threshold as text. Numbers, strings and booleans come
 * through as themselves; anything else is JSON, because a measurement the
 * page cannot name is still a measurement the operator should see.
 */
export function mertSzoveg(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return '—'
  return JSON.stringify(value)
}

/**
 * The retention metric of one template type. The word `meretlen` is
 * `sablon.mjs`'s own and is passed through untranslated: it is the value
 * stored for "no retention point falls inside this scene", and a 0 there
 * would read as "this scene loses nobody".
 */
export function megtartasSzoveg(value: number | string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? `+${value.toFixed(3)}` : value.toFixed(3)
  return typeof value === 'string' && value !== '' ? value : '—'
}

/** A code map (`lektoriTalalat`) as `kod ×n` pairs, sorted, or a dash. */
export function kodSzamok(map: unknown): string {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return '—'
  const parts = Object.entries(map as Record<string, unknown>)
    .map(([kod, n]) => `${kod} ×${typeof n === 'number' ? n : '?'}`)
    .sort()
  return parts.length === 0 ? '—' : parts.join(', ')
}

/**
 * The schedule line. Three states, three sentences, and the remedy is named
 * for exactly one of them: `unscheduled` sends the operator to Reconcile,
 * because that is the only thing that creates the runs, and the sentence is
 * the spec's own -- it is not the same fact as an empty queue and must never
 * be worded as one. `unknown` sends them nowhere, because a check that could
 * not be made says nothing about whether the runs exist.
 */
export function describeManaged(managed: ManagedStatus | null): { text: string; trouble: boolean } {
  if (managed === null) return { text: 'Ütemezés: az ellenőrzés folyamatban', trouble: false }
  if (managed.kind === 'ready') return { text: `Ütemezés: ${managed.schedules} ütemezés él`, trouble: false }
  if (managed.kind === 'unscheduled') {
    return {
      text: `Ütemezés: nincs ütemezés — Reconcile kell (${managed.missing.length} a ${managed.total} ütemezésből hiányzik: ${managed.missing.join(', ')}). Amíg az Extensions lapon a Videó kártya Reconcile gombját meg nem nyomod (vagy le nem futtatod a swarmclaw extensions reconcile --extension-id video.mjs parancsot), magától egyetlen futás sem indul el.`,
      trouble: true,
    }
  }
  return { text: `Ütemezés: az ütemezéseket nem tudtam lekérdezni: ${managed.reason}. Nem tudni, be vannak-e állítva.`, trouble: true }
}

/**
 * The one url on this page that may become a link target.
 *
 * `videoOpen` builds a signal-sourced video's `forras_szoveg` as the card's
 * headline, summary and url joined with blank lines (terv.mjs,
 * `forrasSzovegOf`), so the url is the last paragraph -- the third when the
 * summary is there, the second when it is not, which is why this counts from
 * the end rather than to a fixed index. A manually opened video's text is
 * whatever the operator pasted and usually ends in no url at all.
 *
 * The paragraph is offered only if `safeHref` accepts THE WHOLE of it: a
 * paragraph of prose that merely contains a url is prose, and linking it
 * would mean this page decided where inside a stranger's text a link starts.
 * Everything else about the source text stays text.
 */
export function forrasUrl(forrasSzoveg: string, safe: (url: string) => string | null): string | null {
  if (typeof forrasSzoveg !== 'string') return null
  const bekezdesek = forrasSzoveg.split('\n\n').map((p) => p.trim()).filter((p) => p !== '')
  const utolso = bekezdesek[bekezdesek.length - 1]
  return utolso === undefined ? null : safe(utolso)
}
