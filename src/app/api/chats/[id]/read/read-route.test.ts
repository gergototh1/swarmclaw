import test from 'node:test'
import assert from 'node:assert/strict'

test('a route egy szam lastReadAt-tel ter vissza, es patchSession-t hiv', async () => {
  const patched: Array<{ id: string; lastReadAt: unknown }> = []
  const mod = await import('./read-route-logic')
  const before = Date.now()
  const res = mod.markSessionRead('s1', {
    patch: (id, updater) => {
      const next = updater({ id } as never)
      patched.push({ id, lastReadAt: (next as { lastReadAt?: unknown })?.lastReadAt })
      return next
    },
  })
  assert.equal(res?.ok, true)
  assert.ok(typeof res?.lastReadAt === 'number' && res.lastReadAt >= before)
  assert.equal(patched.length, 1)
  assert.equal(patched[0].lastReadAt, res?.lastReadAt)
})

test('ismeretlen session eseten null', async () => {
  const mod = await import('./read-route-logic')
  assert.equal(mod.markSessionRead('nincs', { patch: () => null }), null)
})
