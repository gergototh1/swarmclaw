import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateLocalReadTimestamps } from './chat-read-migration'

test('ures tarolo eseten nincs hivas, es torolheto', async () => {
  const calls: string[] = []
  const ok = await migrateLocalReadTimestamps({
    read: () => ({}),
    push: async (id) => { calls.push(id) },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, [])
})

test('minden kulcsot felkuld, es utana torolheto', async () => {
  const calls: string[] = []
  const ok = await migrateLocalReadTimestamps({
    read: () => ({ a: 1, b: 2 }),
    push: async (id) => { calls.push(id) },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls.sort(), ['a', 'b'])
})

test('ha barmelyik felkuldes elhasal, NEM torolheto -- inkabb fusson ketszer', async () => {
  const ok = await migrateLocalReadTimestamps({
    read: () => ({ a: 1, b: 2 }),
    push: async (id) => { if (id === 'b') throw new Error('halt') },
  })
  assert.equal(ok, false)
})
