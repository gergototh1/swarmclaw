import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { crc32 } from 'node:zlib'

import { describeAttachment, buildAttachmentPreamble } from './attachment-text'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-text-'))
}

/** A one-entry .docx, deflated, exactly as the office-text tests build them. */
function docx(body: string): Buffer {
  const name = Buffer.from('word/document.xml', 'utf8')
  const raw = Buffer.from(`<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`, 'utf8')
  const data = zlib.deflateRawSync(raw)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
  const localBlock = Buffer.concat([local, name, data])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42)
  const centralBlock = Buffer.concat([central, name])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralBlock.length, 12); eocd.writeUInt32LE(localBlock.length, 16)
  return Buffer.concat([localBlock, centralBlock, eocd])
}

test('a .docx arrives as its text, not as its filename', async () => {
  // Ez a lényeg: a régi útvonalon minden ismeretlen formátum ugyanabban a
  // `[Attached file: név]` sorban végződött, tartalom nélkül.
  const dir = tempDir()
  try {
    const file = path.join(dir, 'ajanlat.docx')
    fs.writeFileSync(file, docx('A vállalási ár 1 200 000 Ft.'))
    const out = await describeAttachment(file)
    assert.match(out, /Word document: ajanlat\.docx/)
    assert.match(out, /A vállalási ár 1 200 000 Ft\./)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a text file arrives as its contents', async () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'jegyzet.md')
    fs.writeFileSync(file, '# Cím\n\ntörzs')
    assert.match(await describeAttachment(file), /\[Attached file: jegyzet\.md\]\n\n# Cím/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an unknown binary is named WITH ITS PATH, so a CLI can open it', async () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'archivum.zip')
    fs.writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))
    const out = await describeAttachment(file)
    assert.match(out, /archivum\.zip/)
    assert.ok(out.includes(file), 'az útvonal nélkül a CLI-nek nincs mit megnyitnia')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an image is named with its path rather than read as text', async () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'kep.png')
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const out = await describeAttachment(file)
    assert.match(out, /\[Attached image: kep\.png at /)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a missing file is reported, not thrown on', async () => {
  assert.match(await describeAttachment('/nincs/ilyen/x.docx'), /not found/)
})

test('the preamble covers every attachment once, in order', async () => {
  const dir = tempDir()
  try {
    const a = path.join(dir, 'a.md')
    const b = path.join(dir, 'b.docx')
    fs.writeFileSync(a, 'alpha')
    fs.writeFileSync(b, docx('bravo'))
    // Ugyanaz az útvonal kétszer: a hívók az imagePath-t és az attachedFiles-t
    // is átadják, és azok átfedhetnek.
    const out = await buildAttachmentPreamble([a, b, a])
    assert.equal(out.match(/a\.md/g)?.length, 1, 'a duplikált útvonal kétszer szerepelt')
    assert.ok(out.indexOf('alpha') < out.indexOf('bravo'), 'nem tartotta a sorrendet')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('no attachments means no preamble at all', async () => {
  assert.equal(await buildAttachmentPreamble([]), '')
  assert.equal(await buildAttachmentPreamble(['', '']), '')
})
