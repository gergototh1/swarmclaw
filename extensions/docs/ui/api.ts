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
  title: string
  path: string
  owner: string
  updated: string
  tags: string[]
}

export interface Tree {
  root: string
  sharedFolderName: string
  folders: string[]
  docs: DocRow[]
  titles: string[]
}

export interface Doc {
  id: string
  title: string
  path: string
  owner: string
  tags: string[]
  created: string
  updated: string
  version: number
  content: string
}

export interface SearchHit {
  id: string
  path: string
  title: string
  snippet: string
}

export interface Version {
  version: number
  author: string
  createdAt: string
  size: number
}

export interface Backlink {
  fromId: string
  path: string
  title: string
  toRaw: string
}

export interface TrashItem {
  id: string
  title: string
  path: string
  deletedAt: string
}

export interface Status {
  root: string
  configuredRoot: string
  rootOk: boolean
  rootError: string | null
  watcherRunning: boolean
  watcherError: string | null
  docCount: number
  sharedFolderName: string
  migrationBlocked: Array<{ from: string; to: string }>
}

export interface Conflict {
  error: 'conflict'
  message: string
  currentVersion: number
  modifiedBy: string | null
  theirs: string | null
}

/** The `{ error, message }` shape every handler answers a failure with. */
export function errorText(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.error !== 'string') return null
  return typeof rec.message === 'string' ? rec.message : rec.error
}

export function isConflict(raw: unknown): raw is Conflict {
  return Boolean(raw) && typeof raw === 'object' && (raw as Record<string, unknown>).error === 'conflict'
}

function fail(method: string, why: string): never {
  throw new Error(`The "${method}" response could not be read: ${why}`)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function migrationBlockedList(value: unknown): Array<{ from: string; to: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => (v ?? {}) as Record<string, unknown>)
    .filter((v): v is Record<string, unknown> => typeof v.from === 'string' && typeof v.to === 'string')
    .map((v) => ({ from: v.from as string, to: v.to as string }))
}

function docRow(raw: unknown): DocRow {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(r.id),
    title: str(r.title),
    path: str(r.path),
    owner: str(r.owner),
    updated: str(r.updated),
    tags: strList(r.tags),
  }
}

export function readTree(raw: unknown): Tree {
  const message = errorText(raw)
  if (message) throw new Error(message)
  const r = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(r.docs)) fail('tree', 'no "docs" list in it')
  if (!Array.isArray(r.folders)) fail('tree', 'no "folders" list in it')
  return {
    root: str(r.root),
    sharedFolderName: str(r.sharedFolderName, 'kozos'),
    folders: strList(r.folders),
    docs: r.docs.map(docRow),
    titles: strList(r.titles),
  }
}

export function readDoc(raw: unknown): Doc {
  const message = errorText(raw)
  if (message) throw new Error(message)
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.version !== 'number') fail('read', 'no "id" or "version" in it')
  return {
    id: r.id,
    title: str(r.title),
    path: str(r.path),
    owner: str(r.owner),
    tags: strList(r.tags),
    created: str(r.created),
    updated: str(r.updated),
    version: r.version,
    content: str(r.content),
  }
}

export function readStatus(raw: unknown): Status {
  const message = errorText(raw)
  if (message) throw new Error(message)
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    root: str(r.root),
    configuredRoot: str(r.configuredRoot),
    rootOk: Boolean(r.rootOk),
    rootError: typeof r.rootError === 'string' ? r.rootError : null,
    watcherRunning: Boolean(r.watcherRunning),
    watcherError: typeof r.watcherError === 'string' ? r.watcherError : null,
    docCount: typeof r.docCount === 'number' ? r.docCount : 0,
    sharedFolderName: str(r.sharedFolderName, 'kozos'),
    migrationBlocked: migrationBlockedList(r.migrationBlocked),
  }
}

export function readList<T>(method: string, key: string, raw: unknown, map: (item: unknown) => T): T[] {
  const message = errorText(raw)
  if (message) throw new Error(message)
  const r = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(r[key])) fail(method, `no "${key}" list in it`)
  return (r[key] as unknown[]).map(map)
}

export const readSearchHit = (raw: unknown): SearchHit => {
  const r = (raw ?? {}) as Record<string, unknown>
  return { id: str(r.id), path: str(r.path), title: str(r.title), snippet: str(r.snippet) }
}

export const readVersion = (raw: unknown): Version => {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    version: typeof r.version === 'number' ? r.version : 0,
    author: str(r.author),
    createdAt: str(r.createdAt),
    size: typeof r.size === 'number' ? r.size : 0,
  }
}

export const readBacklink = (raw: unknown): Backlink => {
  const r = (raw ?? {}) as Record<string, unknown>
  return { fromId: str(r.fromId), path: str(r.path), title: str(r.title), toRaw: str(r.toRaw) }
}

export const readTrashItem = (raw: unknown): TrashItem => {
  const r = (raw ?? {}) as Record<string, unknown>
  return { id: str(r.id), title: str(r.title), path: str(r.path), deletedAt: str(r.deletedAt) }
}
