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

test('registerPage refuses a module namespace object passed instead of its default export', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  const register = reg.registerPage as UntypedRegisterPage
  // What `registerPage('main', mod, ...)` passes when the bundle forgot `.default`.
  const moduleNamespace = { default: () => null, __esModule: true }
  assert.throws(() => register('main', moduleNamespace, { react: hostReact, extensionId: 'aisignal' }), /aisignal:main/)
  assert.equal(reg.getPage('aisignal', 'main'), undefined)
})

test('registerPage refuses a plain object that is not a React element type', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  const register = reg.registerPage as UntypedRegisterPage
  assert.throws(() => register('main', {}, { react: hostReact, extensionId: 'aisignal' }), /instead of a component/)
  assert.throws(() => register('main', { $$typeof: 'react.memo' }, { react: hostReact, extensionId: 'aisignal' }), /instead of a component/)
  assert.throws(() => register('main', { $$typeof: Symbol.for('vue.memo') }, { react: hostReact, extensionId: 'aisignal' }), /instead of a component/)
  assert.equal(reg.getPage('aisignal', 'main'), undefined)
})

test('registerPage accepts forwardRef and lazy results alongside memo', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact })
  const register = reg.registerPage as UntypedRegisterPage
  const forwardRefLike = { $$typeof: Symbol.for('react.forward_ref'), render: () => null }
  const lazyLike = { $$typeof: Symbol.for('react.lazy'), _payload: {}, _init: () => null }
  register('fwd', forwardRefLike, { react: hostReact, extensionId: 'aisignal' })
  register('lazy', lazyLike, { react: hostReact, extensionId: 'aisignal' })
  assert.equal(reg.getPage('aisignal', 'fwd')?.Component, forwardRefLike)
  assert.equal(reg.getPage('aisignal', 'lazy')?.Component, lazyLike)
})

test('a refused registration is recorded so the renderer can show it instead of a blank page', () => {
  const hostReact = { id: 'host' }
  const reg = createExtensionRegistry({ react: hostReact, currentExtensionId: () => 'aisignal' })
  assert.equal(reg.registrationRefusal('aisignal', 'main'), undefined)

  assert.throws(() => reg.registerPage('main', () => null, { react: { id: 'own' }, extensionId: 'aisignal' }))
  const refusal = reg.registrationRefusal('aisignal', 'main')
  assert.equal(refusal?.extensionId, 'aisignal')
  assert.equal(refusal?.pageId, 'main')
  assert.match(refusal?.message ?? '', /different React/)
})

test('a refusal is attributed to the executing bundle, not to the id it claimed', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact, currentExtensionId: () => 'alpha' })
  assert.throws(() => reg.registerPage('main', () => null, { react: hostReact, extensionId: 'beta' }))
  assert.equal(reg.registrationRefusal('beta', 'main'), undefined)
  assert.match(reg.registrationRefusal('alpha', 'main')?.message ?? '', /belongs to extension "alpha"/)
})

test('a refusal under a different page id is still found for the page the host is waiting for', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact, currentExtensionId: () => 'aisignal' })
  const register = reg.registerPage as UntypedRegisterPage
  // The bundle mistyped the page id, so nothing is ever recorded under "main".
  assert.throws(() => register('mian', undefined, { react: hostReact, extensionId: 'aisignal' }))
  const refusal = reg.registrationRefusal('aisignal', 'main')
  assert.equal(refusal?.pageId, 'mian')
  assert.match(refusal?.message ?? '', /aisignal:mian/)
})

test('a refusal from one extension is never reported for another', () => {
  const hostReact = {}
  const alpha = createExtensionRegistry({ react: hostReact, currentExtensionId: () => 'alpha' })
  assert.throws(() => alpha.registerPage('main', () => null, { react: {}, extensionId: 'alpha' }))
  // Assert the refusal was recorded first. Without this the isolation assertion
  // below passes just as happily against a registry that records nothing at all,
  // which is the mutation it exists to catch.
  assert.match(alpha.registrationRefusal('alpha', 'main')?.message ?? '', /different React/)
  assert.equal(alpha.registrationRefusal('beta', 'main'), undefined)
})

