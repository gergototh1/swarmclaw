import assert from 'node:assert/strict'
import test from 'node:test'

import { lapozottIdovonal } from '../ui/ugyfel-lap.tsx'

/**
 * A "Korábbiak" gomb a `timeline` rpc-t hívja a lista végén (a legrégebbi
 * eseménynél) lévő `occurred_at`-tal, és a választ hozzáfűzi a meglévő
 * listához. Három eset dönti el, hogy a gomb ezután mit mutat és marad-e
 * látható:
 *
 * 1. A visszakapott lap valódi, korábbi eseményeket hoz -- ezeket a végéhez
 *    kell fűzni, a sorrend megtartásával.
 * 2. A visszakapott lap üres -- nincs több korábbi esemény, a hívónak ezt
 *    kell jeleznie, hogy a gomb eltűnhessen.
 * 3. Az id szerinti szűrés véd, ha egy id mindkét lapon szerepelne -- ez a
 *    repo szigorú `occurred_at < ?` határa mellett nem fordulhat elő, a teszt
 *    csak azt pinneli le, hogy a védekező szűrés önmagában ártalmatlan és
 *    nem dob el semmit feleslegesen.
 */

const eseny = (id, occurredAt) => ({ id, kind: 'note', occurred_at: occurredAt, title: '', excerpt: id })

test('hozzáfűzi az új lapot a meglévő lista végéhez', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z'), eseny('e2', '2026-09-02T10:00:00Z')]
  const ujOldal = [eseny('e1', '2026-09-01T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, ujOldal)
  assert.deepEqual(eredmeny.map((e) => e.id), ['e3', 'e2', 'e1'])
})

test('üres lap esetén a lista változatlan marad', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, [])
  assert.deepEqual(eredmeny, meglevo)
})

test('a védekező id-szűrés nem dob el semmit, ha egy id mindkét lapon szerepel', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z'), eseny('e2', '2026-09-02T10:00:00Z')]
  const ujOldal = [eseny('e2', '2026-09-02T10:00:00Z'), eseny('e1', '2026-09-01T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, ujOldal)
  assert.deepEqual(eredmeny.map((e) => e.id), ['e3', 'e2', 'e1'])
})
