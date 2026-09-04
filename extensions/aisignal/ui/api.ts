/**
 * What the page sends to and receives from `rpc.mjs`, typed on this side.
 *
 * The rows are the ones `db.mjs` stores and `reads.mjs` hands on unchanged.
 * Every `headline`, `summary`, `why`, `source_name`, `url` and sweep `note`
 * below is newsletter prose or a forum post written by a stranger, and the
 * data layer leaves that text byte for byte on purpose so that the decision
 * about display is made where the text is displayed. That is here: every
 * component in this directory renders those fields as React text children, and
 * a url reaches an `href` only through `safeHref`.
 *
 * `readBoard`, `readItemsPage` and `readDecideResult` check the shape of what
 * came back before a component sees it. A response that is missing its lists
 * is refused by name rather than rendered as an empty board: the rule the
 * layers below are built on -- a source that answered with nothing and a
 * source that could not be asked are different facts -- applies to this page's
 * own server as much as to Gmail.
 */

export type Rpc = (method: string, body?: object) => Promise<unknown>

/** The decision vocabulary `rpc.decide` accepts, spelled as `db.mjs` spells it. */
export type Decision = 'save' | 'archive' | 'undo'

export interface Item {
  id: string
  headline: string
  summary: string
  url: string | null
  source_name: string | null
  sent_at: string | null
  score: number
  apply_score: number
  why: string
  link_read: number
  status: string
  decided_at: string | null
  created_at: string
}

export interface Sweep {
  id: string
  ran_at: string
  label: string
  ok: number
  note: string
  finished_at: string | null
  found: number
  leftover: number
  messages: number
  kind: string
}

export type GmailState = 'connected' | 'missing' | 'error'

export interface GmailStatus {
  status: GmailState
  code?: string
}

export interface Counts {
  items: number
  undecided: number
  sweeps: number
  seen: number
}

export interface Board {
  deck: Item[]
  deckLimit: number
  undecided: number
  /** The page size the list asks `items` for; `counts.items` is the total behind it. */
  allLimit: number
  sweeps: Sweep[]
  sweepLimit: number
  counts: Counts
  label: string
  gmail: GmailStatus
}

export interface ItemsPage {
  total: number
  items: Item[]
}

export interface DecideResult {
  ok: boolean
  id: string
  status: string
}

/** The status filters the list offers, a subset of what `reads.mjs` accepts. */
export type ListStatus = 'all' | 'new' | 'saved' | 'archived'

const GMAIL_STATES: readonly string[] = ['connected', 'missing', 'error']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(method: string, field: string): never {
  throw new Error(`a(z) ${method} válasz hiányos: nincs használható "${field}" mező`)
}

function readNumber(method: string, record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse(method, field)
  return value
}

function readArray<T>(method: string, record: Record<string, unknown>, field: string): T[] {
  const value = record[field]
  if (!Array.isArray(value)) refuse(method, field)
  return value as T[]
}

/**
 * The `board` response, or a thrown error naming the first field it lacks.
 *
 * Rows inside the lists are not walked: they are whatever `db.mjs` selected,
 * and a missing column there is a rendering question (`formatScore` prints a
 * placeholder for a non-number) rather than a reason to refuse the page.
 *
 * Only what the page reads is required. The list asks `items` for its own
 * page, so the board carries no row list beside the deck; it used to, and
 * every refresh -- one per decision -- shipped 200 rows nothing read.
 */
export function readBoard(raw: unknown): Board {
  if (!isRecord(raw)) refuse('board', 'board')
  const deck = readArray<Item>('board', raw, 'deck')
  const sweeps = readArray<Sweep>('board', raw, 'sweeps')
  const gmail = raw.gmail
  if (!isRecord(gmail) || typeof gmail.status !== 'string' || !GMAIL_STATES.includes(gmail.status)) refuse('board', 'gmail')
  const counts = raw.counts
  if (!isRecord(counts)) refuse('board', 'counts')
  return {
    deck,
    deckLimit: readNumber('board', raw, 'deckLimit'),
    undecided: readNumber('board', raw, 'undecided'),
    allLimit: readNumber('board', raw, 'allLimit'),
    sweeps,
    sweepLimit: readNumber('board', raw, 'sweepLimit'),
    counts: {
      items: readNumber('board', counts, 'items'),
      undecided: readNumber('board', counts, 'undecided'),
      sweeps: readNumber('board', counts, 'sweeps'),
      seen: readNumber('board', counts, 'seen'),
    },
    label: typeof raw.label === 'string' ? raw.label : refuse('board', 'label'),
    gmail: { status: gmail.status as GmailState, code: typeof gmail.code === 'string' ? gmail.code : undefined },
  }
}

/**
 * The `items` response, or a thrown error naming the field it lacks. The
 * server's `count` is `items.length` said twice and is not read.
 */
export function readItemsPage(raw: unknown): ItemsPage {
  if (!isRecord(raw)) refuse('items', 'items')
  return {
    total: readNumber('items', raw, 'total'),
    items: readArray<Item>('items', raw, 'items'),
  }
}

/**
 * The `decide` response. `ok: false` is a real answer -- the card was gone by
 * the time the write ran -- and it is returned as such, not thrown: the caller
 * decides what a decision that landed on nothing means for its own state.
 */
export function readDecideResult(raw: unknown): DecideResult {
  if (!isRecord(raw) || typeof raw.ok !== 'boolean') refuse('decide', 'ok')
  return {
    ok: raw.ok,
    id: typeof raw.id === 'string' ? raw.id : '',
    status: typeof raw.status === 'string' ? raw.status : '',
  }
}

/** The text of a failure, whatever the rpc layer threw. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
