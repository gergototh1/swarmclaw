import assert from 'node:assert/strict'
import test from 'node:test'

import { AG_KEZDO_ALLAPOT, KIADAS_KEZDO_ALLAPOT } from '../src/db.mjs'
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
  const yt = repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  const tt = repo.ujAg({ kiadasId: k.id, platform: 'tiktok' })
  // A frissen nyitott ág VÁR. Ez a modul legélesebb "három tény, három
  // állapot" pontja: egy ág, ami születésekor `kiment`-et állít, azt a tényt
  // állítja, amit senki nem figyelt meg -- és a naptár, az újrapróbálás meg a
  // részleges-kiadás számolás mind erre az egy szóra épül. A konstansra ÉS a
  // szóra is állítunk: a konstans átírása így nem viszi magával a tesztet.
  assert.equal(AG_KEZDO_ALLAPOT, 'var')
  assert.equal(yt.allapot, 'var', 'egy frissen nyitott ág vár, nem ment ki')
  assert.equal(tt.allapot, 'var', 'egy frissen nyitott ág vár, nem ment ki')
  assert.deepEqual(repo.agak(k.id).map((a) => a.allapot), ['var', 'var'])
  assert.equal(KIADAS_KEZDO_ALLAPOT, 'vazlat')
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

test('a fiók-kulcs az adatbázison áll: a fiokotIr megkerülésével sem lehet duplikálni', () => {
  // A 37. sori teszt csak azt bizonyítja, hogy a `fiokotIr` nem duplikál --
  // azt egy tisztán alkalmazás-szintű ellenőrzés is teljesítené, és akkor egy
  // MÁSODIK írásút (egy migráció, egy import, egy párhuzamos folyamat) semmi
  // nem tartana vissza. Ez a teszt a `storage.raw`-on át, a repository-t
  // megkerülve szúr be, tehát csak az INDEX utasíthatja vissza.
  const { storage, repo } = freshRepo()
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'A csatornám' })
  const t = new Date().toISOString()
  assert.throws(
    () => storage.raw
      .prepare('INSERT INTO ext_publish_fiokok (id, platform, kulso_id, nev, csatlakoztatva_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('masik_iro', 'youtube', 'UC1', 'Egy másik írásút', t, t),
    /UNIQUE constraint failed: ext_publish_fiokok\.platform, ext_publish_fiokok\.kulso_id/,
    'az adatbázis engedte a duplikált (platform, kulso_id) párt',
  )
  assert.equal(repo.fiokok().length, 1)
})

test('az ág-kulcs is az adatbázison áll: a ujAg megkerülésével sem lehet duplikálni', () => {
  const { storage, repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  const t = new Date().toISOString()
  assert.throws(
    () => storage.raw
      .prepare('INSERT INTO ext_publish_agak (id, kiadas_id, platform, szoveg, allapot, hiba_kod, url, kikuldve_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('masik_iro', k.id, 'youtube', null, 'var', null, null, null, t, t),
    /UNIQUE constraint failed: ext_publish_agak\.kiadas_id, ext_publish_agak\.platform/,
    'az adatbázis engedte a duplikált (kiadas_id, platform) párt',
  )
  assert.equal(repo.agak(k.id).length, 1)
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
