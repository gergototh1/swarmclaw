import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DocsError, HIBA } from './errors.mjs'

/** Hex SHA-256. The only identity a file's content has in this module. */
export function hashOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** A fresh document id. Short enough to type, wide enough not to collide. */
export function newDocId() {
  return `doc_${crypto.randomBytes(4).toString('hex')}`
}

const FM_OPEN = '---\n'
const FM_CLOSE = '\n---\n'

/**
 * A document's front matter and its body.
 *
 * A deliberately tiny YAML subset -- a handful of known keys, scalars and one
 * list -- rather than a YAML dependency. Everything this module writes goes out
 * through `serializeDoc`, so the only inputs that can be anything else are
 * files a person or another tool wrote. For those the rule is: if it does not
 * parse as this subset, it is not front matter, and the whole file is body.
 *
 * Nothing is ever dropped. A document whose header we could not read gets a
 * fresh one written above it by the indexer, which is visible and reversible;
 * a silently discarded first paragraph would be neither.
 */
export function parseFrontMatter(raw) {
  if (!raw.startsWith(FM_OPEN)) return { meta: {}, body: raw }
  const end = raw.indexOf(FM_CLOSE, FM_OPEN.length - 1)
  if (end === -1) return { meta: {}, body: raw }
  const block = raw.slice(FM_OPEN.length, end + 1)
  const body = raw.slice(end + FM_CLOSE.length)
  const meta = {}
  for (const line of block.split('\n')) {
    if (line.trim() === '') continue
    // A leading space means a nested or continued value, which this subset does
    // not have; treating the file as bodyless-header is safer than guessing.
    if (/^\s/.test(line)) return { meta: {}, body: raw }
    const colon = line.indexOf(':')
    if (colon <= 0) return { meta: {}, body: raw }
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'tags') {
      if (!value.startsWith('[') || !value.endsWith(']')) return { meta: {}, body: raw }
      const inner = value.slice(1, -1).trim()
      meta.tags = inner === '' ? [] : splitList(inner).map(unquote)
      continue
    }
    meta[key] = unquote(value)
  }
  return { meta, body }
}

/**
 * Splits a bracketed list on commas that are not inside quotes.
 *
 * A plain `split(',')` would cut a tag that legitimately contains one, and
 * `quote()` below emits such a tag quoted precisely so it can survive.
 */
function splitList(inner) {
  const out = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]
    if (inQuotes && char === '\\' && i + 1 < inner.length) {
      field += char + inner[i + 1]
      i += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      field += char
      continue
    }
    if (char === ',' && !inQuotes) {
      out.push(field.trim())
      field = ''
      continue
    }
    field += char
  }
  out.push(field.trim())
  return out
}

/** Strips the quotes `quote()` adds, and unescapes what it escaped. */
function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return value
}

