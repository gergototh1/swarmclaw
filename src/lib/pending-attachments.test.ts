import assert from 'node:assert/strict'
import { test } from 'node:test'

import { splitPendingAttachments } from './pending-attachments'
import type { PendingFile } from '@/stores/use-chat-store'

function pending(name: string, type: string): PendingFile {
  return { file: new File([], name, { type }), path: `/uploads/${name}`, url: `/api/uploads/${name}` }
}

test('a single non-image attachment does not travel as imagePath', () => {
  // Ez volt a hiba: egyetlen csatolmány mindig az `imagePath`-ba került, tehát
  // egy .docx-et a providerek képként jelentettek be a modellnek.
  const out = splitPendingAttachments([pending('ajanlat.docx', '')])
  assert.equal(out.imagePath, undefined)
  assert.deepEqual(out.attachedFiles, ['/uploads/ajanlat.docx'])
})

test('the first image keeps imagePath, and is also listed', () => {
  const out = splitPendingAttachments([pending('a.png', 'image/png'), pending('b.png', 'image/png')])
  assert.equal(out.imagePath, '/uploads/a.png')
  assert.equal(out.imageUrl, '/api/uploads/a.png')
  // A fogyasztók útvonal szerint deduplikálnak, tehát a felsorolás teljes lehet.
  assert.deepEqual(out.attachedFiles, ['/uploads/a.png', '/uploads/b.png'])
})

test('an image after a document is still the one imagePath names', () => {
  const out = splitPendingAttachments([pending('a.docx', ''), pending('b.jpg', 'image/jpeg')])
  assert.equal(out.imagePath, '/uploads/b.jpg')
  assert.deepEqual(out.attachedFiles, ['/uploads/a.docx', '/uploads/b.jpg'])
})

test('every attachment is listed, not just the second onwards', () => {
  // Az `attachedFiles` korábban csak kettőtől töltődött.
  const out = splitPendingAttachments([pending('only.txt', 'text/plain')])
  assert.deepEqual(out.attachedFiles, ['/uploads/only.txt'])
})

test('nothing attached means nothing set', () => {
  assert.deepEqual(splitPendingAttachments([]), { imagePath: undefined, imageUrl: undefined, attachedFiles: undefined })
})
