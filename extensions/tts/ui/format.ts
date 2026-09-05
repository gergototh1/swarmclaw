/**
 * How a row's values are worded on the page. Pure, and none of these throw:
 * a row column that is not the shape expected prints a marker rather than
 * taking the list down, and a value that is not a string is never rendered
 * as if it were one.
 */

/** The row statuses `db.mjs` writes, worded for the operator. Anything else is shown raw and flagged. */
const STATUS_TEXT: Readonly<Record<string, string>> = { kesz: 'kész', hiba: 'hiba', elveszett: 'elveszett (a fájl eltűnt)' }

export interface StatusBadge {
  text: string
  known: boolean
}

/** The status column with its code beside it when the row failed; an unknown status is shown as it is, flagged, not folded into a known one. */
export function statusBadge(status: unknown, hibaKod: unknown): StatusBadge {
  if (typeof status !== 'string') return { text: '(nincs státusz)', known: false }
  const text = STATUS_TEXT[status]
  if (text === undefined) return { text: `${status} (ismeretlen státusz)`, known: false }
  if (status === 'hiba' && typeof hibaKod === 'string' && hibaKod !== '') return { text: `${text}: ${hibaKod}`, known: true }
  return { text, known: true }
}

/** Milliseconds as seconds with one decimal, or a marker for a value that is not a finite number. */
export function formatMs(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '–'
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`
}

/** Whole seconds, for the counter line. */
export function formatSeconds(seconds: number): string {
  return `${Math.round(seconds)} s`
}

/** An ISO timestamp as the viewer's local date and time, or the raw value when it does not parse. */
export function formatDate(iso: unknown): string {
  if (typeof iso !== 'string' || iso === '') return '–'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString('hu-HU')
}

/** A value as text for a React child: the string itself, or a marker when the column is not a string. */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '(nem szöveg)'
}

/** The route column, worded. Known values are the three `kerte` labels the extension writes; anything else is shown raw. */
export function routeText(kerte: unknown): string {
  if (kerte === 'contract') return 'szerződés'
  if (kerte === 'mcp') return 'MCP'
  if (kerte === 'import') return 'import'
  return textOf(kerte)
}
