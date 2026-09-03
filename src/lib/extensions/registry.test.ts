import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assetUrl, createExtensionRegistry, loadExtensionPage, resetRegistryForTests } from './registry'

/**
 * An extension bundle is untyped JavaScript, so several tests widen the
 * signature to model a call the type system would have rejected at build time
 * but the browser will happily make.
 */
type UntypedRegisterPage = (pageId: string, Component: unknown, opts?: unknown) => void

test('registerPage stores the component and rejects a foreign React instance', () => {
  const hostReact = { id: 'host' }
  const reg = createExtensionRegistry({ react: hostReact })
  const Comp = () => null
  reg.registerPage('a', Comp, { react: hostReact, extensionId: 'ext' })
  assert.equal(reg.getPage('ext', 'a')?.Component, Comp)
  assert.throws(
    () => reg.registerPage('b', Comp, { react: { id: 'other' }, extensionId: 'ext' }),
    /different React/,
  )
  assert.equal(reg.getPage('ext', 'b'), undefined)
})

test('the foreign React error tells the author to pass the imported binding, not window.swarmclaw.modules', () => {
  const reg = createExtensionRegistry({ react: { id: 'host' } })
  assert.throws(
    () => reg.registerPage('a', () => null, { react: { id: 'other' }, extensionId: 'ext' }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : ''
      assert.match(message, /imported/)
      assert.match(message, /window\.swarmclaw\.modules\.react/)
      assert.match(message, /defeats/)
      return true
    },
  )
})

test('onPageRegistered fires once the page arrives', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  let seen: string | null = null
  reg.onPageRegistered('ext', 'late', (pageId) => { seen = pageId })
  reg.registerPage('late', () => null, { react: hostReact, extensionId: 'ext' })
  assert.equal(seen, 'late')
})

test('registerPage refuses a call that carries no options at all', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  const register = reg.registerPage as UntypedRegisterPage
  assert.throws(() => register('no-opts', () => null, undefined), /different React/)
  assert.equal(reg.getPage('ext', 'no-opts'), undefined)
})

test('onPageRegistered fires immediately for an already registered page and can be unsubscribed', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  reg.registerPage('early', () => null, { react: hostReact, extensionId: 'ext' })
  const hits: string[] = []
  reg.onPageRegistered('ext', 'early', (pageId) => hits.push(pageId))
  assert.deepEqual(hits, ['early'])

  const unsubscribe = reg.onPageRegistered('ext', 'never', (pageId) => hits.push(pageId))
  unsubscribe()
  reg.registerPage('never', () => null, { react: hostReact, extensionId: 'ext' })
  assert.deepEqual(hits, ['early'])
})

test('registerPage records the owning extension', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  reg.registerPage('main', () => null, { react: hostReact, extensionId: 'aisignal' })
  assert.equal(reg.getPage('aisignal', 'main')?.extensionId, 'aisignal')
  assert.equal(reg.getPage('aisignal', 'main')?.pageId, 'main')
})

test('two extensions can register the same page id and both resolve independently', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  const First = () => null
  const Second = () => null
  const seen: string[] = []
  reg.onPageRegistered('beta', 'main', () => seen.push('beta'))

  reg.registerPage('main', First, { react: hostReact, extensionId: 'alpha' })
  reg.registerPage('main', Second, { react: hostReact, extensionId: 'beta' })

  assert.equal(reg.getPage('alpha', 'main')?.Component, First)
  assert.equal(reg.getPage('beta', 'main')?.Component, Second)
  // The alpha registration must not have satisfied beta's waiter.
  assert.deepEqual(seen, ['beta'])
})

test('registerPage rejects an extensionId that is not the bundle being loaded', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact, currentExtensionId: () => 'alpha' })
  assert.throws(
    () => reg.registerPage('main', () => null, { react: hostReact, extensionId: 'beta' }),
    /belongs to extension "alpha"/,
  )
  assert.equal(reg.getPage('beta', 'main'), undefined)
  assert.equal(reg.getPage('alpha', 'main'), undefined)

  reg.registerPage('main', () => null, { react: hostReact, extensionId: 'alpha' })
  assert.ok(reg.getPage('alpha', 'main'))
})

test('registerPage rejects a missing extensionId and points at the script tag', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  const register = reg.registerPage as UntypedRegisterPage
  assert.throws(
    () => register('main', () => null, { react: hostReact }),
    /document\.currentScript/,
  )
})

test('registerPage rejects a component that is not a component, naming the page', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  const register = reg.registerPage as UntypedRegisterPage
  // What a bundle whose interop left `mod.default` undefined actually passes.
  assert.throws(
    () => register('main', undefined, { react: hostReact, extensionId: 'aisignal' }),
    /aisignal:main/,
  )
  assert.equal(reg.getPage('aisignal', 'main'), undefined)
})

test('registerPage accepts memo and forwardRef results, which are objects', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  const register = reg.registerPage as UntypedRegisterPage
  const memoLike = { $$typeof: Symbol.for('react.memo'), type: () => null }
  register('memo', memoLike, { react: hostReact, extensionId: 'aisignal' })
  assert.equal(reg.getPage('aisignal', 'memo')?.Component, memoLike)
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
