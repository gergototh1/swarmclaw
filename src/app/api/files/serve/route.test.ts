import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { GET } from './route'

/**
 * A temporary mp4 the route can serve. The content is not video -- the route
 * moves bytes, it does not decode them.
 *
 * The bytes are position-dependent (`i % 251`) rather than a constant fill so
 * a Range assertion can prove the response starts at the byte that was ASKED
 * for. With a constant fill, a read stream opened at offset 0 with the right
 * LENGTH passes every length and header check while handing the player the
 * wrong part of the file, and nothing in the suite would notice.
 */
function tempMp4(bytes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'))
  const file = path.join(dir, 'video.mp4')
  const buf = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i += 1) buf[i] = i % 251
  fs.writeFileSync(file, buf)
  return file
}

const serve = (file: string, range?: string) =>
  GET(new Request(`http://localhost/api/files/serve?path=${encodeURIComponent(file)}`,
    range ? { headers: { range } } : undefined))

describe('files/serve media', () => {
  it('hands out an mp4 as something playable, not as a download', async () => {
    const res = await serve(tempMp4(1024))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'video/mp4')
    assert.equal(res.headers.get('content-disposition'), 'inline')
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    assert.equal(res.headers.get('content-length'), '1024')
    // Content-Length is COMPUTED from the range arithmetic, never measured
    // from the stream, so the header above says nothing about whether a body
    // was attached. Read it. A branch that streams only on the 206 path
    // satisfies every header assertion here and hands <video> an empty 200 on
    // the very first request it makes.
    const body = Buffer.from(await res.arrayBuffer())
    assert.equal(body.byteLength, 1024)
    assert.equal(body[0], 0)
    assert.equal(body[1023], 1023 % 251, 'the stream must run to the last byte of the file')
  })

  it('does not apply the 10 MB cap to media -- that cap is why the render could not be watched', async () => {
    const res = await serve(tempMp4(12 * 1024 * 1024))
    assert.equal(res.status, 200, 'this was a 413, and it is why the player never started')
  })

  it('keeps the 10 MB cap on everything that is NOT media', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'))
    const file = path.join(dir, 'big.txt')
    fs.writeFileSync(file, Buffer.alloc(11 * 1024 * 1024, 65))
    const res = await GET(new Request(`http://localhost/api/files/serve?path=${encodeURIComponent(file)}`))
    assert.equal(res.status, 413)
  })

  it('answers a Range with 206 and the slice that was asked for', async () => {
    const res = await serve(tempMp4(1000), 'bytes=100-199')
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 100-199/1000')
    assert.equal(res.headers.get('content-length'), '100')
    const body = Buffer.from(await res.arrayBuffer())
    assert.equal(body.byteLength, 100)
    // The offset, not just the length: byte 0 of the slice must be file byte 100.
    assert.equal(body[0], 100 % 251)
    assert.equal(body[99], 199 % 251)
  })

  it('runs an open-ended Range to the end of the file -- this is what <video> sends first', async () => {
    const res = await serve(tempMp4(1000), 'bytes=0-')
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 0-999/1000')
  })

  it('answers a Range past the end of the file with 416, naming the size', async () => {
    const res = await serve(tempMp4(1000), 'bytes=5000-6000')
    assert.equal(res.status, 416)
    assert.equal(res.headers.get('content-range'), 'bytes */1000')
  })

  /**
   * An inverted range is the only input that reaches the 416 guard without
   * also being past the end of the file, so it is the only test that holds
   * `start > end` up on its own.
   *
   * It is also a deliberate deviation: RFC 9110 calls this an invalid
   * ranges-specifier and leans toward ignoring the header, which would mean
   * the whole file with 200. 416 is the more informative answer to a client
   * that has confused itself, no <video> ever sends this, and pinning the
   * choice here is worth more than leaving the case we are least sure about
   * unguarded.
   */
  it('answers an inverted range with 416 rather than guessing at what was meant', async () => {
    const res = await serve(tempMp4(1000), 'bytes=500-100')
    assert.equal(res.status, 416)
    assert.equal(res.headers.get('content-range'), 'bytes */1000')
  })

  it('does not invent a range it cannot read: it serves the whole file with 200', async () => {
    const res = await serve(tempMp4(1000), 'bytes=abc')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-length'), '1000')
  })

  /**
   * A crashed render leaves a zero-byte .mp4 behind, and that is precisely
   * when the operator reloads the page. `createReadStream` throws outright on
   * `{ start: 0, end: -1 }`, which is what an empty file computes to, so
   * without a guard the streaming branch turns a readable empty file into an
   * opaque 500 -- something the old `readFileSync` answered with a plain
   * empty 200.
   */
  it('serves a zero-byte media file as an empty 200 instead of throwing', async () => {
    const res = await serve(tempMp4(0))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-length'), '0')
    assert.equal((await res.arrayBuffer()).byteLength, 0)
  })

  /**
   * The blocked list decides WHICH files are reachable, and media must not be
   * a hole in it. This passes only if the block check still runs BEFORE the
   * media branch -- a media branch hoisted above it would serve this file.
   */
  it('keeps the blocked paths blocked for media too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'))
    fs.mkdirSync(path.join(dir, '.ssh'))
    const file = path.join(dir, '.ssh', 'secret.mp4')
    fs.writeFileSync(file, Buffer.alloc(16, 7))
    const res = await GET(new Request(`http://localhost/api/files/serve?path=${encodeURIComponent(file)}`))
    assert.equal(res.status, 403)
  })
})

