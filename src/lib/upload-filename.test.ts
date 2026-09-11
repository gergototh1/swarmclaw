import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFilenameHeader, decodeFilenameHeader, safeUploadFilename } from './upload-filename'

// macOS stores filenames decomposed (NFD): "á" is "a" + U+0301.
const NFD_NAME = 'Kockázati jelentés1.pdf'
const NFC_NAME = NFD_NAME.normalize('NFC')

test('encoded header value is safe to put in an HTTP header', () => {
  // The browser rejects any code point above U+00FF in a header value.
  assert.ok(Math.max(...[...NFD_NAME].map((c) => c.codePointAt(0) ?? 0)) > 0xff)
  for (const ch of encodeFilenameHeader(NFD_NAME)) {
    assert.ok((ch.codePointAt(0) ?? 0) <= 0xff, `unsafe code point in header: ${ch}`)
  }
})

test('encode/decode round-trips an accented filename', () => {
  assert.equal(decodeFilenameHeader(encodeFilenameHeader(NFD_NAME), 'x.bin'), NFC_NAME)
})

test('encode/decode round-trips non-latin filenames', () => {
  const name = 'риск отчёт 日本語.pdf'
  assert.equal(decodeFilenameHeader(encodeFilenameHeader(name), 'x.bin'), name.normalize('NFC'))
})

test('decode falls back for missing or undecodable header values', () => {
  assert.equal(decodeFilenameHeader(null, 'image.png'), 'image.png')
  assert.equal(decodeFilenameHeader('', 'image.png'), 'image.png')
  // A pre-fix client sending a raw name with a stray percent must not throw.
  assert.equal(decodeFilenameHeader('100%-done.pdf', 'image.png'), '100%-done.pdf')
})

test('safeUploadFilename keeps accented names readable instead of mangling them', () => {
  assert.equal(safeUploadFilename(NFD_NAME), 'Kockazati_jelentes1.pdf')
  assert.equal(safeUploadFilename(NFC_NAME), 'Kockazati_jelentes1.pdf')
})

test('safeUploadFilename strips path separators and falls back when nothing survives', () => {
  assert.equal(safeUploadFilename('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(safeUploadFilename('日本語'), 'file')
  assert.equal(safeUploadFilename('   '), 'file')
})
