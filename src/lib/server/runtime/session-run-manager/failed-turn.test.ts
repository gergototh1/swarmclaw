import test from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from '@/types'
import { recordFailedTurn } from './failed-turn'

function deps() {
  const writes: number[] = []
  return {
    writes,
    patch: (_id: string, updater: (c: Session | null) => Session | null) => {
      const next = updater({ id: 'x' } as Session)
      if (next && typeof next.lastFailedTurnAt === 'number') writes.push(next.lastFailedTurnAt)
      return next
    },
  }
}

test('failed status ir', () => {
  const d = deps()
  assert.equal(recordFailedTurn('s1', 'failed', { patch: d.patch }), true)
  assert.equal(d.writes.length, 1)
})

test('completed nem ir -- azt a lastAssistantAt jelzi', () => {
  const d = deps()
  assert.equal(recordFailedTurn('s1', 'completed', { patch: d.patch }), false)
  assert.equal(d.writes.length, 0)
})

test('cancelled nem ir -- amit a felhasznalo szakitott felbe, arrol nem szolunk', () => {
  const d = deps()
  assert.equal(recordFailedTurn('s1', 'cancelled', { patch: d.patch }), false)
  assert.equal(d.writes.length, 0)
})

test('ismeretlen session eseten false', () => {
  assert.equal(recordFailedTurn('nincs', 'failed', { patch: () => null }), false)
})
