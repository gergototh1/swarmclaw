import assert from 'node:assert/strict'
import test from 'node:test'

import { freshRepo } from './helpers.mjs'

function refusal(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

/**
 * Schema tests for the publish module (Task 1: the module's skeleton).
 *
 * These pin the two decisions design spec 3 exists to make: an account is
 * keyed on (platform, kulso_id) and upserts rather than duplicates, and a
 * branch is keyed on (kiadas_id, platform) so a release can never carry two
 * rows for the same outlet. Both keys are asserted at the INDEX, not only in
 * application code (brief 1.5) -- a repository method that forgot the check
 * would still be caught by the database.
 */

test('a kiadás ágai platformonként egy sor, és a kiadás nem duplázódik', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  assert.equal(k.allapot, 'vazlat')
  repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  repo.ujAg({ kiadasId: k.id, platform: 'tiktok' })
  assert.deepEqual(repo.agak(k.id).map((a) => a.platform), ['youtube', 'tiktok'])
  assert.throws(() => repo.ujAg({ kiadasId: k.id, platform: 'youtube' }), /platform/,
    'egy kiadáson egy platform egyszer szerepel')
})

test('a fiók platformonként és külső id szerint egyedi', () => {
  const { repo } = freshRepo()
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'A csatornám' })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Átnevezve' })
  assert.equal(repo.fiokok().length, 1, 'ugyanaz a fiók frissül, nem duplázódik')
  assert.equal(repo.fiokok()[0].nev, 'Átnevezve')
})

test('két különböző fiók platformonként és külső id szerint két sor', () => {
  const { repo } = freshRepo()
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Egyik' })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC2', nev: 'Másik' })
  repo.fiokotIr({ platform: 'tiktok', kulsoId: 'UC1', nev: 'Ugyanaz a külső id, más platform' })
  assert.equal(repo.fiokok().length, 3)
})

test('ujAg refuses an unknown platform by name, without echoing the caller\'s value', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const err = refusal(() => repo.ujAg({ kiadasId: k.id, platform: 'myspace' }))
  assert.ok(err, 'nem utasította el')
  assert.match(err.message, /platform/)
  assert.equal(err.message.includes('myspace'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')
})

test('fiokotIr refuses an unknown platform by name, without echoing the caller\'s value', () => {
  const { repo } = freshRepo()
  const err = refusal(() => repo.fiokotIr({ platform: 'myspace', kulsoId: 'X', nev: 'Bármi' }))
  assert.ok(err, 'nem utasította el')
  assert.match(err.message, /platform/)
  assert.equal(err.message.includes('myspace'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')
})

test('ujKiadas stores the videoId and starts with no assigned sáv', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v42' })
  assert.equal(k.video_id, 'v42')
  assert.equal(k.sav_id, null)
  assert.equal(k.felulirt_idopont, null)
  assert.equal(typeof k.letrehozva_at, 'string')
})

test('agak returns only the branches of the release asked for, in creation order', () => {
  const { repo } = freshRepo()
  const k1 = repo.ujKiadas({ videoId: 'v1' })
  const k2 = repo.ujKiadas({ videoId: 'v2' })
  repo.ujAg({ kiadasId: k1.id, platform: 'youtube' })
  repo.ujAg({ kiadasId: k2.id, platform: 'facebook' })
  repo.ujAg({ kiadasId: k1.id, platform: 'instagram' })
  assert.deepEqual(repo.agak(k1.id).map((a) => a.platform), ['youtube', 'instagram'])
  assert.deepEqual(repo.agak(k2.id).map((a) => a.platform), ['facebook'])
})

test('a séma mind a négy táblát létrehozza', () => {
  const { storage } = freshRepo()
  const names = storage.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_publish_%' ORDER BY name").all().map((r) => r.name)
  assert.deepEqual(names, ['ext_publish_agak', 'ext_publish_fiokok', 'ext_publish_kiadasok', 'ext_publish_savok'])
})
