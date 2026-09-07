/**
 * What the calendar page sends to and receives from `src/rpc.mjs`, typed on
 * this side.
 *
 * THE READING DISCIPLINE, copied from `extensions/video/ui/api.ts` (the CRM
 * copy of this file is a plainer skeleton and does not carry it): every
 * `read*` function below checks the shape of what came back before a
 * component sees it, and a response missing a field this page reads is
 * refused BY NAME rather than drawn as an empty page. A load that failed and
 * a load that genuinely found nothing are two different facts -- an empty
 * `kiadasok` list is "no releases yet", a response with no `kiadasok` field
 * at all is "the module answered something this page cannot read", and
 * folding the second into the first would draw an empty calendar over a
 * broken load, which is exactly the shape constraints.md's "elutasítás
 * megnevezett" rule forbids one layer up.
 *
 * WHAT IS IN THESE ROWS. `cim` and `narracioSzoveg` (the `kiadas` response)
 * are the video's own title and narration, carried through byte for byte; a
 * branch's `szoveg.cim`/`szoveg.leiras` is what the writer agent wrote for
 * one platform; a `talalatok` entry's `szoveg` is what the reviewer agent
 * wrote about it. None of it is this file's to interpret -- every component
 * in `ui/` renders those fields as React text children, and the one url this
 * page can reach an `href` with goes through `./safe-href`.
 */

export type Rpc = (method: string, args?: Record<string, unknown>) => Promise<unknown>

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(method: string, field: string): never {
  throw new Error(`a ${method} válaszából hiányzik a ${field} mező`)
}

function readRoot(method: string, raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) refuse(method, method)
  return raw
}

function readArray<T>(method: string, record: Record<string, unknown>, field: string): T[] {
  const value = record[field]
  if (!Array.isArray(value)) refuse(method, field)
  return value as T[]
}

function readString(method: string, record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') refuse(method, field)
  return value
}

/**
 * `null` is a value the module means (no override, no dispatch yet, no
 * account) and is read through; a KEY THAT IS SIMPLY ABSENT is a different
 * fact -- `src/rpc.mjs` always sends this field, even as `null`, so a
 * response missing the key entirely is a shape this page cannot read, not
 * an unset value. `field in record` is what tells the two apart: plain
 * `record[field] === undefined` cannot, since JavaScript reads an absent key
 * and an explicit `undefined` value the same way.
 */
function readStringOrNull(method: string, record: Record<string, unknown>, field: string): string | null {
  if (!(field in record)) refuse(method, field)
  const value = record[field]
  if (value === null) return null
  if (typeof value !== 'string') refuse(method, field)
  return value
}

function readBoolean(method: string, record: Record<string, unknown>, field: string): boolean {
  const value = record[field]
  if (typeof value !== 'boolean') refuse(method, field)
  return value
}

function readNumber(method: string, record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse(method, field)
  return value
}

// --- naptar --------------------------------------------------------------

/** A release's branch flag, exactly design spec 8's four words: `var`/`kesz`/`hiba`/`nincs_fiok`. Never the release's own computed outcome -- `src/rpc.mjs`'s `naptar` method never sends that, and this reader has nothing to derive it from either. */
export interface AgJelzo {
  platform: string
  allapot: string
  url: string | null
}

function readAgJelzo(method: string, raw: unknown): AgJelzo {
  if (!isRecord(raw)) refuse(method, 'agak')
  return {
    platform: readString(method, raw, 'platform'),
    allapot: readString(method, raw, 'allapot'),
    url: readStringOrNull(method, raw, 'url'),
  }
}

/** One calendar entry: the STORED workflow/outcome column (`allapot`), never a value this page computed itself -- see `ui/naptar.tsx`'s own docblock for why. */
export interface NaptarKiadas {
  kiadasId: string
  videoId: string
  allapot: string
  idopont: string | null
  felulirtIdopont: string | null
  savId: string | null
  agak: AgJelzo[]
}

function readNaptarKiadas(raw: unknown): NaptarKiadas {
  if (!isRecord(raw)) refuse('naptar', 'kiadasok')
  const agak = readArray<unknown>('naptar', raw, 'agak').map((a) => readAgJelzo('naptar', a))
  return {
    kiadasId: readString('naptar', raw, 'kiadasId'),
    videoId: readString('naptar', raw, 'videoId'),
    allapot: readString('naptar', raw, 'allapot'),
    idopont: readStringOrNull('naptar', raw, 'idopont'),
    felulirtIdopont: readStringOrNull('naptar', raw, 'felulirtIdopont'),
    savId: readStringOrNull('naptar', raw, 'savId'),
    agak,
  }
}

export interface Sav {
  id: string
  nap: number
  ora: number
  perc: number
}

