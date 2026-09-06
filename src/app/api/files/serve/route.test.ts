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
