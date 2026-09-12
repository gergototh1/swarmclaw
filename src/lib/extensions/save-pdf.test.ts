import test from 'node:test'
import assert from 'node:assert/strict'
import { savePdf } from './save-pdf'

const input = { html: '<p>x</p>', fileName: 'a.pdf' }

test('the desktop bridge saves the file', async () => {
  const seen: unknown[] = []
  const r = await savePdf(input, {
    desktop: { savePdf: async (i) => { seen.push(i); return { saved: true, path: '/tmp/a.pdf' } } },
    printFallback: async () => { throw new Error('must not print') },
  })
  assert.deepEqual(r, { status: 'saved' })
  assert.deepEqual(seen, [input])
})

test('a cancelled save dialog is not an error', async () => {
  const r = await savePdf(input, { desktop: { savePdf: async () => ({ saved: false }) }, printFallback: async () => {} })
  assert.deepEqual(r, { status: 'cancelled' })
})

test('a bridge failure is thrown with its reason', async () => {
  await assert.rejects(
    savePdf(input, { desktop: { savePdf: async () => ({ saved: false, error: 'invalid input' }) }, printFallback: async () => {} }),
    /invalid input/,
  )
})

test('without the desktop bridge the print dialog is the way out', async () => {
  const printed: string[] = []
  const r = await savePdf(input, { desktop: null, printFallback: async (html) => { printed.push(html) } })
  assert.deepEqual(r, { status: 'printed' })
  assert.deepEqual(printed, ['<p>x</p>'])
})
