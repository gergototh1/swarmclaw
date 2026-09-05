import path from 'node:path'

import { DocsError, HIBA } from './errors.mjs'
import { renameLinksTo } from './links.mjs'
import { INTERNAL_FOLDER, TEMPLATES_FOLDER, canWrite, homeFolderOf, ownerOf } from './permissions.mjs'

/**
 * Everything a document can have done to it, once.
 *
 * The agent tools, the page's rpc handlers and the contract other extensions
 * call are three front doors onto the same building. Putting the operations
 * here rather than in any one of them is what keeps a rule -- what a conflict
 * is, where a new document lands, when a version row is written -- from being
 * stated three times and drifting twice.
 *
 * Every method takes an `actor` as its first argument and checks what that
 * actor may write. The actor is always constructed by the caller from what the
 * host said (the session for a tool, the operator for the page, the extension
 * id for a contract) and never from an argument the caller was given.
 *
 * A version row records what the document said *at* that version, not what it
 * said before it. So version 3 is the text of version 3, restoring version 2
 * writes its text as a new version, and a document rescued from the trash gets
 * its text back from the newest row. The alternative -- storing the previous
 * text -- makes every one of those an off-by-one.
 */

/** A conflict carries what the other side has, so one round trip is enough. */
export class ConflictError extends DocsError {
  constructor(message, details) {
    super(HIBA.utkozes, message)
    this.details = details
  }
}

const MAX_SLUG = 60

/** A file name from a title: unaccented, lower case, dash separated. */
export function fileSlug(title) {
  const folded = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '')
  return folded === '' ? 'doksi' : folded
}