/**
 * The crash this file exists to keep out.
 *
 * A <video> element does not read a response to its end: it asks for
 * `bytes=0-`, reads enough to find the duration, and drops the connection --
 * and again on every seek. With `Readable.toWeb` the file stream kept pushing
 * into a closed controller, the throw arrived on an I/O callback with nobody
 * awaiting it, and Next exited code=1 with
 * `ERR_INVALID_STATE: Controller is already closed`. Opening a video's page
 * killed the app.
 *
 * `process.on('uncaughtException')` is what pins it: the failure was never a
 * rejected promise the caller could see, which is exactly why no earlier test
 * caught it.
 */
describe('files/serve media, reader leaves early', () => {
  /**
   * WHAT THESE TWO PIN, AND WHAT THEY DO NOT.
   *
   * They do NOT reproduce the crash this code was rewritten for. That crash --
   * `ERR_INVALID_STATE: Controller is already closed`, an uncaughtException
   * that exited the server code=1 the first time a browser opened a video's
   * page -- was verified NOT to reproduce here: with `Readable.toWeb` back in
   * place both of these still pass. It needs a real HTTP connection torn down
   * by a real client on Electron's Node, which is where it was observed and
   * where the fix was verified by hand. A test that claimed otherwise would be
   * worse than none, so this comment is the claim.
   *
   * What they do pin is the two things the hand-built stream must get right
   * and that the in-process reader can actually observe: cancelling must not
   * leave a pull waiting on a stream that will never speak again, and it must
   * release the descriptor so the next open still works.
   */
  it('a cancelled read does not leave the stream waiting forever', async () => {
    const res = await serve(tempMp4(4 * 1024 * 1024))
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    await reader.read()
    // `cancel()` resolving is the assertion: with a `pull` that waits on an
    // event a destroyed stream never sends, this hangs and the runner reports
    // the promise as still pending.
    await reader.cancel()
  })

  it('twenty cancelled reads still leave the file openable', async () => {
    const file = tempMp4(4 * 1024 * 1024)
    for (let i = 0; i < 20; i += 1) {
      const res = await serve(file)
      const reader = res.body!.getReader()
      await reader.read()
      await reader.cancel()
    }
    // Not a descriptor count -- the platform owns that -- but the fact that a
    // twenty-first open still succeeds, which is what a leak would take away.
    const res = await serve(file)
    assert.equal(res.status, 200)
    assert.equal((await res.arrayBuffer()).byteLength, 4 * 1024 * 1024)
  })
})
