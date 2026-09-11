/**
 * What the page sends to and receives from `src/rpc.mjs`, typed on this side.
 *
 * WHAT IS IN THESE FIELDS. A document's title and body are whatever a person or
 * an agent wrote, and a search snippet is a slice of that text. Every layer
 * below leaves all of it alone on purpose, so the decision about display is
 * made where the text is displayed: that is here, and every component in this
 * directory renders these fields as React text children. Nothing is passed to
 * `dangerouslySetInnerHTML` except the editor's own converted markdown, which
 * goes through the sanitiser in `markdown.ts` first.
 *
 * WHY THE READERS REFUSE. A response that is missing a list the page reads is
 * refused by name rather than drawn as an empty pane. "No documents" and "the
 * question could not be answered" are different facts, and the page has to say
 * which one it is looking at.
 */

export type Rpc = (method: string, body?: object) => Promise<unknown>

export interface DocRow {
  id: string
  cim: string
  utvonal: string
  tulajdonos: string
  frissitve: string
  tagek: string[]
}

export interface Fa {
  gyoker: string
  kozosMappaNev: string
  mappak: string[]
  doksik: DocRow[]
  cimek: string[]
}

export interface Doc {
  id: string
  cim: string
  utvonal: string
  tulajdonos: string
  tagek: string[]
  letrehozva: string
  frissitve: string
  verzio: number
  tartalom: string
}

export interface Talalat {
  id: string
  path: string
  title: string
  reszlet: string
}

export interface Verzio {
  version: number
  author: string
  createdAt: string
  meret: number
}

export interface Backlink {
  fromId: string
  path: string
  title: string
  toRaw: string
}

export interface KukaElem {
  id: string
  cim: string
  utvonal: string
  torolve: string
}

export interface Allapot {
  gyoker: string
  beallitottGyoker: string
  gyokerRendben: boolean
  gyokerHiba: string | null
  figyeloFut: boolean
  figyeloHiba: string | null
  doksiSzam: number
  kozosMappaNev: string
}

export interface Utkozes {
  error: 'conflict'
  message: string
  jelenlegiVerzio: number
  modositotta: string | null
  ovek: string | null
}

/** The `{ error, message }` shape every handler answers a failure with. */
export function errorText(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.error !== 'string') return null
  return typeof rec.message === 'string' ? rec.message : rec.error
}

export function isConflict(raw: unknown): raw is Utkozes {
  return Boolean(raw) && typeof raw === 'object' && (raw as Record<string, unknown>).error === 'conflict'
}

function fail(method: string, why: string): never {
  throw new Error(`A(z) "${method}" válasza olvashatatlan: ${why}`)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function docRow(raw: unknown): DocRow {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(r.id),
    cim: str(r.cim),
    utvonal: str(r.utvonal),
    tulajdonos: str(r.tulajdonos),
    frissitve: str(r.frissitve),
    tagek: strList(r.tagek),
  }
}

export function readFa(raw: unknown): Fa {
  const message = errorText(raw)
  if (message) throw new Error(message)
  const r = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(r.doksik)) fail('fa', 'nincs benne doksi-lista')
  if (!Array.isArray(r.mappak)) fail('fa', 'nincs benne mappalista')
  return {
    gyoker: str(r.gyoker),
    kozosMappaNev: str(r.kozosMappaNev, 'kozos'),
    mappak: strList(r.mappak),
    doksik: r.doksik.map(docRow),
    cimek: strList(r.cimek),
  }
}

export function readDoc(raw: unknown): Doc {
  const message = errorText(raw)
  if (message) throw new Error(message)
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.verzio !== 'number') fail('olvas', 'nincs benne id vagy verzió')
  return {
    id: r.id,
    cim: str(r.cim),
    utvonal: str(r.utvonal),
    tulajdonos: str(r.tulajdonos),
    tagek: strList(r.tagek),
    letrehozva: str(r.letrehozva),
    frissitve: str(r.frissitve),
    verzio: r.verzio,
    tartalom: str(r.tartalom),
  }
}

export function readAllapot(raw: unknown): Allapot {
  const message = errorText(raw)
  if (message) throw new Error(message)
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    gyoker: str(r.gyoker),
    beallitottGyoker: str(r.beallitottGyoker),
    gyokerRendben: Boolean(r.gyokerRendben),
    gyokerHiba: typeof r.gyokerHiba === 'string' ? r.gyokerHiba : null,
    figyeloFut: Boolean(r.figyeloFut),
    figyeloHiba: typeof r.figyeloHiba === 'string' ? r.figyeloHiba : null,
    doksiSzam: typeof r.doksiSzam === 'number' ? r.doksiSzam : 0,
    kozosMappaNev: str(r.kozosMappaNev, 'kozos'),
  }
}

export function readList<T>(method: string, key: string, raw: unknown, map: (item: unknown) => T): T[] {
  const message = errorText(raw)
  if (message) throw new Error(message)
  const r = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(r[key])) fail(method, `nincs benne "${key}" lista`)
  return (r[key] as unknown[]).map(map)
}

export const readTalalat = (raw: unknown): Talalat => {
  const r = (raw ?? {}) as Record<string, unknown>
  return { id: str(r.id), path: str(r.path), title: str(r.title), reszlet: str(r.reszlet) }
}

export const readVerzio = (raw: unknown): Verzio => {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    version: typeof r.version === 'number' ? r.version : 0,
    author: str(r.author),
    createdAt: str(r.createdAt),
    meret: typeof r.meret === 'number' ? r.meret : 0,
  }
}

export const readBacklink = (raw: unknown): Backlink => {
  const r = (raw ?? {}) as Record<string, unknown>
  return { fromId: str(r.fromId), path: str(r.path), title: str(r.title), toRaw: str(r.toRaw) }
}

export const readKukaElem = (raw: unknown): KukaElem => {
  const r = (raw ?? {}) as Record<string, unknown>
  return { id: str(r.id), cim: str(r.cim), utvonal: str(r.utvonal), torolve: str(r.torolve) }
}
