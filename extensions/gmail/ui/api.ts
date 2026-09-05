/**
 * What the page sends to and receives from `src/rpc.mjs`, typed on this side.
 *
 * WHAT IS IN THESE ROWS, AND WHO WROTE IT. A subject and a body on an outbound
 * row were written by an agent, by a consumer extension, or -- once the
 * operator has edited the draft in Gmail -- by the operator. A reply draft's
 * subject came off a stranger's letter. The `mit` column of a refused attempt
 * is whatever somebody asked this module to do, and it is the field a prompt
 * injection actually lands in. Every layer below leaves all of it alone on
 * purpose, so that the decision about display is made where the text is
 * displayed. That is here, and this page makes exactly one decision about it:
 * every field is rendered as a React text child, inside a box that wraps.
 *
 * NOTHING ON THIS PAGE BECOMES A LINK. The sibling pages carry a `safe-href`
 * module because they have one stored url that reaches an `href`; this page
 * has none. A draft body is prose written by somebody else and a url inside it
 * stays inside it, as text. The page's own single navigation target is the
 * host's connect route, a fixed root-relative path this file spells out
 * (`status-bar.tsx`), and test/ui.test.mjs pins that the built bundle contains
 * no `href` at all -- which is a stronger property than a scheme check, and
 * the reason a `safeHref` here would be an unused import rather than a gate.
 *
 * WHY THE READERS REFUSE, AND WHAT A REFUSAL IS ON THIS DOOR. `src/rpc.mjs`
 * wraps every method in `guard`, which answers a refusal as a 200 whose body
 * is `{ error: { code, message, ... } }` rather than throwing -- so that the
 * code survives the wire. A page that read that body as data would draw an
 * empty queue for a refused `board`, an empty book for a refused `konyv` and
 * an empty attempts list for a refused `attempts`, which is the exact false
 * report `health.mjs` is built to avoid. So `unwrap` below turns that envelope
 * back into a throw carrying the code, every reader goes through it, and every
 * view draws its own refusal instead of its own empty state.
 *
 * The readers check only what the page reads, and they do not walk into the
 * rows: a row is whatever `db.mjs` selected, and a field this page can render
 * as a placeholder is a rendering question rather than a reason to refuse the
 * whole load.
 */

export type Rpc = (method: string, body?: object) => Promise<unknown>

/** One health code as `runHealth` reports it: the code, plus whatever that code carries. */
export interface HealthItem {
  kod: string
  /** `google_oauth_client_missing` only: the deploy mode whose env pair the remedy names. */
  mode?: string
}

/**
 * A question this module could not answer, with what was asked beside the code
 * it got instead of an answer. Never folded into `hibak`: "the mailbox did not
 * answer" and "the mailbox is not connected" have different remedies.
 */
export interface NemValaszolt {
  mit: string
  kod: string | null
}

/** One daily budget: what has been spent today, and the ceiling the module enforces. */
export interface Keret {
  mai: number
  /** `null` when the setting is present and unreadable. Never the default, which the next refusal would not honour. */
  keret: number | null
  olvashatatlan: boolean
}

export interface Keretek {
  nap: string
  piszkozat: Keret
  kiadas: Keret
}

export interface Szamok {
  cimzettek: number
  eloCimzettek: number
  piszkozat: number
  kiadva: number
  elvetve: number
  hiba: number
  bizonytalan: number
  kiserletek: number
}

/** Whether a file naming a live pid from this boot is where the MCP entry points. Not a promise that the shim will connect. */
export interface PortFajl {
  utvonal: string
  letezik: boolean
  elo: boolean
}

export interface Health {
  ok: boolean
  /** Codes that stop every path into the mailbox. */
  hibak: HealthItem[]
  /** Codes that narrow one capability and block nothing else. Never folded into `hibak`. */
  figyelmeztetesek: HealthItem[]
  /** Questions that could not be put or were not answered. Their absence from `hibak` is not a pass. */
  nemValaszolt: NemValaszolt[]
  blokkolt: string[]
  /** The connected mailbox address, or null when nothing answered the profile read. */
  postafiok: string | null
  keretek: Keretek
  szamok: Szamok
  portFajl: PortFajl
}

