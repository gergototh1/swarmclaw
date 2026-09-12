import assert from 'node:assert/strict'
import { test } from 'node:test'

import { letrehozMentesSor } from '../ui/mentes-sor.ts'

/** Resolves on the next microtask/timer tick so scheduling order is explicit. */
function kesobb(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('ugyanahhoz a kulcshoz tartozó két futás szigorúan egymás után fut', async () => {
  const sorba = letrehozMentesSor()
  const sorrend = []

  const p1 = sorba('a', async () => {
    sorrend.push('1-start')
    await kesobb(20)
    sorrend.push('1-end')
  })
  const p2 = sorba('a', async () => {
    sorrend.push('2-start')
    await kesobb(5)
    sorrend.push('2-end')
  })

  await Promise.all([p1, p2])
  assert.deepEqual(sorrend, ['1-start', '1-end', '2-start', '2-end'])
})

test('különböző kulcsú futások nem blokkolják egymást', async () => {
  const sorba = letrehozMentesSor()
  const sorrend = []

  const pLassu = sorba('lassu', async () => {
    sorrend.push('lassu-start')
    await kesobb(30)
    sorrend.push('lassu-end')
  })
  const pGyors = sorba('gyors', async () => {
    sorrend.push('gyors-start')
    await kesobb(5)
    sorrend.push('gyors-end')
  })

  await Promise.all([pLassu, pGyors])
  // A gyors futás a saját kulcsán nem várja meg a lassú kulcs futását: a
  // "gyors-end" a "lassu-end" előtt landol.
  assert.ok(sorrend.indexOf('gyors-end') < sorrend.indexOf('lassu-end'))
  assert.deepEqual(sorrend.slice(0, 2), ['lassu-start', 'gyors-start'])
})

test('egy elutasított futás után a következő, ugyanahhoz a kulcshoz tartozó futás lefut', async () => {
  const sorba = letrehozMentesSor()
  const sorrend = []

  const p1 = sorba('a', async () => {
    sorrend.push('1-start')
    throw new Error('hiba')
  })
  await assert.rejects(p1, /hiba/)

  const p2 = sorba('a', async () => {
    sorrend.push('2-start')
  })
  await p2
  assert.deepEqual(sorrend, ['1-start', '2-start'])
})

test('egy futás az előző futás által írt értéket olvassa induláskor (ez a javítás lényegi tulajdonsága)', async () => {
  const sorba = letrehozMentesSor()
  const allapot = { szamlalo: 0 }
  const olvasott = []

  const p1 = sorba('doc', async () => {
    await kesobb(15)
    allapot.szamlalo = 1
  })
  const p2 = sorba('doc', async () => {
    // Ha a sorbaállítás nem várná meg p1 befejezését az induláskor való
    // olvasás előtt, ez itt 0-t olvasna, nem az előző futás által beírt 1-et.
    olvasott.push(allapot.szamlalo)
  })

  await Promise.all([p1, p2])
  assert.deepEqual(olvasott, [1])
})

test('egy harmadik futás egy elutasított MÁSODIK futás után is a helyes (legutóbb írt) értéket olvassa', async () => {
  const sorba = letrehozMentesSor()
  const allapot = { szamlalo: 0 }
  const olvasott = []

  const p1 = sorba('doc', async () => {
    allapot.szamlalo = 1
  })
  const p2 = sorba('doc', async () => {
    allapot.szamlalo = 2
    throw new Error('hiba2')
  })
  const p3 = sorba('doc', async () => {
    olvasott.push(allapot.szamlalo)
  })

  await p1
  await assert.rejects(p2, /hiba2/)
  await p3
  assert.deepEqual(olvasott, [2])
})
