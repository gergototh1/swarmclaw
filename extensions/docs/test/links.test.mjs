import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { extractLinks, linkRowsFor, renameLinksTo, resolveLink } from '../src/links.mjs'
import { memStorage } from './helpers.mjs'

function fresh() {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  return createRepo(s)
}

function doc(over = {}) {
  return {
    id: 'doc_1', path: 'kozos/a.md', title: 'Ügyfélprofil', owner: 'user', tags: [],
    created: '', updated: '', size: 0, hash: '', version: 1, body: '', ...over,
  }
}

test('extractLinks takes each link once, in order', () => {
  assert.deepEqual(
    extractLinks('Lásd [[Egy]] és [[Kettő]], majd megint [[Egy]].'),
    ['Egy', 'Kettő'],
  )
})

test('extractLinks ignores fenced code and inline code', () => {
  const body = [
    'Szöveg [[Valódi]].',
    '',
    '```js',
    'const x = "[[Nem link]]"',
    '```',
    '',
    'Inline `[[Szintén nem]]` után [[Másik valódi]].',
  ].join('\n')
  assert.deepEqual(extractLinks(body), ['Valódi', 'Másik valódi'])
})

test('extractLinks handles a tilde fence and an unclosed one', () => {
  assert.deepEqual(extractLinks('~~~\n[[Rejtve]]\n~~~\n[[Látszik]]'), ['Látszik'])
  // Egy le nem zárt kerítés a fájl végéig tart: ami benne van, az kód.
  assert.deepEqual(extractLinks('[[Előtte]]\n```\n[[Utána]]'), ['Előtte'])
})

test('extractLinks tolerates a broken bracket without hanging', () => {
  assert.deepEqual(extractLinks('Fél [[link és vége'), [])
  assert.deepEqual(extractLinks('[[]] üres'), [])
  assert.deepEqual(extractLinks('[[   ]] csak szóköz'), [])
  assert.deepEqual(extractLinks('[[egy\nsortoressel]]'), [])
})

test('resolveLink prefers an id, then an exact title, then a folded one', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik' }))

  assert.equal(resolveLink(r, 'doc_2'), 'doc_2')
  assert.equal(resolveLink(r, 'Ügyfélprofil'), 'doc_1')
  assert.equal(resolveLink(r, 'ÜGYFÉLPROFIL'), 'doc_1')
  assert.equal(resolveLink(r, 'Nincs ilyen'), null)
})

test('linkRowsFor keeps the raw text even when nothing resolves', () => {
  const r = fresh()
  r.upsertDoc(doc())
  assert.deepEqual(linkRowsFor(r, 'a [[Ügyfélprofil]] és [[Nincs még]]'), [
    { toId: 'doc_1', toRaw: 'Ügyfélprofil' },
    { toId: null, toRaw: 'Nincs még' },
  ])
})

test('renameLinksTo rewrites the title links and reports what it wrote', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Hivatkozó' }))
  r.setLinks('doc_2', [{ toId: 'doc_1', toRaw: 'Ügyfélprofil' }])

  const bodies = { 'kozos/b.md': 'Lásd [[Ügyfélprofil]] és [[doc_1]] is.\n' }
  const res = renameLinksTo(r, {
    docId: 'doc_1',
    oldTitle: 'Ügyfélprofil',
    newTitle: 'Morvai profil',
    canWrite: () => true,
    readBody: (p) => bodies[p],
    writeBody: (p, body) => { bodies[p] = body },
  })

  assert.deepEqual(res.frissitett, ['kozos/b.md'])
  assert.deepEqual(res.kihagyott, [])
  // A címre mutató link átíródik, az id-re mutató érintetlen marad.
  assert.equal(bodies['kozos/b.md'], 'Lásd [[Morvai profil]] és [[doc_1]] is.\n')
})

test('renameLinksTo skips a referrer it may not write, and names it', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'agents/kutato/b.md', title: 'Zárt' }))
  r.setLinks('doc_2', [{ toId: 'doc_1', toRaw: 'Ügyfélprofil' }])

  const bodies = { 'agents/kutato/b.md': 'Lásd [[Ügyfélprofil]].\n' }
  const res = renameLinksTo(r, {
    docId: 'doc_1',
    oldTitle: 'Ügyfélprofil',
    newTitle: 'Morvai profil',
    canWrite: (p) => !p.startsWith('agents/kutato/'),
    readBody: (p) => bodies[p],
    writeBody: (p, body) => { bodies[p] = body },
  })

  assert.deepEqual(res.frissitett, [])
  assert.deepEqual(res.kihagyott, ['agents/kutato/b.md'])
  assert.equal(bodies['agents/kutato/b.md'], 'Lásd [[Ügyfélprofil]].\n', 'mégis írt bele')
})

test('renameLinksTo does not touch a link inside a code fence', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Hivatkozó' }))
  r.setLinks('doc_2', [{ toId: 'doc_1', toRaw: 'Ügyfélprofil' }])

  const eredeti = 'Valódi [[Ügyfélprofil]].\n\n```\npélda: [[Ügyfélprofil]]\n```\n'
  const bodies = { 'kozos/b.md': eredeti }
  renameLinksTo(r, {
    docId: 'doc_1',
    oldTitle: 'Ügyfélprofil',
    newTitle: 'Morvai profil',
    canWrite: () => true,
    readBody: (p) => bodies[p],
    writeBody: (p, body) => { bodies[p] = body },
  })

  assert.equal(bodies['kozos/b.md'], 'Valódi [[Morvai profil]].\n\n```\npélda: [[Ügyfélprofil]]\n```\n')
})

test('renameLinksTo writes nothing when no body actually changed', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Hivatkozó' }))
  r.setLinks('doc_2', [{ toId: 'doc_1', toRaw: 'doc_1' }])

  const bodies = { 'kozos/b.md': 'Csak id szerint: [[doc_1]].\n' }
  let irasok = 0
  const res = renameLinksTo(r, {
    docId: 'doc_1',
    oldTitle: 'Ügyfélprofil',
    newTitle: 'Morvai profil',
    canWrite: () => true,
    readBody: (p) => bodies[p],
    writeBody: () => { irasok += 1 },
  })

  assert.equal(irasok, 0)
  assert.deepEqual(res.frissitett, [])
})