/**
 * One outbound row as the page reads it: the whole row, body and resolved
 * addresses included, which is deliberately wider than the contract's
 * projection. The operator has to read what is about to go out and see who it
 * goes to, and neither may cross a door whose caller cannot be identified.
 */
export interface KimenoSor {
  id: string
  allapot: string
  ajto: string
  cimzettHandlek: string[]
  cimzettCimek: string[]
  valaszUzenetId: string
  targy: string
  torzs: string
  torzsHash: string
  gmailDraftId: string
  gmailMessageId: string
  szerkesztveAt: string
  konyvonKivul: string[]
  kiadvaAt: string
  hibaKod: string
  hibaSzoveg: string
  createdAt: string
  updatedAt: string
}

/** One address book entry. `visszavontAt` is kept rather than deleted: an outbound row that named the handle stays readable. */
export interface KonyvSor {
  handle: string
  cim: string
  megjegyzes: string
  createdAt: string
  visszavontAt: string | null
}

export interface Board {
  health: Health
  kimeno: { total: number; count: number; items: KimenoSor[] }
  kimenoLimit: number
  konyv: KonyvSor[]
}

/**
 * The draft AS IT STANDS IN GMAIL, with the fingerprint the release checks.
 *
 * `eloHash` is what the page sends back as `megerosites`, and `torzs` is what
 * it must display beside it: showing the row's body and confirming the live
 * hash would send bytes nobody read.
 */
export interface LiveDraft {
  kimenoId: string
  gmailDraftId: string
  cimek: string
  targy: string
  torzs: string
  eloHash: string
  sorHash: string
  szerkesztve: boolean
}

/** What a release answers with when the letter went out. */
export interface KiadasEredmeny {
  kimenoId: string
  gmailMessageId: string
  kiadvaAt: string
  szerkesztve: boolean
  konyvonKivul: string[]
  torzsHash: string
}

/** One refused outbound attempt. `mit` is somebody else's text and the page labels it as such. */
export interface Kiserlet {
  id: string
  ajto: string
  kod: string
  mit: string
  at: string
}

export interface Kiserletek {
  items: Kiserlet[]
  limit: number
}

/** The Settings > MCP Servers entry, for the operator to copy as text. */
export interface McpConfig {
  id: string
  name: string
  transport: string
  command: string
  args: string[]
  env: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(method: string, field: string): never {
  throw new Error(`a ${method} válaszából hiányzik a ${field} mező`)
}

/**
 * A refusal `src/rpc.mjs` answered with, as a throw that still carries the
 * code.
 *
 * The code is what the page branches on -- `gmail_kiadas_bizonytalan` is the
 * one release outcome that is neither a success nor a failure, and it has to
 * reach the operator with its own sentence rather than as one more red line.
 * `extra` carries whatever else the refusal named (the row's id, the handle,
 * the day's budget) and is rendered as text.
 */
export class RpcRefusal extends Error {
  readonly code: string
  readonly extra: Record<string, unknown>

  constructor(code: string, message: string, extra: Record<string, unknown>) {
    super(message)
    this.name = 'RpcRefusal'
    this.code = code
    this.extra = extra
  }
}

/**
 * The response body, or a throw.
 *
 * Three outcomes, and the middle one is why this function exists: a shape this
 * page cannot read, a refusal the server named, and an answer. A refusal
 * arrives as a 200 with an `error` object (see `guard` in src/hibak.mjs), so
 * without this every reader below would walk into it and report the first
 * field it lacks -- turning "today's release budget is spent" into "a board
 * válaszából hiányzik a health mező".
 */
export function unwrap(method: string, raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) refuse(method, method)
  const error = raw.error
  if (isRecord(error) && typeof error.code === 'string') {
    const { code, message, ...extra } = error
    throw new RpcRefusal(code, typeof message === 'string' && message !== '' ? message : code, extra)
  }
  return raw
}

function readArray<T>(method: string, record: Record<string, unknown>, field: string): T[] {
  const value = record[field]
  if (!Array.isArray(value)) refuse(method, field)
  return value as T[]
}

