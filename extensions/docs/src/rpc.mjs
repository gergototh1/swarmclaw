import { DocsError, ERR, errorResult } from './errors.mjs'
import { AGENTS_ROOT } from './permissions.mjs'

/**
 * What the page may ask for.
 *
 * NONE OF THESE THROWS EITHER, and for a sharper reason than the tools: a
 * handler that throws reaches the browser as a bare 500, which tells the
 * operator nothing at all and leaves the page with an empty pane it cannot
 * explain. So every handler answers with a named code and a sentence, and the
 * page decides what to draw from it.
 *
 * The actor is always the operator. The page is behind the host's own
 * authentication and only the operator can open it, so there is no identity to
 * negotiate here -- and nothing the browser sends is allowed to change it.
 *
 * Every method name and every request/response field here is the English name
 * from the project's rename glossary. `service.mjs` already speaks these same
 * names, so most handlers below are a direct pass-through of its return value
 * rather than a translation layer.
 */

const OPERATOR = { kind: 'user' }

/** Runs a handler, turning any DocsError into the page's error shape. */
async function guard(log, fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof DocsError) {
      return err.details ? { ...errorResult(err.code, err.message), ...err.details } : errorResult(err.code, err.message)
    }
    log?.error?.('docs rpc failed', { error: err?.message })
    return errorResult(ERR.invalid_argument, `The operation failed: ${err?.message ?? 'unknown error'}`)
  }
}

/** Every folder that appears in a list of paths, including the intermediates. */
function foldersOf(paths, extra = []) {
  const folders = new Set(extra)
  for (const p of paths) {
    const parts = p.split('/')
    parts.pop()
    for (let i = 1; i <= parts.length; i += 1) folders.add(parts.slice(0, i).join('/'))
  }
  folders.delete('')
  return [...folders].sort()
}

export function createRpc({ serviceOf, vaultOf, writerOf, repoOf, watcherStatus, restartWatcher, sharedFolder, rootSetting, logOf, migrationStatus }) {
  const run = (fn) => guard(logOf(), fn)

  return {
    /** The whole left column in one call. */
    tree: () => run(() => {
      const service = serviceOf()
      const docs = service.list(OPERATOR, { folder: '', limit: 2000 })
      const all = repoOf().listDocs({ limit: 2000 })
      return {
        root: vaultOf().root,
        sharedFolderName: sharedFolder(),
        // The folders come from DISK, not just from the documents' own paths: a
        // freshly created, still-empty folder would otherwise not show up, even
        // though `createFolder` wrote a real directory.
        folders: foldersOf(all.map((d) => d.path), [AGENTS_ROOT, sharedFolder(), ...vaultOf().listFolders()]),
        docs: all.map((d) => ({
          id: d.id, title: d.title, path: d.path, owner: d.owner, updated: d.updated, tags: d.tags,
        })),
        // The page decides from this which [[link]] resolved: by title.
        titles: all.map((d) => d.title),
        docsCount: docs.length,
      }
    }),

    read: (body) => run(() => serviceOf().read(body.id)),

    save: (body) => run(() => serviceOf().update(OPERATOR, {
      id: body.id,
      content: body.content,
      title: body.title,
      tags: body.tags,
      baseVersion: body.baseVersion,
    })),

    create: (body) => run(() => serviceOf().create(OPERATOR, {
      folder: body.folder,
      title: body.title,
      content: body.content,
      tags: body.tags,
      template: body.template,
    })),

    search: (body) => run(() => ({
      results: serviceOf().search(body.q, { folder: body.folder, limit: body.limit ?? 50 })
        .map((r) => ({ id: r.id, path: r.path, title: r.title, snippet: r.snippet })),
    })),

    move: (body) => run(() => serviceOf().move(OPERATOR, {
      id: body.id,
      newPath: body.newPath,
      newFolder: body.newFolder,
    })),

    rename: (body) => run(() => serviceOf().update(OPERATOR, {
      id: body.id,
      title: body.newTitle,
      baseVersion: body.baseVersion,
    })),

    delete: (body) => run(() => serviceOf().remove(OPERATOR, { id: body.id })),
    restore: (body) => run(() => serviceOf().restore(OPERATOR, { id: body.id })),
    purge: (body) => run(() => serviceOf().purge(OPERATOR, { id: body.id })),

    trash: () => run(() => ({
      items: repoOf().listDocs({ includeDeleted: true, limit: 500 })
        .filter((d) => d.deleted_at)
        .map((d) => ({ id: d.id, title: d.title, path: d.path, deletedAt: d.deleted_at })),
    })),

    versions: (body) => run(() => ({
      versions: serviceOf().versions(body.id).map((v) => ({
        version: v.version, author: v.author, createdAt: v.createdAt, size: v.meret,
      })),
    })),
    version: (body) => run(() => serviceOf().version(body.id, body.version)),
    restoreVersion: (body) => run(() => serviceOf().restoreVersion(OPERATOR, {
      id: body.id,
      version: body.version,
      baseVersion: body.baseVersion,
    })),

    backlinks: (body) => run(() => ({ backlinks: serviceOf().backlinks(body.id) })),
    templates: () => run(() => ({ templates: serviceOf().templates() })),

    /** The agent folders that exist on disk, so the tree can show real names. */
    agents: () => run(() => {
      const seen = new Map()
      for (const doc of repoOf().listDocs({ limit: 2000 })) {
        const match = new RegExp(`^${AGENTS_ROOT}/([^/]+)/`).exec(doc.path)
        if (!match) continue
        const slug = match[1]
        seen.set(slug, (seen.get(slug) ?? 0) + 1)
      }
      return {
        agents: [...seen.entries()].map(([slug, docs]) => ({
          slug, folder: `${AGENTS_ROOT}/${slug}`, docs,
        })),
      }
    }),

    /**
     * What the page draws its warning bars from.
     *
     * Deliberately does not throw on a broken root: "the root is unwritable" is
     * the single most important thing this call can report, and reporting it as
     * a failure of the call itself would lose it.
     */
    status: () => run(() => {
      const configuredRoot = rootSetting()
      let root = configuredRoot
      let rootOk = false
      let rootError = null
      try {
        const vault = vaultOf()
        root = vault.root
        vault.ensureRoot()
        rootOk = true
      } catch (err) {
        rootError = err?.message ?? 'the docs root is not reachable'
      }
      const watcher = watcherStatus()
      return {
        root,
        configuredRoot,
        rootOk,
        rootError,
        watcherRunning: watcher.running,
        watcherError: watcher.error,
        docCount: rootOk ? repoOf().listDocs({ limit: 2000 }).length : 0,
        sharedFolderName: sharedFolder(),
        migrationBlocked: migrationStatus?.()?.blocked ?? [],
      }
    }),

    reindex: () => run(() => writerOf().indexAll()),
    restartWatcher: () => run(() => restartWatcher()),

    /** Creates a folder by placing nothing in it; the tree reads folders from
     * document paths, so an empty folder needs a real directory to exist. */
    createFolder: (body) => run(() => {
      const folder = String(body.folder ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (folder === '') throw new DocsError(ERR.invalid_argument, 'Give a folder name.')
      const vault = vaultOf()
      vault.ensureRoot()
      vault.abs(folder)
      vault.mkdirp(folder)
      return { folder }
    }),
  }
}

export { foldersOf }
