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
 * 3. A visszakapott lap átfed a meglévővel (pl. mert két esemény ugyanabban
 *    a másodpercben történt, és a `before` másodperc pontosságú) -- egy
 *    esemény nem szerepelhet kétszer a listában.
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

test('átfedő lap esetén egyetlen esemény sem szerepel kétszer', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z'), eseny('e2', '2026-09-02T10:00:00Z')]
  const ujOldal = [eseny('e2', '2026-09-02T10:00:00Z'), eseny('e1', '2026-09-01T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, ujOldal)
  assert.deepEqual(eredmeny.map((e) => e.id), ['e3', 'e2', 'e1'])
})