function readRecordField(method: string, record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field]
  if (!isRecord(value)) refuse(method, field)
  return value
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  return typeof value === 'string' ? value : ''
}

function readNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * One budget. `keret: null` is not a missing field: it is what the server
 * sends when the setting is present and cannot be read, and the page prints
 * the reason rather than the default -- the default is a number the next
 * refusal would not honour.
 */
function readKeret(method: string, record: Record<string, unknown>, field: string): Keret {
  const value = readRecordField(method, record, field)
  return {
    mai: readNumber(value, 'mai') ?? 0,
    keret: readNumber(value, 'keret'),
    olvashatatlan: value.olvashatatlan === true,
  }
}

/**
 * The `health` block, or a thrown error naming the first list it lacks.
 *
 * All four lists are required because the page keeps them apart: `hibak`
 * blocks, `figyelmeztetesek` narrows, `blokkolt` names what is stopped right
 * now and `nemValaszolt` names what nobody could answer. A missing one would
 * be drawn as an empty one, and an empty `nemValaszolt` reads as "everything
 * was checked" -- exactly the false report the three lists exist to prevent.
 */
export function readHealth(raw: unknown): Health {
  const root = unwrap('health', raw)
  if (typeof root.ok !== 'boolean') refuse('health', 'ok')
  const keretek = readRecordField('health', root, 'keretek')
  const portFajl = readRecordField('health', root, 'portFajl')
  return {
    ok: root.ok,
    hibak: readArray<HealthItem>('health', root, 'hibak'),
    figyelmeztetesek: readArray<HealthItem>('health', root, 'figyelmeztetesek'),
    nemValaszolt: readArray<NemValaszolt>('health', root, 'nemValaszolt'),
    blokkolt: readArray<string>('health', root, 'blokkolt'),
    postafiok: typeof root.postafiok === 'string' ? root.postafiok : null,
    keretek: {
      nap: readString(keretek, 'nap'),
      piszkozat: readKeret('health', keretek, 'piszkozat'),
      kiadas: readKeret('health', keretek, 'kiadas'),
    },
    szamok: readRecordField('health', root, 'szamok') as unknown as Szamok,
    portFajl: {
      utvonal: readString(portFajl, 'utvonal'),
      letezik: portFajl.letezik === true,
      elo: portFajl.elo === true,
    },
  }
}

/**
 * The `board` response, or a thrown error naming the first field it lacks.
 *
 * `konyv` is required and never defaulted to an empty list: the Recipients
 * view is the only read of the address book on this page, and a board that
 * failed to carry it would be drawn as an install with no recipients -- which
 * is the state that also blocks drafting to a handle, and would send the
 * operator to add an entry that is already there.
 */
export function readBoard(raw: unknown): Board {
  const root = unwrap('board', raw)
  const kimeno = readRecordField('board', root, 'kimeno')
  return {
    health: readHealth(root.health),
    kimeno: {
      total: readNumber(kimeno, 'total') ?? 0,
      count: readNumber(kimeno, 'count') ?? 0,
      items: readArray<KimenoSor>('board', kimeno, 'items'),
    },
    kimenoLimit: readNumber(root, 'kimenoLimit') ?? 0,
    konyv: readArray<KonyvSor>('board', root, 'konyv'),
  }
}

/**
 * The `liveDraft` response.
 *
 * `eloHash` and `torzs` are both required and neither is optional: the hash is
 * what the release is confirmed with and the body is what the operator reads
 * before confirming it. A response carrying one without the other would let
 * the page offer a release for bytes it never displayed, which is the single
 * thing this whole method exists to prevent.
 */
export function readLiveDraft(raw: unknown): LiveDraft {
  const root = unwrap('liveDraft', raw)
  if (typeof root.eloHash !== 'string' || root.eloHash === '') refuse('liveDraft', 'eloHash')
  if (typeof root.torzs !== 'string') refuse('liveDraft', 'torzs')
  if (typeof root.szerkesztve !== 'boolean') refuse('liveDraft', 'szerkesztve')
  return {
    kimenoId: readString(root, 'kimenoId'),
    gmailDraftId: readString(root, 'gmailDraftId'),
    cimek: readString(root, 'cimek'),
    targy: readString(root, 'targy'),
    torzs: root.torzs,
    eloHash: root.eloHash,
    sorHash: readString(root, 'sorHash'),
    szerkesztve: root.szerkesztve,
  }
}