function readSav(raw: unknown): Sav {
  if (!isRecord(raw)) refuse('naptar', 'savok')
  return {
    id: readString('naptar', raw, 'id'),
    nap: readNumber('naptar', raw, 'nap'),
    ora: readNumber('naptar', raw, 'ora'),
    perc: readNumber('naptar', raw, 'perc'),
  }
}

export interface NaptarAdat {
  idozona: string
  savok: Sav[]
  kiadasok: NaptarKiadas[]
}

export function readNaptar(raw: unknown): NaptarAdat {
  const root = readRoot('naptar', raw)
  const savok = readArray<unknown>('naptar', root, 'savok').map(readSav)
  const kiadasok = readArray<unknown>('naptar', root, 'kiadasok').map(readNaptarKiadas)
  const idozona = readString('naptar', root, 'idozona')
  return { idozona, savok, kiadasok }
}

// --- kiadas (detail) -------------------------------------------------------

/**
 * One branch's platform text, exactly as `olvasSzoveg` (src/szoveg.mjs)
 * projects it: `cim` and `leiras` are INDEPENDENTLY nullable, because that
 * function reads each key off the stored JSON on its own and answers `null`
 * for whichever one is not a string. A writer that wrote a title and lost its
 * session before the description is a real state this page has to be able to
 * draw as itself.
 */
export interface AgSzoveg {
  cim: string | null
  leiras: string | null
}

/**
 * "This branch has no text yet" is `null` -- the value `src/rpc.mjs` sends for
 * a branch whose `szoveg` column is null -- and nothing else is.
 *
 * THE EARLIER VERSION OF THIS FUNCTION COLLAPSED THREE FACTS INTO ONE. It
 * returned `null` for any shape it did not recognise, so `{ cim: 'x' }` (a
 * half-written draft, which the module stores and `olvasSzoveg` projects as
 * `{ cim: 'x', leiras: null }`) and a response this page genuinely cannot
 * read both drew as "Ehhez a platformhoz még nincs megírt szöveg." -- the
 * exact conflation this file's own docblock forbids one level up ("a load
 * that failed and a load that genuinely found nothing are two different
 * facts"), and it hid the operator's half-written title behind a sentence
 * saying nothing had been written at all.
 *
 * So: `null` is read through, a record is read field by field with each half
 * independently nullable, and ANY other shape is refused BY NAME like every
 * other reader here.
 */
function readAgSzoveg(raw: unknown): AgSzoveg | null {
  if (raw === null) return null
  if (!isRecord(raw)) refuse('kiadas', 'szoveg')
  return {
    cim: readStringOrNull('kiadas', raw, 'cim'),
    leiras: readStringOrNull('kiadas', raw, 'leiras'),
  }
}

export interface AgReszlet extends AgJelzo {
  hibaKod: string | null
  kikuldveAt: string | null
  szoveg: AgSzoveg | null
}

function readAgReszlet(raw: unknown): AgReszlet {
  if (!isRecord(raw)) refuse('kiadas', 'agak')
  // `in`, not `raw.szoveg === undefined`: an absent key is a response shape
  // this page cannot read, and an explicit `null` is the module saying "no
  // text on this branch". The same distinction `readStringOrNull` above draws,
  // for the same reason.
  if (!('szoveg' in raw)) refuse('kiadas', 'szoveg')
  return {
    platform: readString('kiadas', raw, 'platform'),
    allapot: readString('kiadas', raw, 'allapot'),
    url: readStringOrNull('kiadas', raw, 'url'),
    hibaKod: readStringOrNull('kiadas', raw, 'hibaKod'),
    kikuldveAt: readStringOrNull('kiadas', raw, 'kikuldveAt'),
    szoveg: readAgSzoveg(raw.szoveg),
  }
}

export interface Talalat {
  platform: string
  kod: string
  szoveg: string
}

function readTalalat(raw: unknown): Talalat {
  if (!isRecord(raw)) refuse('kiadas', 'talalatok')
  return {
    platform: readString('kiadas', raw, 'platform'),
    kod: readString('kiadas', raw, 'kod'),
    szoveg: readString('kiadas', raw, 'szoveg'),
  }
}

export interface KiadasReszlet {
  kiadasId: string
  videoId: string
  allapot: string
  idopont: string | null
  felulirtIdopont: string | null
  savId: string | null
  cim: string | null
  narracioSzoveg: string | null
  /** The video contract call's own refusal sentence, or null. A release's texts and branch state must still draw when this is set -- see `src/rpc.mjs`'s `kiadas` method docblock. */
  videoHiba: string | null
  agak: AgReszlet[]
  talalatok: Talalat[]
}

