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
    return errorResult(ERR.invalid_argument, `A művelet nem sikerült: ${err?.message ?? 'ismeretlen hiba'}`)
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

export function createRpc({ serviceOf, vaultOf, writerOf, repoOf, watcherStatus, restartWatcher, sharedFolder, rootSetting, logOf }) {
  const run = (fn) => guard(logOf(), fn)

  return {
    /** The whole left column in one call. */
    fa: () => run(() => {
      const service = serviceOf()
      const docs = service.list(OPERATOR, { mappa: '', limit: 2000 })
      const all = repoOf().listDocs({ limit: 2000 })
      return {
        gyoker: vaultOf().root,
        kozosMappaNev: sharedFolder(),
        // A mappák a LEMEZRŐL jönnek, nem csak a doksik útvonalaiból: egy
        // frissen létrehozott, még üres mappa különben nem jelenne meg, pedig
        // a `mappaLetrehoz` valódi könyvtárat írt.
        mappak: foldersOf(all.map((d) => d.path), [AGENTS_ROOT, sharedFolder(), ...vaultOf().listFolders()]),
        doksik: all.map((d) => ({
          id: d.id, cim: d.title, utvonal: d.path, tulajdonos: d.owner, frissitve: d.updated, tagek: d.tags,
        })),
        // A lap ebből dönti el, melyik [[link]] oldódott fel: cím szerint.
        cimek: all.map((d) => d.title),
        docsCount: docs.length,
      }
    }),

    olvas: (body) => run(() => serviceOf().read(body.id)),

    ment: (body) => run(() => serviceOf().update(OPERATOR, {
      id: body.id,
      tartalom: body.tartalom,
      cim: body.cim,
      tagek: body.tagek,
      baseVersion: body.baseVersion,
    })),

    letrehoz: (body) => run(() => serviceOf().create(OPERATOR, {
      mappa: body.mappa,
      cim: body.cim,
      tartalom: body.tartalom,
      sablon: body.sablon,
    })),

    keres: (body) => run(() => ({
      talalatok: serviceOf().search(body.q, { mappa: body.mappa, limit: body.limit ?? 50 }),
    })),

    mozgat: (body) => run(() => serviceOf().move(OPERATOR, {
      id: body.id,
      ujUtvonal: body.ujUtvonal,
      ujMappa: body.ujMappa,
    })),

    atnevez: (body) => run(() => serviceOf().update(OPERATOR, {
      id: body.id,
      cim: body.ujCim,
      baseVersion: body.baseVersion,
    })),

    torol: (body) => run(() => serviceOf().remove(OPERATOR, { id: body.id })),
    visszaallit: (body) => run(() => serviceOf().restore(OPERATOR, { id: body.id })),
    veglegesTorol: (body) => run(() => serviceOf().purge(OPERATOR, { id: body.id })),

    kuka: () => run(() => ({
      elemek: repoOf().listDocs({ includeDeleted: true, limit: 500 })
        .filter((d) => d.deleted_at)
        .map((d) => ({ id: d.id, cim: d.title, utvonal: d.path, torolve: d.deleted_at })),
    })),

    verziok: (body) => run(() => ({ verziok: serviceOf().versions(body.id) })),
    verzio: (body) => run(() => serviceOf().version(body.id, body.verzio)),
    visszaallitVerzio: (body) => run(() => serviceOf().restoreVersion(OPERATOR, {
      id: body.id,
      verzio: body.verzio,
      baseVersion: body.baseVersion,
    })),

    hivatkozok: (body) => run(() => ({ backlinkek: serviceOf().backlinks(body.id) })),
    sablonok: () => run(() => ({ sablonok: serviceOf().templates() })),

    /** The agent folders that exist on disk, so the tree can show real names. */
    ugynokok: () => run(() => {
      const seen = new Map()
      for (const doc of repoOf().listDocs({ limit: 2000 })) {
        const match = new RegExp(`^${AGENTS_ROOT}/([^/]+)/`).exec(doc.path)
        if (!match) continue
        const slug = match[1]
        seen.set(slug, (seen.get(slug) ?? 0) + 1)
      }
      return {
        ugynokok: [...seen.entries()].map(([slug, doksik]) => ({
          slug, mappa: `${AGENTS_ROOT}/${slug}`, doksik,
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
    allapot: () => run(() => {
      const beallitottGyoker = rootSetting()
      let gyoker = beallitottGyoker
      let gyokerRendben = false
      let gyokerHiba = null
      try {
        const vault = vaultOf()
        gyoker = vault.root
        vault.ensureRoot()
        gyokerRendben = true
      } catch (err) {
        gyokerHiba = err?.message ?? 'a doksi-gyökér nem érhető el'
      }
      const watcher = watcherStatus()
      return {
        gyoker,
        beallitottGyoker,
        gyokerRendben,
        gyokerHiba,
        figyeloFut: watcher.fut,
        figyeloHiba: watcher.hiba,
        doksiSzam: gyokerRendben ? repoOf().listDocs({ limit: 2000 }).length : 0,
        kozosMappaNev: sharedFolder(),
      }
    }),

    ujraindex: () => run(() => writerOf().indexAll()),
    figyeloUjraindit: () => run(() => restartWatcher()),

    /** Creates a folder by placing nothing in it; the tree reads folders from
     * document paths, so an empty folder needs a real directory to exist. */
    mappaLetrehoz: (body) => run(() => {
      const folder = String(body.mappa ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (folder === '') throw new DocsError(ERR.invalid_argument, 'Adj meg mappanevet.')
      const vault = vaultOf()
      vault.ensureRoot()
      vault.abs(folder)
      vault.mkdirp(folder)
      return { mappa: folder }
    }),
  }
}

export { foldersOf }
