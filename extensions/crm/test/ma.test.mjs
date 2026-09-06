import assert from 'node:assert/strict'
import test from 'node:test'

import { valaszthatoKapcsolatok } from '../ui/ma.tsx'

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
