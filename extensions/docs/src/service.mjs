import path from 'node:path'

import { DocsError, ERR } from './errors.mjs'
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
    super(ERR.conflict, message)
    this.details = details
  }
}

const MAX_SLUG = 60

/** A file name from a title: unaccented, lower case, dash separated. */
export function fileSlug(title) {
  const folded = String(title ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '')
  return folded === '' ? 'doc' : folded
}

export function createService({ vault, writer, repo, sharedFolder, versionsKept, now = () => new Date() }) {
  const opts = () => ({ sharedFolderName: sharedFolder() })

  function requireRoot() {
    vault.ensureRoot()
  }

  function requireWrite(actor, relPath) {
    if (!canWrite(actor, relPath, opts())) {
      throw new DocsError(
        ERR.forbidden,
        `You cannot write to this: ${relPath}. You can write to your own folder (${homeFolderOf(actor) ?? '—'}) and the "${sharedFolder()}" folder.`,
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
    if (!row) throw new DocsError(ERR.doc_not_found, `No such doc: ${id}`)
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
    return { id: indexed.id, path: relPath, version: row.version, title: row.title }
  }

  function create(actor, { folder, title, content, tags, template } = {}) {
    requireRoot()
    if (typeof title !== 'string' || title.trim() === '') {
      throw new DocsError(ERR.invalid_argument, 'The "title" is required for a new doc.')
    }
    const docTitle = title.trim()
    const targetFolder = typeof folder === 'string' && folder.trim() !== ''
      ? folder.trim().replace(/^\/+|\/+$/g, '')
      : (homeFolderOf(actor) ?? sharedFolder())

    let body = typeof content === 'string' ? content : ''
    if (typeof template === 'string' && template.trim() !== '') {
      const templateRel = `${TEMPLATES_FOLDER}/${template.trim().replace(/\.md$/, '')}.md`
      if (!vault.exists(templateRel)) {
        throw new DocsError(ERR.doc_not_found, `No such template: ${template}. docs_list gives the list of templates for the "${TEMPLATES_FOLDER}" folder.`)
      }
      body = vault.readDoc(templateRel).body + (body === '' ? '' : `\n${body}`)
    }

    const relPath = freePath(targetFolder, docTitle)
    requireWrite(actor, relPath)
    const stamp = now().toISOString()
    return persist(relPath, {
      id: undefined,
      title: docTitle,
      owner: ownerOf(actor),
      tags: Array.isArray(tags) ? tags : [],
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
  function update(actor, { id, content, title, tags, baseVersion } = {}) {
    requireRoot()
    const row = docOr404(id)
    requireWrite(actor, row.path)
    if (!Number.isInteger(baseVersion)) {
      throw new DocsError(
        ERR.invalid_argument,
        '"baseVersion" is required to change a doc. Read the doc with docs_read and pass back the version number you got.',
      )
    }
    if (baseVersion !== row.version) {
      const newest = repo.getVersion(id, row.version)
      throw new ConflictError(
        `The doc was changed meanwhile by: ${newest?.author ?? 'someone else'}. Read it again with docs_read, merge your change in, and write it back with the new version number.`,
        {
          currentVersion: row.version,
          modifiedBy: newest?.author ?? null,
          theirs: newest?.content ?? null,
        },
      )
    }

    const current = vault.readDoc(row.path)
    const newTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : row.title
    const body = typeof content === 'string' ? content : current.body
    const result = persist(row.path, {
      ...current.meta,
      id: row.id,
      title: newTitle,
      owner: row.owner,
      tags: Array.isArray(tags) ? tags : row.tags,
      created: row.created,
      updated: now().toISOString(),
    }, body, ownerOf(actor))

    if (newTitle !== row.title) {
      result.links = renameLinksTo(repo, {
        docId: row.id,
        oldTitle: row.title,
        newTitle,
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
    if (!row) throw new DocsError(ERR.doc_not_found, `No such doc: ${idOrPath}`)
    const file = vault.readDoc(row.path)
    return {
      id: row.id,
      title: row.title,
      path: row.path,
      owner: row.owner,
      tags: row.tags,
      created: row.created,
      updated: row.updated,
      version: row.version,
      content: file.body,
    }
  }

  function list(actor, { folder, owner, tag, limit } = {}) {
    requireRoot()
    if (folder) return repo.listDocs({ folder, owner, tag, limit })
    const home = homeFolderOf(actor)
    if (!home) return repo.listDocs({ owner, tag, limit })
    // An agent's default view is its own folder plus the shared one, because
    // that is what it can act on; everything else is one explicit ask away.
    return [
      ...repo.listDocs({ folder: home, owner, tag, limit }),
      ...repo.listDocs({ folder: sharedFolder(), owner, tag, limit }),
    ]
  }

  function search(q, { folder, owner, limit } = {}) {
    requireRoot()
    if (typeof q !== 'string' || q.trim() === '') {
      throw new DocsError(ERR.invalid_argument, 'The "q" search term is required.')
    }
    return repo.search(q.trim(), { folder, owner, limit })
  }

  /** Rename or relocate. Both ends need write permission, not just the target. */
  function move(actor, { id, newPath, newFolder } = {}) {
    requireRoot()
    const row = docOr404(id)
    requireWrite(actor, row.path)

    let target
    if (typeof newPath === 'string' && newPath.trim() !== '') {
      target = newPath.trim().replace(/^\/+/, '')
      if (!target.endsWith('.md')) target = `${target}.md`
    } else if (typeof newFolder === 'string') {
      const folder = newFolder.trim().replace(/^\/+|\/+$/g, '')
      target = folder === '' ? path.basename(row.path) : `${folder}/${path.basename(row.path)}`
    } else {
      throw new DocsError(ERR.invalid_argument, 'Give the "newPath" or "newFolder" field.')
    }
    if (target === row.path) return { path: row.path }
    requireWrite(actor, target)
    if (vault.exists(target)) {
      throw new DocsError(ERR.already_exists, `There is already a doc at this path: ${target}`)
    }

    vault.move(row.path, target)
    const file = vault.readDoc(target)
    writer.noteSelfWrite(target, file.hash)
    writer.indexPath(target)
    return { path: target }
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
    return { id: row.id, trashPath: trashRel, originalPath: row.path }
  }

  function restore(actor, { id } = {}) {
    requireRoot()
    const row = repo.getById(id)
    if (!row) throw new DocsError(ERR.doc_not_found, `No such doc: ${id}`)
    requireWrite(actor, row.path)
    const trashRel = `${INTERNAL_FOLDER}/trash/${row.id}/${path.basename(row.path)}`
    if (!vault.exists(trashRel)) {
      throw new DocsError(ERR.doc_not_found, `The file is not in the trash: ${trashRel}`)
    }
    const target = vault.exists(row.path) ? freePath(path.dirname(row.path), row.title) : row.path
    vault.move(trashRel, target)
    repo.restore(row.id)
    const file = vault.readDoc(target)
    writer.noteSelfWrite(target, file.hash)
    writer.indexPath(target)
    return { id: row.id, path: target }
  }

  function purge(actor, { id } = {}) {
    requireRoot()
    const row = repo.getById(id)
    if (!row) throw new DocsError(ERR.doc_not_found, `No such doc: ${id}`)
    if (actor?.kind !== 'user') {
      throw new DocsError(ERR.forbidden, 'Only the operator can purge for good, from the Docs page.')
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
    if (!found) throw new DocsError(ERR.doc_not_found, `No such version: ${v}`)
    return found
  }

  /** Writes an old text back as a new version; the history is not rewound. */
  function restoreVersion(actor, { id, version: targetVersion, baseVersion } = {}) {
    const old = version(id, targetVersion)
    return update(actor, { id, content: old.content, baseVersion })
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
      .map((p) => ({ name: path.basename(p, '.md'), path: p }))
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