/** The `releaseDraft` response. A release that answers without naming the sent message is a shape this page will not report as a send. */
export function readKiadas(raw: unknown): KiadasEredmeny {
  const root = unwrap('releaseDraft', raw)
  if (typeof root.gmailMessageId !== 'string') refuse('releaseDraft', 'gmailMessageId')
  return {
    kimenoId: readString(root, 'kimenoId'),
    gmailMessageId: root.gmailMessageId,
    kiadvaAt: readString(root, 'kiadvaAt'),
    szerkesztve: root.szerkesztve === true,
    konyvonKivul: Array.isArray(root.konyvonKivul) ? (root.konyvonKivul as string[]) : [],
    torzsHash: readString(root, 'torzsHash'),
  }
}

/** The `attempts` response. An empty `items` is a real answer here; a refusal never reaches it, because `unwrap` threw first. */
export function readKiserletek(raw: unknown): Kiserletek {
  const root = unwrap('attempts', raw)
  return {
    items: readArray<Kiserlet>('attempts', root, 'items'),
    limit: readNumber(root, 'limit') ?? 0,
  }
}

/** The `mcpConfig` response. `args` and `env` are required: an entry copied without either would not start the shim. */
export function readMcpConfig(raw: unknown): McpConfig {
  const root = unwrap('mcpConfig', raw)
  const env = readRecordField('mcpConfig', root, 'env')
  const args = readArray<unknown>('mcpConfig', root, 'args')
  const kornyezet: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) kornyezet[key] = typeof value === 'string' ? value : String(value)
  return {
    id: readString(root, 'id'),
    name: readString(root, 'name'),
    transport: readString(root, 'transport'),
    command: readString(root, 'command'),
    args: args.map((arg) => (typeof arg === 'string' ? arg : String(arg))),
    env: kornyezet,
  }
}

/** One book entry as `addRecipient` and `retireRecipient` answer with it. */
export function readKonyvSor(method: string, raw: unknown): KonyvSor {
  const root = unwrap(method, raw)
  if (typeof root.handle !== 'string' || root.handle === '') refuse(method, 'handle')
  if (typeof root.cim !== 'string') refuse(method, 'cim')
  return {
    handle: root.handle,
    cim: root.cim,
    megjegyzes: readString(root, 'megjegyzes'),
    createdAt: readString(root, 'createdAt'),
    visszavontAt: typeof root.visszavontAt === 'string' && root.visszavontAt !== '' ? root.visszavontAt : null,
  }
}

/**
 * The text of a failure, whatever the rpc layer threw.
 *
 * A refusal keeps its code in front of its message: the code is the word the
 * operator will search for and the one the module's own vocabulary is written
 * in, and a message alone would lose it.
 */
export function errorText(err: unknown): string {
  if (err instanceof RpcRefusal) return `${err.code}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

/** The refusal code behind a failure, or null for anything that was not one. */
export function errorCode(err: unknown): string | null {
  return err instanceof RpcRefusal ? err.code : null
}

/**
 * A sentence the page says about something that just happened, and how loudly.
 *
 * IT LIVES ON THE PAGE, NOT IN THE VIEW THAT PRODUCED IT, and that placement
 * is the whole reason this type is here rather than being local state. The
 * queue and the book are keyed on the board's load counter, so a successful
 * write remounts them -- which is deliberate, because an open release panel
 * holding a confirmation hash must not survive a reload. Message state kept
 * inside that subtree is destroyed by the same remount, and a browser pass
 * caught exactly that: a letter went out and the page said nothing at all,
 * because the refresh that followed the send wiped the sentence reporting it.
 * The one write in this system that cannot be undone must be the one whose
 * outcome is hardest to miss.
 */
export interface Uzenet {
  text: string
  kind: 'plain' | 'warn' | 'bad'
}
