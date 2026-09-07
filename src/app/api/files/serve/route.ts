import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
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
 * NULL FOR SEVERAL DIFFERENT REASONS, AND ALL OF THEM MEAN THE SAME THING
 * HERE: there is no header; it is not of the `bytes=` form; it asks for
 * several ranges (`bytes=0-9,20-29`); it is a zero-length suffix (`bytes=-0`),
 * which asks for nothing; or a bound is a number this route will not do
 * arithmetic on (beyond `Number.MAX_SAFE_INTEGER`). The caller answers every
 * one of them with the whole file and a 200, because a range this route does
 * not understand is not a range it may guess at: `<video>` asks again anyway
 * if the server does not chunk, and RFC 9110 lets a server ignore a `Range` it
 * cannot act on.
 *
 * Note what is NOT in that list: a range this route understood and cannot
 * satisfy. That one gets a 416 from the caller, because there the client is
 * owed an answer rather than a substitute.
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

/**
 * One file range as a web stream that survives its reader leaving.
 *
 * Kept out of the handler because the handler is about which bytes to send and
 * this is about the one way sending them can go wrong.
 */
function streamFile(file: string, start: number, end: number): ReadableStream<Uint8Array> {
  const source = fs.createReadStream(/*turbopackIgnore: true*/ file, { start, end })
  source.pause()
  let done = false
  // The one waiter a `pull` leaves behind when the file has nothing ready yet.
  // It is a single slot, not a listener per pull: `once` per call accumulated
  // handlers on a stream that may never emit again, and a promise waiting on
  // an event a destroyed stream will not send is a hang, not a slow read.
  let wake: (() => void) | null = null
  const ebred = () => { const w = wake; wake = null; if (w) w() }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const zar = (err?: Error) => {
        if (done) return
        done = true
        try {
          if (err) controller.error(err)
          else controller.close()
        } catch {
          // Already closed: the reader left first. There is nothing to report
          // and nobody to report it to.
        }
        ebred()
      }
      source.on('readable', ebred)
      source.on('end', () => zar())
      source.on('close', () => { done = true; ebred() })
      source.on('error', (err: Error) => zar(err))
    },
    async pull(controller) {
      while (!done) {
        const chunk = source.read() as Buffer | null
        if (chunk !== null) {
          try {
            controller.enqueue(new Uint8Array(chunk))
          } catch {
            // The reader went away between our read and our enqueue.
            done = true
            source.destroy()
          }
          return
        }
        // Nothing buffered yet. Wait for the next `readable`, `end`, `close`
        // or `error` -- all four resolve this, so a destroyed stream cannot
        // leave the promise pending.
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
    cancel() {
      // The browser dropped the connection -- on a seek, or because the page
      // closed. Destroying the read stream is what releases the descriptor;
      // without it every seek would leak one. `close` then wakes any pending
      // pull, so nothing is left waiting on a stream that will not speak again.
      done = true
      source.destroy()
      ebred()
    },
  })
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
    //
    // `start > end` is the whole test, and it covers being past the end too,
    // because `byteRange` has already clamped `end` to `size - 1` -- a start
    // at or beyond `size` is therefore always beyond `end`, and on an empty
    // file `end` is -1, so every start is. A separate `start >= stat.size`
    // disjunct would be unreachable, and unreachable conditions cannot be
    // tested and so rot. If the clamp ever leaves `byteRange`, this line has
    // to come back.
    if (range && range.start > range.end) {
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
    // WHY THIS IS HAND-BUILT AND NOT `Readable.toWeb`.
    //
    // `Readable.toWeb` was here, and it took the whole server down the first
    // time a browser played a video. A <video> element does not read a
    // response to its end: it asks for `bytes=0-`, reads enough to find the
    // duration, and drops the connection -- and it does that again on every
    // seek. When the consumer goes away the web stream's controller closes,
    // the file stream underneath does not, and its next chunk lands on a
    // closed controller. That throw happens on an I/O callback with nobody
    // awaiting it, so it arrives as an uncaughtException and Next exits
    // code=1. The log said `ERR_INVALID_STATE: Controller is already closed`
    // and the app died on opening a video's page.
    //
    // So the two ends are wired together explicitly. `cancel` destroys the
    // file stream, which is what closes the descriptor when the browser walks
    // away mid-seek. `pull` reads one chunk at a time, so a 12 MB render is
    // not buffered in memory to satisfy a reader that wants the first
    // kilobyte. And every `enqueue`/`close` is guarded, because "the consumer
    // left" is a normal event here, not an error to report -- there is no
    // longer anyone to report it to.
    const body = stat.size === 0 ? null : streamFile(resolved, start, end)
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