test('the newest refusal for a page wins, so a retry after a rebuild is what is shown', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact, currentExtensionId: () => 'aisignal' })
  const register = reg.registerPage as UntypedRegisterPage
  assert.throws(() => register('main', () => null, { react: {}, extensionId: 'aisignal' }))
  assert.throws(() => register('main', undefined, { react: hostReact, extensionId: 'aisignal' }))
  assert.match(reg.registrationRefusal('aisignal', 'main')?.message ?? '', /instead of a component/)
})

test('a successful registration records no refusal', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({ react: hostReact, currentExtensionId: () => 'aisignal' })
  reg.registerPage('main', () => null, { react: hostReact, extensionId: 'aisignal' })
  assert.equal(reg.registrationRefusal('aisignal', 'main'), undefined)
})

test('the refusal fallback stays inside the bundle that recorded it', () => {
  const hostReact = {}
  let executing = '/api/extensions/aisignal/assets/pages/b.js'
  const reg = createExtensionRegistry({
    react: hostReact,
    currentExtensionId: () => 'aisignal',
    currentBundleSrc: () => executing,
  })
  const register = reg.registerPage as UntypedRegisterPage

  // One entry per page: page b's bundle is refused, page a's silently registers
  // nothing at all.
  assert.throws(() => register('b', undefined, { react: hostReact, extensionId: 'aisignal' }))

  const entryA = '/api/extensions/aisignal/assets/pages/a.js'
  const entryB = '/api/extensions/aisignal/assets/pages/b.js'
  // Page a must fall through to its own "never registered" message rather than
  // borrow b's reason, which describes a different bundle.
  assert.equal(reg.registrationRefusal('aisignal', 'a', entryA), undefined)
  // Page b still reports its own refusal.
  assert.match(reg.registrationRefusal('aisignal', 'b', entryB)?.message ?? '', /aisignal:b/)

  // And within one entry the mistyped-page-id fallback still works: this is the
  // single-entry case where an earlier refusal aborted the rest of the script.
  executing = entryA
  assert.throws(() => register('mian', undefined, { react: hostReact, extensionId: 'aisignal' }))
  assert.equal(reg.registrationRefusal('aisignal', 'a', entryA)?.pageId, 'mian')
})

test('a refusal recorded outside bundle execution is never used as another bundle\'s fallback', () => {
  const hostReact = {}
  const reg = createExtensionRegistry({
    react: hostReact,
    currentExtensionId: () => 'aisignal',
    // What a registration from a timer or a promise callback looks like: the
    // browser cannot say which script is running.
    currentBundleSrc: () => undefined,
  })
  const register = reg.registerPage as UntypedRegisterPage
  assert.throws(() => register('late', undefined, { react: hostReact, extensionId: 'aisignal' }))

  assert.equal(reg.registrationRefusal('aisignal', 'main', '/api/extensions/aisignal/assets/index.js'), undefined)
  // It is still the authority for the page it names, and for a caller that has
  // no bundle to scope to either.
  assert.match(reg.registrationRefusal('aisignal', 'late')?.message ?? '', /aisignal:late/)
  assert.match(reg.registrationRefusal('aisignal', 'main')?.message ?? '', /aisignal:late/)
})

test('registrationRefusal records the src of the bundle that was executing', () => {
  const hostReact = {}
  const src = '/api/extensions/aisignal/assets/index.js'
  const reg = createExtensionRegistry({
    react: hostReact,
    currentExtensionId: () => 'aisignal',
    currentBundleSrc: () => src,
  })
  assert.throws(() => reg.registerPage('main', () => null, { react: {}, extensionId: 'aisignal' }))
  assert.equal(reg.registrationRefusal('aisignal', 'main')?.bundleSrc, src)
  // assetUrl reproduces exactly what the loader stamps on the tag, so a renderer
  // can scope the fallback from the page's declared entry alone.
  assert.equal(assetUrl('aisignal', 'dist/index.js'), src)
})
