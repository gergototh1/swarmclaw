import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assetUrl, createExtensionRegistry, loadExtensionPage, resetRegistryForTests } from './registry'

test('registerPage stores the component and rejects a foreign React instance', () => {
  const hostReact = { id: 'host' }
  const reg = createExtensionRegistry({ react: hostReact })
  const Comp = () => null
  reg.registerPage('a', Comp, { react: hostReact })
  assert.equal(reg.getPage('a')?.Component, Comp)
  assert.throws(() => reg.registerPage('b', Comp, { react: { id: 'other' } }), /different React/)
  assert.equal(reg.getPage('b'), undefined)
})

test('onPageRegistered fires once the page arrives', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  let seen: string | null = null
  reg.onPageRegistered('late', (id) => { seen = id })
  reg.registerPage('late', () => null, { react: hostReact })
  assert.equal(seen, 'late')
})

test('registerPage refuses a call that carries no options at all', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  // An extension bundle is plain JavaScript, so it can call this with anything.
  const register = reg.registerPage as (id: string, Component: () => null, opts?: unknown) => void
  assert.throws(() => register('no-opts', () => null, undefined), /different React/)
  assert.equal(reg.getPage('no-opts'), undefined)
})

test('onPageRegistered fires immediately for an already registered page and can be unsubscribed', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  reg.registerPage('early', () => null, { react: hostReact })
  const hits: string[] = []
  reg.onPageRegistered('early', (id) => hits.push(id))
  assert.deepEqual(hits, ['early'])

  const unsubscribe = reg.onPageRegistered('never', (id) => hits.push(id))
  unsubscribe()
  reg.registerPage('never', () => null, { react: hostReact })
  assert.deepEqual(hits, ['early'])
})

test('registerPage records the owning extension when the bundle reports it', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  reg.registerPage('main', () => null, { react: hostReact, extensionId: 'aisignal' })
  assert.equal(reg.getPage('main')?.extensionId, 'aisignal')
})

test('assetUrl strips the leading dist/ segment the asset route does not take', () => {
  assert.equal(assetUrl('aisignal', 'dist/index.js'), '/api/extensions/aisignal/assets/index.js')
  assert.equal(assetUrl('aisignal', 'dist/chunks/page.css'), '/api/extensions/aisignal/assets/chunks/page.css')
  // Only the leading segment goes: a real dist/dist/ nesting must survive.
  assert.equal(assetUrl('aisignal', 'dist/dist/index.js'), '/api/extensions/aisignal/assets/dist/index.js')
})

test('assetUrl percent-encodes the extension id and every path segment', () => {
  assert.equal(assetUrl('my ext', 'dist/a b/c.js'), '/api/extensions/my%20ext/assets/a%20b/c.js')
  assert.equal(assetUrl('a/b', 'dist/x.js'), '/api/extensions/a%2Fb/assets/x.js')
})

test('loadExtensionPage rejects with a clear message when there is no document', async () => {
  resetRegistryForTests()
  await assert.rejects(
    loadExtensionPage({ extensionId: 'aisignal', entry: 'dist/index.js' }),
    /browser-only/,
  )
})
