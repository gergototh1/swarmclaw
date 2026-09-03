import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getExtensionManager } from '@/lib/server/extensions'

export const dynamic = 'force-dynamic'

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function invalidPath(): NextResponse {
  return NextResponse.json({ error: 'Invalid asset path' }, { status: 400 })
}

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
}

/** True when `candidate` sits strictly below `root`, so the root directory itself does not pass. */
function isInside(root: string, candidate: string): boolean {
  return candidate.startsWith(root + path.sep)
}

/**
 * GET /api/extensions/:id/assets/:path*
 *
 * Serves an installed extension's built browser assets out of `<workspace>/dist`.
 *
 * The URL segments are **dist-relative**: `/api/extensions/<id>/assets/index.js`
 * reads `<workspace>/dist/index.js`. Page definitions declare `entry`/`css` as
 * workspace-relative paths that must start with `dist/` (enforced by
 * `validateExtensionPages`), so a loader strips that `dist/` prefix before
 * building the URL rather than appending the declared value verbatim.
 *
 * Two checks below are load-bearing and must both stay:
 * - the `isInside(distRoot, target)` containment check after `path.resolve`
 *   rejects every `..`, whether it arrives as its own segment or hidden inside
 *   one such as `'../secret.txt'`;
 * - the `realpathSync` re-check rejects a symlink that lives inside `dist` but
 *   points outside it, which resolve-plus-containment alone cannot see.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path: segs } = await params
  if (!Array.isArray(segs) || segs.length === 0) return invalidPath()
  if (segs.some((seg) => typeof seg !== 'string' || seg === '' || seg === '.' || seg === '..' || seg.includes('\0'))) {
    return invalidPath()
  }

  // An unusable id (empty, wrong suffix, contains a directory) is a bad request, not a server error.
  let workspaceDir: string
  try {
    workspaceDir = getExtensionManager().getWorkspaceDirFor(id)
  } catch {
    return invalidPath()
  }

  const distRoot = path.resolve(workspaceDir, 'dist')
  // resolve() normalizes any '..' away; the containment check is what actually refuses an escape.
  const target = path.resolve(distRoot, ...segs)
  if (!isInside(distRoot, target)) return invalidPath()

  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return notFound()
  }
  if (!stat.isFile()) return notFound()

  // Resolve symlinks too, so a link inside dist cannot point at a file outside it.
  try {
    if (!isInside(fs.realpathSync(distRoot), fs.realpathSync(target))) return invalidPath()
  } catch {
    return notFound()
  }

  const ext = path.extname(target).toLowerCase()
  const headers: Record<string, string> = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    // Never let a browser upgrade these bytes to a richer type than the extension declared.
    'X-Content-Type-Options': 'nosniff',
  }
  if (ext === '.svg') {
    // An SVG navigated directly runs its own script in this app's origin, which a
    // same-origin CSP cannot stop. The empty sandbox drops the document into an
    // opaque origin with scripting off, while <img src> and CSS url() still render
    // it (neither of those ever executes SVG script).
    headers['Content-Security-Policy'] = 'sandbox'
  }
  return new NextResponse(new Uint8Array(fs.readFileSync(target)), { status: 200, headers })
}
