import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { Readable } from 'node:stream'
import { resolveWorkspacePath } from '@/lib/server/resolve-workspace-path'

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.sh': 'text/plain',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const MAX_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * The media extensions: responses for these STREAM, and MAX_SIZE does not
 * apply to them.
 *
 * WHY THE SIZE CAP IS NOT WHAT PROTECTS THEM. MAX_SIZE was about memory:
 * `readFileSync` reads the whole file, so one large file held that much memory
 * per request. In a stream the response is bound to the RANGE that was asked
 * for, not to the size of the file, so the cap no longer defends anything
 * here.
 *
 * WHAT THIS DOES NOT WIDEN. WHICH files are reachable is decided by the
 * `blocked` list and by `resolveWorkspacePath`, and neither one changes. Only
 * the size ceiling disappears, and only for media -- a 12 MB render was
 * unwatchable because it went two megabytes over.
 */
const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/**
 * The single byte range of a `Range` header, or null.
 *
 * NULL FOR THREE DIFFERENT REASONS, AND ALL THREE MEAN THE SAME THING HERE:
 * there is no header, it is not of the `bytes=` form, or it asks for several
 * ranges (`bytes=0-9,20-29`). The caller answers all three with the whole file
 * and a 200, because a range this route does not understand is not a range it
 * may guess at: `<video>` asks again anyway if the server does not chunk.
 *
 * `bytes=-500` (the last 500 bytes) is included, because browsers really do
 * send it.
 */
function byteRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    const length = Number(rawEnd)
    if (!Number.isSafeInteger(length) || length <= 0) return null
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start)) return null
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isSafeInteger(end)) return null
  return { start, end: Math.min(end, size - 1) }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const filePath = url.searchParams.get('path')

  if (!filePath) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 })
  }

  const cwd = url.searchParams.get('cwd')

  // Resolve the path, trying workspace-relative fallbacks
  const resolved = resolveWorkspacePath(filePath, cwd)

  if (!resolved) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  // Block access to sensitive paths
  const blocked = ['.env', 'credentials', '.ssh', '.gnupg', '.aws']
  if (blocked.some((b) => resolved.includes(b))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const stat = fs.statSync(/*turbopackIgnore: true*/ resolved)
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'Not a file' }, { status: 400 })
  }
  const ext = path.extname(resolved).toLowerCase()
  const mediaType = MEDIA_MIME[ext] ?? null

  if (mediaType) {
    const range = byteRange(req.headers.get('range'), stat.size)
    // A request past the end of the file gets HTTP's own answer for it, with
    // the size: without this the <video> would get an empty 206 and playback
    // would stop without anyone finding out why.
    if (range && (range.start >= stat.size || range.start > range.end)) {
      return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    const start = range ? range.start : 0
    const end = range ? range.end : stat.size - 1
    // An empty file computes to `end === -1`, and `createReadStream` throws on
    // that rather than yielding nothing -- so a zero-byte .mp4, which is what
    // a crashed render leaves behind, would answer an opaque 500 where
    // `readFileSync` used to answer a plain empty 200. There is nothing to
    // stream, so there is no stream.
    //
    // `Readable.toWeb` really does produce a web stream of Uint8Array chunks;
    // the cast only reconciles @types/node's `stream/web` declaration with the
    // DOM one the Response constructor is typed against. A Node stream handed
    // straight to NextResponse also works at runtime, but needs an
    // `as unknown as` -- this keeps the assertion down to one hop of a type
    // that is actually true.
    const body = stat.size === 0
      ? null
      : Readable.toWeb(fs.createReadStream(/*turbopackIgnore: true*/ resolved, { start, end })) as ReadableStream<Uint8Array>
    return new NextResponse(body, {
      status: range ? 206 : 200,
      headers: {
        'Content-Type': mediaType,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'inline',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
      },
    })
  }

  if (stat.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large' }, { status: 413 })
  }

  const contentType = MIME_MAP[ext] || 'application/octet-stream'
  const content = fs.readFileSync(/*turbopackIgnore: true*/ resolved)

  return new NextResponse(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': contentType.startsWith('text/') || contentType.startsWith('image/')
        ? 'inline'
        : `attachment; filename="${path.basename(resolved)}"`,
    },
  })
}