/** Quotes a scalar when it could otherwise be misread on the way back in. */
function quote(value) {
  const text = String(value)
  if (text === '' || /[:#[\]{}",\n]/.test(text) || text !== text.trim()) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return text
}

/** The file's bytes: a front matter block, then the body. */
export function serializeDoc(meta, body) {
  const lines = []
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue
    lines.push(key === 'tags' ? `tags: [${value.map(quote).join(', ')}]` : `${key}: ${quote(value)}`)
  }
  const normalizedBody = body.endsWith('\n') || body === '' ? body : `${body}\n`
  return `${FM_OPEN}${lines.join('\n')}${FM_CLOSE}${normalizedBody}`
}

/**
 * The disk, bounded to one root.
 *
 * Every public method takes or returns a *root-relative* path with '/'
 * separators, and `abs()` is the only place a relative path becomes an absolute
 * one. That is the point: there is exactly one function to read to know that
 * nothing here can touch a file outside the root, and exactly one test to pin
 * it.
 *
 * The root itself is resolved through `realpathSync` when it exists, because a
 * root that is itself a symlink is ordinary on macOS -- /tmp is one -- and
 * without this every later containment check against it would fail.
 */
export function createVault({ root }) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new DocsError(
      HIBA.gyoker_nem_irhato,
      'A doksi-gyökér nincs beállítva. Add meg a Doksik extension beállításainál.',
    )
  }
  const expanded = root.startsWith('~/') ? path.join(os.homedir(), root.slice(2)) : root
  const resolved = path.resolve(expanded)
  const realRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved

  /**
   * The absolute path of a root-relative one, or a throw.
   *
   * Two separate checks, because they catch different things. The lexical one
   * catches '..' and absolute inputs before any syscall. The realpath one
   * catches a symlink *inside* the root that points out of it: lexically such a
   * path is fine, and only the filesystem can say where it actually lands. The
   * second check walks up to the nearest existing ancestor, because the target
   * of a write does not exist yet.
   */
  function abs(rel) {
    if (typeof rel !== 'string') throw new DocsError(HIBA.utvonal_tiltott, 'Az útvonal nem szöveg.')
    const joined = path.resolve(realRoot, rel)
    const relative = path.relative(realRoot, joined)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new DocsError(HIBA.utvonal_tiltott, `Ez az útvonal kilépne a doksi-gyökérből: ${rel}`)
    }
    let probe = joined
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    if (fs.existsSync(probe)) {
      const realRelative = path.relative(realRoot, fs.realpathSync(probe))
      if (realRelative !== '' && (realRelative.startsWith('..') || path.isAbsolute(realRelative))) {
        throw new DocsError(HIBA.utvonal_tiltott, `Ez az útvonal a doksi-gyökéren kívülre mutat: ${rel}`)
      }
    }
    return joined
  }

  /** The root-relative form of an absolute path, always with '/' separators. */
  function rel(absPath) {
    return path.relative(realRoot, absPath).split(path.sep).join('/')
  }

  /** The root exists and we can write into it, or a named throw. */
  function ensureRoot() {
    try {
      fs.mkdirSync(realRoot, { recursive: true })
      fs.accessSync(realRoot, fs.constants.W_OK)
    } catch {
      throw new DocsError(
        HIBA.gyoker_nem_irhato,
        `A doksi-gyökér nem hozható létre vagy nem írható: ${realRoot}`,
      )
    }
  }

  function exists(relPath) {
    return fs.existsSync(abs(relPath))
  }

  function readDoc(relPath) {
    const target = abs(relPath)
    let raw
    try {
      raw = fs.readFileSync(target, 'utf8')
    } catch {
      throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen doksi: ${relPath}`)
    }
    const { meta, body } = parseFrontMatter(raw)
    return { meta, body, raw, size: Buffer.byteLength(raw), hash: hashOf(raw) }
  }

  /**
   * Write, atomically.
   *
   * A temp file in the same directory and then `rename`, which is atomic within
   * one filesystem: a reader sees either the whole old file or the whole new
   * one, never a half-written document. Same directory matters -- a rename
   * across filesystems is a copy, and copies are not atomic. The temp name
   * carries a random suffix so two concurrent writes cannot collide on it.
   */
  function writeDoc(relPath, { meta, body }) {
    const target = abs(relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const raw = serializeDoc(meta, body)
    const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      fs.writeFileSync(tmp, raw, 'utf8')
      fs.renameSync(tmp, target)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }
    return { raw, size: Buffer.byteLength(raw), hash: hashOf(raw) }
  }

  /** Every .md under the root, root-relative, with `.swarmdocs/` skipped. */
  function listDocs() {
    const found = []
    const walk = (dirRel) => {
      const dirAbs = dirRel === '' ? realRoot : abs(dirRel)
      for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
        if (entry.name === '.swarmdocs') continue
        const childRel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`
        if (entry.isDirectory()) walk(childRel)
        else if (entry.isFile() && entry.name.endsWith('.md')) found.push(childRel)
      }
    }
    if (fs.existsSync(realRoot)) walk('')
    return found
  }

  /** Creates a folder, so that an empty one can exist before it has a file. */
  function mkdirp(relDir) {
    fs.mkdirSync(abs(relDir), { recursive: true })
  }

  function move(fromRel, toRel) {
    const from = abs(fromRel)
    const to = abs(toRel)
    if (fs.existsSync(to)) {
      throw new DocsError(HIBA.mar_letezik, `Ezen az útvonalon már van doksi: ${toRel}`)
    }
    if (!fs.existsSync(from)) {
      throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen doksi: ${fromRel}`)
    }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  }

  /**
   * Into the trash, keyed by document id.
   *
   * A directory per id rather than one flat folder, so two documents that had
   * the same file name in different folders do not collide once both are in the
   * trash, and so restoring needs to know nothing but the id.
   */
  function trash(relPath, id) {
    const trashRel = `.swarmdocs/trash/${id}/${path.basename(relPath)}`
    const to = abs(trashRel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(abs(relPath), to)
    return { trashRel }
  }

  /**
   * Deletes for good.
   *
   * Only the trash operation and the operator's own purge reach this; ordinary
   * deletion is `trash()`, which keeps the bytes. Removes the id's directory
   * rather than the single file so the trash does not accumulate empty folders.
   */
  function remove(relPath) {
    const target = abs(relPath)
    fs.rmSync(target, { force: true })
    const dir = path.dirname(target)
    if (dir !== realRoot && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir)
    }
  }

  return { root: realRoot, abs, rel, ensureRoot, exists, readDoc, writeDoc, listDocs, mkdirp, move, trash, remove }
}
