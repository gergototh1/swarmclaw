import fs from 'node:fs'
import path from 'node:path'

import { linkRowsFor } from './links.mjs'
import { AGENTS_ROOT } from './permissions.mjs'
import { newDocId } from './vault.mjs'

/** How long a self-write note stays believable. */
const SELF_WRITE_TTL_MS = 5_000

/** The title a headerless file should get: its first heading, else its name. */
function inferTitle(body, relPath) {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t]*$/m.exec(body)
  if (heading) return heading[1].trim()
  return path.basename(relPath, '.md')
}

/** The owner a file's location implies. */
function inferOwner(relPath) {
  const match = new RegExp(`^${AGENTS_ROOT}/([^/]+)/`).exec(relPath)
  return match ? `agent:${match[1]}` : 'user'
}

/**
 * The one function every write into the index goes through.
 *
 * The page, the tools, the contract and the watcher all call `indexPath`. That
 * is the whole point of the design: there are two ways a file comes to be
 * written -- by us, or by someone outside -- but only one way it becomes an
 * index row, so the two paths cannot drift apart in what indexing means.
 *
 * WHAT THIS DOES NOT DO. It does not check permissions; the caller does, before
 * writing. And it does not write a version row: a version is a fact about
 * editing, not about indexing, and if this wrote one then the watcher would
 * mint a second version for every save the page already recorded.
 */
export function createIndexWriter({ vault, repo, now = Date.now }) {
  /** path -> { hash, at }. What we wrote, so the watcher can ignore its echo. */
  const selfWrites = new Map()

  function noteSelfWrite(relPath, hash) {
    selfWrites.set(relPath, { hash, at: now() })
  }

  /**
   * Whether this exact content at this path is our own echo.
   *
   * Matching on the hash and not only the path is what makes this safe: if
   * somebody really does edit the file from outside a moment after we saved it,
   * the content differs, the hash differs, and the event is processed. A
   * path-only filter would swallow that edit.
   */
  function isSelfWrite(relPath, hash) {
    const note = selfWrites.get(relPath)
    if (!note) return false
    if (now() - note.at > SELF_WRITE_TTL_MS) {
      selfWrites.delete(relPath)
      return false
    }
    return note.hash === hash
  }

  function forgetSelfWrites() {
    selfWrites.clear()
  }

  /**
   * Brings one file's row in line with the file.
   *
   * The header is repaired when it is missing, unreadable, or carries an id
   * that already belongs to a different path -- the last being what happens
   * when somebody duplicates a file in Finder. Repairing means writing the
   * header back into the file, which is the only time this module touches a
   * file it did not create; without a stable id the document could not be
   * linked to or versioned at all.
   */
  function indexPath(relPath) {
    const read = vault.readDoc(relPath)
    const stat = fs.statSync(vault.abs(relPath))
    const iso = new Date(stat.mtimeMs).toISOString()

    const claimed = typeof read.meta.id === 'string' ? read.meta.id : ''
    const clash = claimed ? repo.getById(claimed) : undefined
    // An id already recorded at another path is either a file somebody
    // duplicated or a file somebody moved, and those want opposite treatment: a
    // duplicate must get a fresh id, a move must keep the one it has. The fact
    // that separates them is whether the other file is still on disk. Asking
    // the index alone cannot tell, which is why this asks the filesystem.
    const duplicate = Boolean(clash) && clash.path !== relPath && vault.exists(clash.path)
    const needsHeader = claimed === '' || duplicate

    let { meta, body, hash, size } = read
    let headerRepaired = false
    if (needsHeader) {
      meta = {
        id: newDocId(),
        title: typeof read.meta.title === 'string' && read.meta.title !== ''
          ? read.meta.title
          : inferTitle(body, relPath),
        owner: typeof read.meta.owner === 'string' && read.meta.owner !== ''
          ? read.meta.owner
          : inferOwner(relPath),
        tags: Array.isArray(read.meta.tags) ? read.meta.tags : [],
        created: typeof read.meta.created === 'string' && read.meta.created !== '' ? read.meta.created : iso,
        updated: iso,
      }
      const written = vault.writeDoc(relPath, { meta, body })
      hash = written.hash
      size = written.size
      noteSelfWrite(relPath, hash)
      headerRepaired = true
    }

    const existing = repo.getById(meta.id)
    if (existing && existing.hash === hash && existing.path === relPath) {
      return { id: meta.id, changed: false, headerRepaired }
    }

    const title = typeof meta.title === 'string' && meta.title !== '' ? meta.title : inferTitle(body, relPath)
    repo.upsertDoc({
      id: meta.id,
      path: relPath,
      title,
      owner: typeof meta.owner === 'string' && meta.owner !== '' ? meta.owner : inferOwner(relPath),
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      created: typeof meta.created === 'string' ? meta.created : iso,
      updated: typeof meta.updated === 'string' ? meta.updated : iso,
      size,
      hash,
      version: existing ? existing.version + 1 : 1,
      body,
    })
    repo.setLinks(meta.id, linkRowsFor(repo, body))
    // Anyone who was waiting for a document by this title now has one. Without
    // this a link would only attach when the linking document was next
    // reindexed, which for a document nobody touches again is never.
    repo.resolveUnresolved(title, meta.id)

    return { id: meta.id, changed: true, headerRepaired }
  }

  /**
   * Rebuilds the index from the files, and drops rows whose file is gone.
   *
   * A trashed document is not "gone": its row is deliberately kept and its file
   * deliberately moved under `.swarmdocs/`, so the sweep skips anything already
   * marked deleted rather than purging exactly the rows the trash exists to
   * preserve.
   */
  function indexAll() {
    const onDisk = vault.listDocs()
    let changed = 0
    for (const relPath of onDisk) {
      if (indexPath(relPath).changed) changed += 1
    }
    const alive = new Set(onDisk)
    let removed = 0
    for (const row of repo.allPaths()) {
      if (alive.has(row.path)) continue
      const doc = repo.getById(row.id)
      if (doc?.deleted_at) continue
      repo.purge(row.id)
      removed += 1
    }
    // Three separate facts, because a caller that wants to say "nothing needed
    // doing" cannot tell that from a count of files walked, and a caller that
    // wants to say "I looked at 400 documents" cannot tell it from a count of
    // changes either.
    return { scanned: onDisk.length, changed, removed }
  }

  return { indexPath, indexAll, noteSelfWrite, isSelfWrite, forgetSelfWrites }
}
