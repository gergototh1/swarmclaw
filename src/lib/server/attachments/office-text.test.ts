import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { crc32 } from 'node:zlib'

import { extractOfficeText, isOfficeDocument } from './office-text'

/**
 * The fixtures are real ZIP archives, built here rather than checked in.
 *
 * A hand-written reader is only worth trusting against bytes that a real writer
 * would produce, and both branches it supports have to be exercised: `stored`
 * and `deflate` are separate code paths, and a fixture that only used one would
 * leave the other unproven. The local header is given a DIFFERENT extra-field
 * length from the central directory on purpose -- Word does this, and a reader
 * that computes the data offset from the central entry reads garbage.
 */
function zip(files: { name: string; body: string; deflate: boolean; localExtra?: number }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.body, 'utf8')
    const data = file.deflate ? zlib.deflateRawSync(raw) : raw
    const method = file.deflate ? 8 : 0
    const extra = Buffer.alloc(file.localExtra ?? 0)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(extra.length, 28)
    locals.push(Buffer.concat([local, nameBuf, extra, data]))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    // No extra field here, while the local header above has one. The reader
    // must take the length from the local header.
    central.writeUInt16LE(0, 30)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))

    offset += 30 + nameBuf.length + extra.length + data.length
  }

  const localBlock = Buffer.concat(locals)
  const centralBlock = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBlock.length, 12)
  eocd.writeUInt32LE(localBlock.length, 16)
  return Buffer.concat([localBlock, centralBlock, eocd])
}

function withFile(name: string, buf: Buffer, run: (p: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-text-'))
  const file = path.join(dir, name)
  try {
    fs.writeFileSync(file, buf)
    run(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const DOCUMENT_XML = `<?xml version="1.0"?>
<w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>Ajánlat</w:t></w:r><w:r><w:t xml:space="preserve"> — 2026</w:t></w:r></w:p>
<w:p><w:r><w:t>Ár:</w:t></w:r><w:r><w:tab/><w:t>1 &amp; 2 &lt;fontos&gt;</w:t></w:r></w:p>
<w:p><w:r><w:t>Sor egy</w:t><w:br/><w:t>Sor kettő</w:t></w:r></w:p>
</w:body></w:document>`

test('a .docx gives up its paragraphs, tabs, line breaks and entities', () => {
  const buf = zip([
    { name: '[Content_Types].xml', body: '<Types/>', deflate: true },
    { name: 'word/document.xml', body: DOCUMENT_XML, deflate: true, localExtra: 12 },
  ])
  withFile('ajanlat.docx', buf, (p) => {
    const result = extractOfficeText(p)
    assert.ok(result, 'nem sikerült kibontani')
    assert.equal(result.kind, 'docx')
    assert.deepEqual(result.text.split('\n'), [
      'Ajánlat — 2026',
      'Ár:\t1 & 2 <fontos>',
      'Sor egy',
      'Sor kettő',
    ])
  })
})

test('a stored (uncompressed) entry reads the same as a deflated one', () => {
  // A .docx írható tömörítés nélkül is; a két ág külön kód, tehát külön eset.
  const buf = zip([{ name: 'word/document.xml', body: DOCUMENT_XML, deflate: false, localExtra: 4 }])
  withFile('tomoritetlen.docx', buf, (p) => {
    assert.match(extractOfficeText(p)?.text ?? '', /Ajánlat — 2026/)
  })
})

test('a .pptx reads its slides in order', () => {
  const slide = (t: string) => `<p:sld xmlns:a="x"><a:t>${t}</a:t></p:sld>`
  const buf = zip([
    { name: 'ppt/slides/slide10.xml', body: slide('Tizedik'), deflate: true },
    { name: 'ppt/slides/slide2.xml', body: slide('Második'), deflate: true },
    { name: 'ppt/slides/slide1.xml', body: slide('Első'), deflate: true },
  ])
  withFile('diak.pptx', buf, (p) => {
    // Sorrend szám szerint, nem szövegesen: a slide10 a slide2 UTÁN jön.
    assert.deepEqual(extractOfficeText(p)?.text.split('\n\n'), ['Első', 'Második', 'Tizedik'])
  })
})

test('an .xlsx reads its shared strings', () => {
  const shared = '<sst><si><t>Cégnév</t></si><si><r><t>Össz</t></r><r><t>eg</t></r></si></sst>'
  const buf = zip([{ name: 'xl/sharedStrings.xml', body: shared, deflate: true }])
  withFile('tabla.xlsx', buf, (p) => {
    assert.deepEqual(extractOfficeText(p)?.text.split('\n'), ['Cégnév', 'Összeg'])
  })
})

test('a file that is not a zip is declined rather than thrown on', () => {
  // Ez a fontos eset: a hívó a null-t "nevezd meg a fájlt" válasznak veszi.
  // Egy dobás itt az egész fordulót elvinné.
  withFile('hamis.docx', Buffer.from('this is not a zip at all'), (p) => {
    assert.equal(extractOfficeText(p), null)
  })
})

test('a ZIP64 archive is declined, not misread', () => {
  const buf = zip([{ name: 'word/document.xml', body: DOCUMENT_XML, deflate: true }])
  // A ZIP64-jelölő a központi könyvtár eltolásában; a valódi érték egy másik
  // rekordban van, amit ez az olvasó nem bont.
  buf.writeUInt32LE(0xffffffff, buf.length - 22 + 16)
  withFile('nagy.docx', buf, (p) => {
    assert.equal(extractOfficeText(p), null)
  })
})

test('a docx with no document part is declined', () => {
  const buf = zip([{ name: '[Content_Types].xml', body: '<Types/>', deflate: true }])
  withFile('ures.docx', buf, (p) => {
    assert.equal(extractOfficeText(p), null)
  })
})

test('isOfficeDocument names the three formats and nothing else', () => {
  for (const yes of ['a.docx', 'a.DOCX', '/x/y/b.xlsx', 'c.pptx']) {
    assert.equal(isOfficeDocument(yes), true, yes)
  }
  for (const no of ['a.doc', 'a.pdf', 'a.txt', 'a.zip', 'docx']) {
    assert.equal(isOfficeDocument(no), false, no)
  }
})

test('a missing file is declined rather than thrown on', () => {
  assert.equal(extractOfficeText('/nincs/ilyen/utvonal.docx'), null)
})
