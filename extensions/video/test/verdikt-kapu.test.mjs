import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JAVITAS_LANC_MAX, verdiktJog } from '../src/verdikt-kapu.mjs'
import { PELDA_JELENETEK, PELDA_NARRACIO, freshRepo } from './helpers.mjs'

/**
 * A verdikt-kapu a maga szintjén, a toolok nélkül.
 *
 * Ezek a tesztek a repository fölött futnak és semmilyen Remotion-projektet
 * nem kérnek: a kapu kérdése ("van-e joga ennek a tervnek továbbmenni") csak
 * tervsorokról és verdiktsorokról szól. A `videoRevise` végpont-tesztjei a
 * `test/terv.test.mjs`-ben vannak; itt az a séta van kimérve, amit a narráció
 * és a render is meg fog hívni.
 */
function fixture() {
  const { storage, repo } = freshRepo()
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'f', nyitottaAgentId: '' })
  const terv = (extra = {}) => {
    const t = repo.insertTerv({
      videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [],
      katalogusHash: 'kh', szerzoAgentId: 'gyarto-1', szerzoSessionId: 's1', ellenorzes: { figyelmeztetesek: [] }, ...extra,
    })
    return repo.terv(t.id)
  }
  const atenged = (row) => repo.insertVerdikt({ tervId: row.id, tervHash: row.terv_hash, lektorAgentId: 'lektor-1', lektorSessionId: 's2', verdikt: 'atmegy', talalatok: [] })
  const elbuktat = (row) => repo.insertVerdikt({ tervId: row.id, tervHash: row.terv_hash, lektorAgentId: 'lektor-1', lektorSessionId: 's2', verdikt: 'elbukik', talalatok: [{ jelenet: 0, kod: 'horog_gyenge', szoveg: 'x' }] })
  const javitas = (szulo) => terv({ szarmazas: 'operator_javitas', javitasIdk: [], szuloTervId: szulo.id })
  return { storage, repo, terv, atenged, elbuktat, javitas }
}

test('saját atmegy verdikt átengedi a tervet, és megnevezi, melyik terv és melyik verdikt volt az', () => {
  const { repo, terv, atenged } = fixture()
  const v1 = terv()
  const verdikt = atenged(v1)
  assert.deepEqual(verdiktJog(repo, v1), { ok: true, verdiktId: verdikt.id, atmentTervId: v1.id })
})

test('rendes terv verdikt nélkül verdikt_hianyzik, elbuktatott után verdikt_elavult', () => {
  const { repo, terv, atenged, elbuktat } = fixture()
  const nincs = terv()
  const a = verdiktJog(repo, nincs)
  assert.equal(a.ok, false); assert.equal(a.kod, 'verdikt_hianyzik')

  // `passingVerdikt` a LEGFRISSEBB ítéletet nézi, tehát egy visszavont
  // átengedés nem engedi tovább a tervet -- de az, hogy volt már atmegy,
  // más tény, mint hogy soha nem ítélték meg, és más kódot kap.
  const visszavont = terv()
  atenged(visszavont)
  elbuktat(visszavont)
  const b = verdiktJog(repo, visszavont)
  assert.equal(b.ok, false); assert.equal(b.kod, 'verdikt_elavult')
})

test('a jog a javítás-láncon öröklődik: egy ugrás és két ugrás is átmegy', () => {
  const { repo, terv, atenged, javitas } = fixture()
  const v1 = terv()
  const verdikt = atenged(v1)
  const v2 = javitas(v1)
  // A javításnak SOSEM lesz saját verdiktje; a válasz mégis ok, és megnevezi,
  // melyik ős volt az, amit a lektor tényleg átengedett.
  assert.equal(repo.passingVerdikt(v2.id, v2.terv_hash), null)
  assert.deepEqual(verdiktJog(repo, v2), { ok: true, verdiktId: verdikt.id, atmentTervId: v1.id })
  const v3 = javitas(v2)
  assert.deepEqual(verdiktJog(repo, v3), { ok: true, verdiktId: verdikt.id, atmentTervId: v1.id })
})

