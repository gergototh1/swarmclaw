import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collectConversationFiles } from './conversation-files'
import type { Message } from '@/types'

function msg(over: Partial<Message>): Message {
  return { role: 'user', text: '', time: 0, ...over } as Message
}

describe('collectConversationFiles', () => {
  it('finds what the operator attached, image and document alike', () => {
    const files = collectConversationFiles([
      msg({
        time: 10,
        imagePath: '/data/uploads/61f9a28c-kep.png',
        imageUrl: '/api/uploads/61f9a28c-kep.png',
        attachedFiles: ['/data/uploads/61f9a28c-kep.png', '/data/uploads/aa11bb22-ajanlat.docx'],
      }),
    ])
    assert.deepEqual(files.map((f) => f.name), ['kep.png', 'ajanlat.docx'])
    assert.ok(files.every((f) => f.origin === 'attached'))
    // Az imagePath és az attachedFiles ugyanazt a fájlt is viheti; egyszer kell.
    assert.equal(files.length, 2)
  })

  it('finds what the agent produced, from the reply and from a tool result', () => {
    const files = collectConversationFiles([
      msg({ role: 'assistant', time: 20, text: 'Kész: [Download terv.md](/api/uploads/1788941782829-terv.md)' }),
      msg({
        role: 'assistant',
        time: 30,
        text: 'Megvan.',
        toolEvents: [{ name: 'send_file', input: '{}', output: '[Download jelentes.pdf](/api/uploads/1788941799000-jelentes.pdf)' }],
      }),
    ])
    // A név elől lekerül a tárolt azonosító; a `Date.now()`-előtag a valódi
    // alak (session-tools/file.ts), a hexes a feltöltő route-é.
    assert.deepEqual(files.map((f) => f.name), ['jelentes.pdf', 'terv.md'])
    assert.ok(files.every((f) => f.origin === 'produced'))
  })

  it('leaves a path in prose alone', () => {
    // Csak a saját `/api/uploads/` előtag számít. Egy szövegbeli útvonal nem
    // fájl-hivatkozás, és egy rossz sor a fájllistában rosszabb, mint egy hiány.
    const files = collectConversationFiles([
      msg({ role: 'assistant', text: 'Mentsd ide: /Users/valaki/Desktop/valami.pdf vagy ~/x.docx' }),
    ])
    assert.deepEqual(files, [])
  })

  it('lists the newest first', () => {
    const files = collectConversationFiles([
      msg({ role: 'assistant', time: 1, text: '[a](/api/uploads/1788941700000-regi.md)' }),
      msg({ role: 'assistant', time: 9, text: '[b](/api/uploads/1788941900000-uj.md)' }),
    ])
    assert.deepEqual(files.map((f) => f.name), ['uj.md', 'regi.md'])
  })

  it('drops the stored id from the displayed name but keeps it in the url', () => {
    const [file] = collectConversationFiles([
      msg({ time: 1, attachedFiles: ['/data/uploads/61f9a28c-proba.docx'] }),
    ])
    assert.equal(file.name, 'proba.docx')
    assert.equal(file.url, '/api/uploads/61f9a28c-proba.docx')
  })

  it('says which message a file came from', () => {
    const files = collectConversationFiles([
      msg({ time: 1, text: 'szia' }),
      msg({ time: 2, attachedFiles: ['/data/uploads/61f9a28c-a.txt'] }),
    ])
    assert.equal(files[0].messageIndex, 1)
  })

  it('returns nothing for a conversation with no files', () => {
    assert.deepEqual(collectConversationFiles([msg({ text: 'csak szöveg' })]), [])
  })
})
