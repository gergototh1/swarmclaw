import assert from 'node:assert/strict'
import test from 'node:test'

import { agentSlug, canRead, canWrite, homeFolderOf, ownerOf } from '../src/permissions.mjs'

const OPTS = { kozosMappaNev: 'kozos' }
const user = { kind: 'user' }
const marketing = { kind: 'agent', slug: 'marketing' }
const kutato = { kind: 'agent', slug: 'kutato' }
const videoExt = { kind: 'ext', name: 'video' }

test('agentSlug strips accents, lowercases and joins with dashes', () => {
  assert.equal(agentSlug('Marketing Ügynök', 'abc123def456'), 'marketing-ugynok')
  assert.equal(agentSlug('Kutató', 'abc123def456'), 'kutato')
  assert.equal(agentSlug('  Több   szóköz ', 'abc123def456'), 'tobb-szokoz')
  assert.equal(agentSlug('Kőműves Űrhajós', 'abc123def456'), 'komuves-urhajos')
})

test('agentSlug falls back to the id when the name leaves nothing', () => {
  // Enélkül az ügynök mappája 'agents//' lenne.
  assert.equal(agentSlug('', 'abc123def456'), 'abc123')
  assert.equal(agentSlug('!!!', 'abc123def456'), 'abc123')
  assert.equal(agentSlug(null, 'abc123def456'), 'abc123')
})

test('ownerOf and homeFolderOf name the actor consistently', () => {
  assert.equal(ownerOf(user), 'user')
  assert.equal(ownerOf(marketing), 'agent:marketing')
  assert.equal(ownerOf(videoExt), 'ext:video')
  assert.equal(homeFolderOf(user), null)
  assert.equal(homeFolderOf(marketing), 'agents/marketing')
  assert.equal(homeFolderOf(videoExt), 'agents/video')
})

test('everyone can read everything', () => {
  for (const actor of [user, marketing, videoExt]) {
    for (const p of ['agents/marketing/a.md', 'kozos/b.md', '_sablonok/c.md', '.swarmdocs/trash/doc_1/d.md']) {
      assert.equal(canRead(actor, p), true, `${JSON.stringify(actor)} nem olvashatja: ${p}`)
    }
  }
})

test('the operator can write anywhere outside the internal folders', () => {
  assert.equal(canWrite(user, 'agents/marketing/a.md', OPTS), true)
  assert.equal(canWrite(user, 'kozos/b.md', OPTS), true)
  assert.equal(canWrite(user, '_sablonok/c.md', OPTS), true)
  assert.equal(canWrite(user, 'barmi/mashol.md', OPTS), true)
  assert.equal(canWrite(user, 'gyoker-szinten.md', OPTS), true)
  // A kuka nem szerkeszthető, csak a kuka-műveleteken át.
  assert.equal(canWrite(user, '.swarmdocs/trash/doc_1/d.md', OPTS), false)
})

test('an agent writes its own folder and the shared one, nothing else', () => {
  assert.equal(canWrite(marketing, 'agents/marketing/a.md', OPTS), true)
  assert.equal(canWrite(marketing, 'agents/marketing/mely/mappa/a.md', OPTS), true)
  assert.equal(canWrite(marketing, 'kozos/b.md', OPTS), true)
  assert.equal(canWrite(marketing, 'kozos/mely/b.md', OPTS), true)

  assert.equal(canWrite(marketing, 'agents/kutato/a.md', OPTS), false)
  assert.equal(canWrite(kutato, 'agents/marketing/a.md', OPTS), false)
  assert.equal(canWrite(marketing, '_sablonok/c.md', OPTS), false)
  assert.equal(canWrite(marketing, '.swarmdocs/trash/doc_1/d.md', OPTS), false)
  assert.equal(canWrite(marketing, 'gyoker-szinten.md', OPTS), false)
})

test('a prefix that only looks like the home folder is refused', () => {
  assert.equal(canWrite(marketing, 'agents/marketing-2/a.md', OPTS), false)
  assert.equal(canWrite(marketing, 'agents/marketingx/a.md', OPTS), false)
  assert.equal(canWrite(marketing, 'kozosseg/b.md', OPTS), false)
})

test('the shared folder name comes from settings, not from a constant', () => {
  const opts = { kozosMappaNev: 'shared' }
  assert.equal(canWrite(marketing, 'shared/b.md', opts), true)
  assert.equal(canWrite(marketing, 'kozos/b.md', opts), false)
})

test('an extension writes its own folder and the shared one', () => {
  assert.equal(canWrite(videoExt, 'agents/video/forgatokonyv.md', OPTS), true)
  assert.equal(canWrite(videoExt, 'kozos/b.md', OPTS), true)
  assert.equal(canWrite(videoExt, 'agents/marketing/a.md', OPTS), false)
})

test('the exact folder path itself is not a writable file path', () => {
  assert.equal(canWrite(marketing, 'agents/marketing', OPTS), false)
  assert.equal(canWrite(marketing, 'kozos', OPTS), false)
})

test('an unknown actor kind may read but never write', () => {
  const idegen = { kind: 'valami' }
  assert.equal(canRead(idegen, 'kozos/a.md'), true)
  assert.equal(canWrite(idegen, 'kozos/a.md', OPTS), false)
  assert.equal(homeFolderOf(idegen), null)
})