test('egy javítás, aminek a lánc alján nincs átment terve, szulo_verdikt_hianyzik-ot kap, nem verdikt_hianyzik-ot', () => {
  const { repo, terv, javitas } = fixture()
  const v1 = terv()
  const v2 = javitas(v1)
  const r = verdiktJog(repo, v2)
  assert.equal(r.ok, false)
  // A kettő szétválasztása a lényeg: a `verdikt_hianyzik` a hívó saját
  // beadásáról szólna, és azt üzenné, hogy azt kell lektoráltatni -- egy
  // javítást viszont soha nem fognak lektorálni. A lánc alját kell.
  assert.equal(r.kod, 'szulo_verdikt_hianyzik')
  assert.equal(verdiktJog(repo, v1).kod, 'verdikt_hianyzik')
})

test('a séta megáll a korlátnál, akkor is, ha a lánc egyébként ép', () => {
  const { repo, terv, atenged, javitas } = fixture()
  const gyoker = terv()
  atenged(gyoker)
  let jelen = gyoker
  for (let i = 0; i < JAVITAS_LANC_MAX; i += 1) jelen = javitas(jelen)
  // A korláton belül a gyökér még elérhető...
  const meg = repo.terv(jelen.szulo_terv_id)
  assert.equal(verdiktJog(repo, meg).ok, true)
  // ...egy generációval feljebb már nem, és a modul ezt mondja ki, nem azt,
  // hogy nincs átengedett terv: itt nem a lektoron múlik semmi.
  const r = verdiktJog(repo, jelen)
  assert.equal(r.ok, false)
  assert.equal(r.kod, 'javitas_lanc_hibas')
})

test('egy körré csavart lánc nem viszi el a hostot, és megnevezett hibát ad', () => {
  const { storage, repo, terv, javitas } = fixture()
  const v1 = terv()
  const v2 = javitas(v1)
  const v3 = javitas(v2)
  // A gyökeret javítássá tesszük, és a szülőjét egy leszármazottjára
  // állítjuk: ezt a schema nem tiltja (nincs FOREIGN KEY, `src/db.mjs`), egy
  // félig migrált vagy kézzel írt sor előállíthatja.
  storage.exec("UPDATE ext_video_tervek SET szarmazas = 'operator_javitas', szulo_terv_id = ? WHERE id = ?", [v3.id, v1.id])
  // KÉT KÜLÖN ÁLLÍTÁS, mert két külön sor felel értük. Hogy a hívás egyáltalán
  // VÉGET ÉR és megnevezett hibát ad, azt a `JAVITAS_LANC_MAX` korlát
  // garantálja -- a `latott` halmaz nélkül is így lenne, csak ötven olvasás
  // után. Amit a `latott` halmaz tesz hozzá, az az, hogy a séta A KÖRNÉL áll
  // meg, nem a korlátnál; ezt csak az olvasások száma mutatja meg, ezért van
  // itt egy számláló a `terv` körül. E nélkül a `latott` sor törlése nem
  // buktatna el egyetlen tesztet sem.
  let olvasas = 0
  const szamlalo = { ...repo, terv: (id) => { olvasas += 1; return repo.terv(id) } }
  const r = verdiktJog(szamlalo, v3)
  assert.equal(r.ok, false)
  assert.equal(r.kod, 'javitas_lanc_hibas')
  assert.ok(olvasas < 10, `a séta a körnél áll meg, nem a korlátnál; ${olvasas} olvasás történt`)
})

test('egy javítás, aminek a szülője nincs meg, ugyanaz a romlott lánc, nem hiányzó ítélet', () => {
  const { storage, repo, terv, javitas } = fixture()
  const v1 = terv()
  const v2 = javitas(v1)
  storage.exec('UPDATE ext_video_tervek SET szulo_terv_id = NULL WHERE id = ?', [v2.id])
  const r = verdiktJog(repo, repo.terv(v2.id))
  assert.equal(r.kod, 'javitas_lanc_hibas', 'egy sehová sem mutató szülő nem lektorálási kérdés')
})