export function readKiadas(raw: unknown): KiadasReszlet {
  const root = readRoot('kiadas', raw)
  return {
    kiadasId: readString('kiadas', root, 'kiadasId'),
    videoId: readString('kiadas', root, 'videoId'),
    allapot: readString('kiadas', root, 'allapot'),
    idopont: readStringOrNull('kiadas', root, 'idopont'),
    felulirtIdopont: readStringOrNull('kiadas', root, 'felulirtIdopont'),
    savId: readStringOrNull('kiadas', root, 'savId'),
    cim: readStringOrNull('kiadas', root, 'cim'),
    narracioSzoveg: readStringOrNull('kiadas', root, 'narracioSzoveg'),
    videoHiba: readStringOrNull('kiadas', root, 'videoHiba'),
    agak: readArray<unknown>('kiadas', root, 'agak').map(readAgReszlet),
    talalatok: readArray<unknown>('kiadas', root, 'talalatok').map(readTalalat),
  }
}

// --- fiokok ------------------------------------------------------------

export interface Fiok {
  id: string
  platform: string
  kulsoId: string
  nev: string
  csatlakoztatvaAt: string
}

function readFiok(raw: unknown): Fiok {
  if (!isRecord(raw)) refuse('fiokok', 'fiokok')
  return {
    id: readString('fiokok', raw, 'id'),
    platform: readString('fiokok', raw, 'platform'),
    kulsoId: readString('fiokok', raw, 'kulsoId'),
    nev: readString('fiokok', raw, 'nev'),
    csatlakoztatvaAt: readString('fiokok', raw, 'csatlakoztatvaAt'),
  }
}

export interface FiokokAdat {
  fiokok: Fiok[]
  platformok: string[]
  googleKliensVan: boolean
}

export function readFiokok(raw: unknown): FiokokAdat {
  const root = readRoot('fiokok', raw)
  const platformok = readArray<unknown>('fiokok', root, 'platformok').map((p, i) => {
    if (typeof p !== 'string') refuse('fiokok', `platformok[${i}]`)
    return p
  })
  return {
    fiokok: readArray<unknown>('fiokok', root, 'fiokok').map(readFiok),
    platformok,
    googleKliensVan: readBoolean('fiokok', root, 'googleKliensVan'),
  }
}

// --- levers: jovahagy, atutemez, fiokotOsszekot --------------------------

/**
 * The refusal carried by a lever's answer, named, or null when the answer is
 * the act having happened.
 *
 * `jovahagy`, `atutemez` and `fiokotOsszekot` (`src/rpc.mjs`) RESOLVE with
 * their refusals instead of throwing them -- modelled on
 * `extensions/video/ui/api.ts`'s `refusalText`, for the identical reason: a
 * thrown refusal reaches the browser as a 500 whose sentence the page never
 * gets to read, and each of these three is a button the operator presses in
 * exactly the states this module refuses.
 *
 * The code comes first, the module's own sentence after it: the code is what
 * the operator can look up and quote, and "sikertelen" is the word this page
 * must never print in its place.
 */
export function refusalText(raw: unknown): string | null {
  if (!isRecord(raw)) return 'valasz_ervenytelen: a modul nem objektummal válaszolt erre a hívásra'
  if (typeof raw.hiba !== 'string' || raw.hiba === '') return null
  const uzenet = typeof raw.uzenet === 'string' && raw.uzenet !== '' ? raw.uzenet : null
  return uzenet === null ? `${raw.hiba} (a modul nem küldött hozzá mondatot)` : `${raw.hiba}: ${uzenet}`
}

// --- transport -------------------------------------------------------------

/** An rpc call bound to this page's own extension id. Copied from `extensions/crm/ui/api.ts`. */
export function makeRpc(extensionId: string): Rpc {
  return async (method, args = {}) => {
    const res = await fetch(`/api/extensions/${extensionId}/call/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(bodyErrorText(body) || `publish: ${method} — HTTP ${res.status}`)
    return body
  }
}

/**
 * The host rpc route's own failure shape (`{ error: { code, message },
 * message }`, `src/app/api/extensions/[id]/call/[method]/route.ts`'s
 * `rpcFailure`) reduced to one sentence. Both halves are checked -- an
 * `error` that is a plain string (a small number of callers send that shape)
 * and the object shape, falling back to the top-level `message` -- else every
 * named refusal from this route would vanish behind a bare HTTP status.
 */
function bodyErrorText(body: unknown): string {
  if (!isRecord(body)) return ''
  if (typeof body.error === 'string' && body.error) return body.error
  if (isRecord(body.error) && typeof body.error.message === 'string' && body.error.message) return body.error.message
  return typeof body.message === 'string' ? body.message : ''
}

/** The text of a failure from a REJECTED promise -- a request that never reached the module at all, the third fact `refusalText` does not cover. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