export function createService({ vault, writer, repo, sharedFolder, versionsKept, now = () => new Date() }) {
  const opts = () => ({ kozosMappaNev: sharedFolder() })

  function requireRoot() {
    vault.ensureRoot()
  }

  function requireWrite(actor, relPath) {
    if (!canWrite(actor, relPath, opts())) {
      throw new DocsError(
        HIBA.nincs_jog,
        `Ebbe nem írhatsz: ${relPath}. A saját mappádba (${homeFolderOf(actor) ?? '—'}) és a(z) "${sharedFolder()}" mappába írhatsz.`,
      )
    }
  }

  /** The first free path in `folder` for this title. */
  function freePath(folder, title) {
    const base = fileSlug(title)
    const dir = folder === '' ? '' : `${folder}/`
    let candidate = `${dir}${base}.md`
    let n = 2
    while (vault.exists(candidate)) {
      candidate = `${dir}${base}-${n}.md`
      n += 1
    }
    return candidate
  }

  function docOr404(id) {
    const row = repo.getById(id)
    if (!row) throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen doksi: ${id}`)
    return row
  }

  /** Writes the file, indexes it, and records the version. One place. */
  function persist(relPath, meta, body, author) {
    const written = vault.writeDoc(relPath, { meta, body })
    writer.noteSelfWrite(relPath, written.hash)
    const indexed = writer.indexPath(relPath)
    const row = repo.getById(indexed.id)
    repo.addVersion(indexed.id, {
      version: row.version,
      content: body,
      author,
      createdAt: now().toISOString(),
    })
    repo.pruneVersions(indexed.id, versionsKept())
    return { id: indexed.id, utvonal: relPath, verzio: row.version }
  }

  function create(actor, { mappa, cim, tartalom, tagek, sablon } = {}) {
    requireRoot()
    if (typeof cim !== 'string' || cim.trim() === '') {
      throw new DocsError(HIBA.rossz_parameter, 'A "cim" kötelező egy új doksinál.')
    }
    const title = cim.trim()
    const folder = typeof mappa === 'string' && mappa.trim() !== ''
      ? mappa.trim().replace(/^\/+|\/+$/g, '')
      : (homeFolderOf(actor) ?? sharedFolder())

    let body = typeof tartalom === 'string' ? tartalom : ''
    if (typeof sablon === 'string' && sablon.trim() !== '') {
      const templateRel = `${TEMPLATES_FOLDER}/${sablon.trim().replace(/\.md$/, '')}.md`
      if (!vault.exists(templateRel)) {
        throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen sablon: ${sablon}. A sablonok listáját a doksi_lista adja a "${TEMPLATES_FOLDER}" mappára.`)
      }
      body = vault.readDoc(templateRel).body + (body === '' ? '' : `\n${body}`)
    }

    const relPath = freePath(folder, title)
    requireWrite(actor, relPath)
    const stamp = now().toISOString()
    return persist(relPath, {
      id: undefined,
      title,
      owner: ownerOf(actor),
      tags: Array.isArray(tagek) ? tagek : [],
      created: stamp,
      updated: stamp,
    }, body, ownerOf(actor))
  }

  /**
   * Changes a document, but only on top of the version the caller read.
   *
   * `baseVersion` is required rather than optional. Optional, an agent would
   * omit it by default and the check would only fire when one happened to
   * remember -- which is the same as not having the check.
   */
  function update(actor, { id, tartalom, cim, tagek, baseVersion } = {}) {
    requireRoot()
    const row = docOr404(id)
    requireWrite(actor, row.path)
    if (!Number.isInteger(baseVersion)) {
      throw new DocsError(
        HIBA.rossz_parameter,
        'A "baseVersion" kötelező módosításnál. Olvasd be a doksit a doksi_olvas hívással, és add vissza a kapott verziószámot.',
      )
    }
    if (baseVersion !== row.version) {
      const newest = repo.getVersion(id, row.version)
      throw new ConflictError(
        `A doksit közben módosította: ${newest?.author ?? 'valaki más'}. Olvasd újra a doksi_olvas hívással, fésüld össze a változtatásodat, és írd újra az új verziószámmal.`,
        {
          jelenlegiVerzio: row.version,
          modositotta: newest?.author ?? null,
          ovek: newest?.content ?? null,
        },
      )
    }

    const current = vault.readDoc(row.path)
    const title = typeof cim === 'string' && cim.trim() !== '' ? cim.trim() : row.title
    const body = typeof tartalom === 'string' ? tartalom : current.body
    const result = persist(row.path, {
      ...current.meta,
      id: row.id,
      title,
      owner: row.owner,
      tags: Array.isArray(tagek) ? tagek : row.tags,
      created: row.created,
      updated: now().toISOString(),
    }, body, ownerOf(actor))

    if (title !== row.title) {
      result.linkek = renameLinksTo(repo, {
        docId: row.id,
        oldTitle: row.title,
        newTitle: title,
        canWrite: (p) => canWrite(actor, p, opts()),
        readBody: (p) => vault.readDoc(p).body,
        writeBody: (p, newBody) => {
          const referrer = repo.getByPath(p)
          const meta = vault.readDoc(p).meta
          persist(p, { ...meta, updated: now().toISOString() }, newBody, ownerOf(actor))
          return referrer
        },
      })
    }
    return result
  }

  function read(idOrPath) {
    requireRoot()
    const row = repo.getById(idOrPath) ?? repo.getByPath(idOrPath)
    if (!row) throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen doksi: ${idOrPath}`)
    const file = vault.readDoc(row.path)
    return {
      id: row.id,
      cim: row.title,
      utvonal: row.path,
      tulajdonos: row.owner,
      tagek: row.tags,
      letrehozva: row.created,
      frissitve: row.updated,
      verzio: row.version,
      tartalom: file.body,
    }
  }

  function list(actor, { mappa, tulajdonos, tag, limit } = {}) {
    requireRoot()
    if (mappa) return repo.listDocs({ folder: mappa, owner: tulajdonos, tag, limit })
    const home = homeFolderOf(actor)
    if (!home) return repo.listDocs({ owner: tulajdonos, tag, limit })
    // An agent's default view is its own folder plus the shared one, because
    // that is what it can act on; everything else is one explicit ask away.
    return [
      ...repo.listDocs({ folder: home, owner: tulajdonos, tag, limit }),
      ...repo.listDocs({ folder: sharedFolder(), owner: tulajdonos, tag, limit }),
    ]
  }

  function search(q, { mappa, tulajdonos, limit } = {}) {
    requireRoot()
    if (typeof q !== 'string' || q.trim() === '') {
      throw new DocsError(HIBA.rossz_parameter, 'A "q" keresőkifejezés kötelező.')
    }
    return repo.search(q.trim(), { folder: mappa, owner: tulajdonos, limit })
  }

  /** Rename or relocate. Both ends need write permission, not just the target. */
  function move(actor, { id, ujUtvonal, ujMappa } = {}) {
    requireRoot()
    const row = docOr404(id)
    requireWrite(actor, row.path)

    let target
    if (typeof ujUtvonal === 'string' && ujUtvonal.trim() !== '') {
      target = ujUtvonal.trim().replace(/^\/+/, '')
      if (!target.endsWith('.md')) target = `${target}.md`
    } else if (typeof ujMappa === 'string') {
      const folder = ujMappa.trim().replace(/^\/+|\/+$/g, '')
      target = folder === '' ? path.basename(row.path) : `${folder}/${path.basename(row.path)}`
    } else {
      throw new DocsError(HIBA.rossz_parameter, 'Add meg az "ujUtvonal" vagy az "ujMappa" mezőt.')
    }
    if (target === row.path) return { utvonal: row.path }
    requireWrite(actor, target)
    if (vault.exists(target)) {
      throw new DocsError(HIBA.mar_letezik, `Ezen az útvonalon már van doksi: ${target}`)
    }

    vault.move(row.path, target)
    const file = vault.readDoc(target)
    writer.noteSelfWrite(target, file.hash)
    writer.indexPath(target)
    return { utvonal: target }
  }

  /**
   * Into the trash. The row stays; a link pointing here can say "deleted"
   * rather than resolving to nothing, and restoring knows where it lived.
   */
  function remove(actor, { id } = {}) {
    requireRoot()
    const row = docOr404(id)
    requireWrite(actor, row.path)
    const file = vault.readDoc(row.path)
    // Written before the move, so the trashed document still has its text and
    // `restore` has something to rebuild the search entry from.
    repo.addVersion(row.id, {
      version: row.version,
      content: file.body,
      author: ownerOf(actor),
      createdAt: now().toISOString(),
    })
    const { trashRel } = vault.trash(row.path, row.id)
    repo.softDelete(row.id, now().toISOString())
    return { id: row.id, kukaban: trashRel, eredetiUtvonal: row.path }
  }

  function restore(actor, { id } = {}) {
    requireRoot()
    const row = repo.getById(id)
    if (!row) throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen doksi: ${id}`)
    requireWrite(actor, row.path)
    const trashRel = `${INTERNAL_FOLDER}/trash/${row.id}/${path.basename(row.path)}`
    if (!vault.exists(trashRel)) {
      throw new DocsError(HIBA.nincs_ilyen_doksi, `A kukában nincs meg a fájl: ${trashRel}`)
    }
    const target = vault.exists(row.path) ? freePath(path.dirname(row.path), row.title) : row.path
    vault.move(trashRel, target)
    repo.restore(row.id)
    const file = vault.readDoc(target)
    writer.noteSelfWrite(target, file.hash)
    writer.indexPath(target)
    return { id: row.id, utvonal: target }
  }

  function purge(actor, { id } = {}) {
    requireRoot()
    const row = repo.getById(id)
    if (!row) throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen doksi: ${id}`)
    if (actor?.kind !== 'user') {
      throw new DocsError(HIBA.nincs_jog, 'Véglegesen törölni csak az operátor tud, a Doksik lapról.')
    }
    const trashRel = `${INTERNAL_FOLDER}/trash/${row.id}/${path.basename(row.path)}`
    if (vault.exists(trashRel)) vault.remove(trashRel)
    repo.purge(row.id)
    return { id: row.id }
  }

  function versions(id) {
    docOr404(id)
    return repo.listVersions(id)
  }

  function version(id, v) {
    docOr404(id)
    const found = repo.getVersion(id, v)
    if (!found) throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen verzió: ${v}`)
    return found
  }

  /** Writes an old text back as a new version; the history is not rewound. */
  function restoreVersion(actor, { id, verzio, baseVersion } = {}) {
    const old = version(id, verzio)
    return update(actor, { id, tartalom: old.content, baseVersion })
  }

  function backlinks(id) {
    docOr404(id)
    return repo.backlinks(id)
  }

  function templates() {
    requireRoot()
    if (!vault.exists(TEMPLATES_FOLDER)) return []
    return vault.listDocs()
      .filter((p) => p.startsWith(`${TEMPLATES_FOLDER}/`))
      .map((p) => ({ nev: path.basename(p, '.md'), utvonal: p }))
  }

  return {
    create,
    update,
    read,
    list,
    search,
    move,
    remove,
    restore,
    purge,
    versions,
    version,
    restoreVersion,
    backlinks,
    templates,
  }
}
