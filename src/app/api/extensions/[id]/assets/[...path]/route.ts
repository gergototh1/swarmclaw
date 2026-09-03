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

  const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream'
  return new NextResponse(new Uint8Array(fs.readFileSync(target)), {
    status: 200,
    headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
  })
}
