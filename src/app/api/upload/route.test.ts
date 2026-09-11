import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

// macOS hands the browser decomposed filenames: "á" is "a" + U+0301.
const NFD_NAME = 'Kockázati jelentés1.pdf'

test('upload route stores a percent-encoded accented filename readably', () => {
  const output = runWithTempDataDir<{ status: number; url: string; savedNames: string[] }>(`
    const fs = await import('fs')
    const routeMod = await import('@/app/api/upload/route')
    const route = routeMod.default || routeMod
    const uploadPathMod = await import('@/lib/server/upload-path')
    const { UPLOAD_DIR } = uploadPathMod.default || uploadPathMod

    const res = await route.POST(new Request('http://local/api/upload', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(${JSON.stringify(NFD_NAME)}) },
      body: Buffer.from('%PDF-1.7 test'),
    }))
    const body = await res.json()

    console.log(JSON.stringify({
      status: res.status,
      url: body.url,
      savedNames: fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : [],
    }))
  `)

  assert.equal(output.status, 200)
  assert.equal(output.savedNames.length, 1)
  assert.match(output.savedNames[0], /-Kockazati_jelentes1\.pdf$/)
  assert.ok(output.url.endsWith(output.savedNames[0]))
})

test('upload route still accepts a plain ascii filename from an older client', () => {
  const output = runWithTempDataDir<{ savedNames: string[] }>(`
    const fs = await import('fs')
    const routeMod = await import('@/app/api/upload/route')
    const route = routeMod.default || routeMod
    const uploadPathMod = await import('@/lib/server/upload-path')
    const { UPLOAD_DIR } = uploadPathMod.default || uploadPathMod

    await route.POST(new Request('http://local/api/upload', {
      method: 'POST',
      headers: { 'x-filename': 'report.pdf' },
      body: Buffer.from('%PDF-1.7 test'),
    }))

    console.log(JSON.stringify({ savedNames: fs.readdirSync(UPLOAD_DIR) }))
  `)

  assert.match(output.savedNames[0], /-report\.pdf$/)
})
