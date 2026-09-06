import assert from 'node:assert/strict'
import test from 'node:test'

import { kivalasztasLathato, valaszthatoKapcsolatok } from '../ui/ma.tsx'

/**
 * A besorolatlan-sor kapcsolat-választója a sweep találgatását (`guess_account_id`)
 * használja szűrésre, hogy a leggyakoribb esetben egy kattintással megtalálható
 * legyen a helyes kapcsolat. Két csapda ellen védekezik ez a függvény:
 *
 * 1. A találgatás téves lehet -- a helyes kapcsolat egy másik ügyfélhez tartozik.
 * 2. A helyes kapcsolat még nincs ügyfélhez kötve (`accountId: null`) -- ez a
 *    leggyakoribb ok, amiért a levél egyáltalán a besorolatlan sorba kerül.
 *
 * Mindkét esetben a kezelőnek látnia kell a kapcsolatot, különben a lista
 * használhatatlan és nincs kiút belőle a nézet elhagyása nélkül.
 */

const KAPCSOLATOK = [
  { id: 'c_guess', name: 'Guess Ügyfél Kapcsolata', accountId: 'acc_talalt', accountName: 'Talált Kft.' },
  { id: 'c_mas', name: 'Másik Ügyfél Kapcsolata', accountId: 'acc_masik', accountName: 'Másik Kft.' },
  { id: 'c_unlinked', name: 'Kötetlen Kapcsolat', accountId: null, accountName: '' },
]

test('találgatással, "mindet" nélkül: a találgatott ügyfél kapcsolatai és a kötetlenek, mások nem', () => {
  const eredmeny = valaszthatoKapcsolatok(KAPCSOLATOK, 'acc_talalt', false)
  const ids = eredmeny.map((c) => c.id).sort()
  assert.deepEqual(ids, ['c_guess', 'c_unlinked'])
})

test('találgatással, "mindet" bekapcsolva: minden kapcsolat látszik', () => {
  const eredmeny = valaszthatoKapcsolatok(KAPCSOLATOK, 'acc_talalt', true)
  const ids = eredmeny.map((c) => c.id).sort()
  assert.deepEqual(ids, ['c_guess', 'c_mas', 'c_unlinked'])
})

test('találgatás nélkül minden kapcsolat látszik, "mindet" állásától függetlenül', () => {
  for (const mindet of [false, true]) {
    const eredmeny = valaszthatoKapcsolatok(KAPCSOLATOK, null, mindet)
    const ids = eredmeny.map((c) => c.id).sort()
    assert.deepEqual(ids, ['c_guess', 'c_mas', 'c_unlinked'])
  }
})

test('a kötetlen kapcsolat a találgatással szűkített listában is jelen van (a korábban eltört eset)', () => {
  const eredmeny = valaszthatoKapcsolatok(KAPCSOLATOK, 'acc_talalt', false)
  assert.ok(eredmeny.some((c) => c.id === 'c_unlinked'), 'a kötetlen kapcsolatnak látszania kell')
})

/**
 * `kivalasztasLathato`: az "Összes kapcsolat" jelölőnégyzet ki/be
 * kapcsolása szűkíti vagy bővíti a látható listát, de nem törli a korábbi
 * kiválasztást. Enélkül a guard nélkül a "Hozzárendel" gomb egy olyan
 * kapcsolatra rendelne hozzá, amit az operátor a szűkített listában már nem
 * is lát -- ez a `attachEmail` miatt véglegesen (és tévesen) tanulja meg a
 * feladó címét egy másik ügyfélhez kötött kapcsolatra.
 */
test('kivalasztasLathato hamis, ha a kivalasztott id kiesett a szukitett listabol', () => {
  const szukitett = valaszthatoKapcsolatok(KAPCSOLATOK, 'acc_talalt', false)
  assert.equal(kivalasztasLathato('c_mas', szukitett), false)
})

test('kivalasztasLathato igaz, ha a kivalasztott id a lathato listaban van', () => {
  const szukitett = valaszthatoKapcsolatok(KAPCSOLATOK, 'acc_talalt', false)
  assert.equal(kivalasztasLathato('c_guess', szukitett), true)
  assert.equal(kivalasztasLathato('c_unlinked', szukitett), true)
})

test('kivalasztasLathato hamis ures id-re, akkor is ha a lista nem ures', () => {
  assert.equal(kivalasztasLathato('', KAPCSOLATOK), false)
})

test('mindet bekapcsolasa utan a korabban lathatatlan kivalasztas ismet lathatova valik', () => {
  const mindettel = valaszthatoKapcsolatok(KAPCSOLATOK, 'acc_talalt', true)
  assert.equal(kivalasztasLathato('c_mas', mindettel), true)
})
