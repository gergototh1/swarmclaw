import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

interface AssetCall {
  status: number
  type: string | null
  nosniff: string | null
  csp: string | null
  body: string
}

interface AssetRouteResult {
  js: AssetCall
  css: AssetCall
  missing: AssetCall
  dotDotSegment: AssetCall
  escapeInsideSegment: AssetCall
  symlinkEscape: AssetCall
  svg: AssetCall
  noSegments: AssetCall
  emptySegment: AssetCall
  unknownExtension: AssetCall
  malformedExtensionId: AssetCall
}

// One child process exercises every case; the assertions below read its report.
const result = runWithTempDataDir<AssetRouteResult>(`
  const fs = await import('node:fs')
  const path = await import('node:path')
  const extensionsMod = await import('@/lib/server/extensions')
  const { getExtensionManager } = extensionsMod.default || extensionsMod
  const routeMod = await import('@/app/api/extensions/[id]/assets/[...path]/route')
  const { GET } = routeMod.default || routeMod

  const manager = getExtensionManager()
  await manager.saveExtensionSource('as_a.mjs', 'export default { name: "A", tools: [] }')
  const workspace = manager.getWorkspaceDirFor('as_a.mjs')
  const dist = path.join(workspace, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.js'), 'window.__asset_ok = 1')
  fs.writeFileSync(path.join(dist, 'style.css'), '.a { color: red }')
  fs.writeFileSync(path.join(dist, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  fs.writeFileSync(path.join(workspace, 'secret.txt'), 'TOP_SECRET')
  fs.symlinkSync(path.join(workspace, 'secret.txt'), path.join(dist, 'linked.js'))

  const call = async (segs, id = 'as_a.mjs') => {
    const res = await GET(new Request('http://local/api'), { params: Promise.resolve({ id, path: segs }) })
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      nosniff: res.headers.get('x-content-type-options'),
      csp: res.headers.get('content-security-policy'),
      body: await res.text(),
    }
  }

  console.log(JSON.stringify({
    js: await call(['index.js']),
    css: await call(['style.css']),
    missing: await call(['nope.js']),
    dotDotSegment: await call(['..', 'secret.txt']),
    escapeInsideSegment: await call(['../secret.txt']),
    symlinkEscape: await call(['linked.js']),
    svg: await call(['icon.svg']),
    noSegments: await call([]),
    emptySegment: await call(['']),
    unknownExtension: await call(['index.js'], 'as_missing.mjs'),
    malformedExtensionId: await call(['index.js'], '../../etc/passwd'),
  }))
`)

describe('extension asset route', () => {
  it('serves a dist file with its content type and exact bytes', () => {
    assert.equal(result.js.status, 200)
    assert.match(result.js.type || '', /javascript/)
    assert.equal(result.js.body, 'window.__asset_ok = 1')
    assert.equal(result.css.status, 200)
    assert.match(result.css.type || '', /text\/css/)
    assert.equal(result.css.body, '.a { color: red }')
  })

  it('returns 404 for a missing file', () => {
    assert.equal(result.missing.status, 404)
  })

  it('rejects a ".." segment with 400', () => {
    assert.equal(result.dotDotSegment.status, 400)
    assert.doesNotMatch(result.dotDotSegment.body, /TOP_SECRET/)
  })

  it('never reads outside dist, even when the escape hides inside one segment', () => {
    // path.resolve normalizes this to <workspace>/secret.txt; the containment check is what
    // refuses it, so that check must survive any later "simplification" of the route.
    assert.equal(result.escapeInsideSegment.status, 400)
    assert.doesNotMatch(result.escapeInsideSegment.body, /TOP_SECRET/)
    // A symlink inside dist pointing outside survives resolve+containment, so the
    // realpath re-check is the only thing that stops it.
    assert.equal(result.symlinkEscape.status, 400)
    assert.doesNotMatch(result.symlinkEscape.body, /TOP_SECRET/)
  })

  it('rejects an empty segment list and an empty segment', () => {
    assert.equal(result.noSegments.status, 400)
    assert.equal(result.emptySegment.status, 400)
  })

  it('returns 404 for an extension that does not exist and 400 for a malformed id', () => {
    assert.equal(result.unknownExtension.status, 404)
    assert.deepEqual(JSON.parse(result.unknownExtension.body), { error: 'Asset not found' })
    assert.equal(result.malformedExtensionId.status, 400)
    assert.deepEqual(JSON.parse(result.malformedExtensionId.body), { error: 'Invalid asset path' })
  })

  it('sends nosniff on every asset and sandboxes a directly navigated svg', () => {
    assert.equal(result.js.nosniff, 'nosniff')
    assert.equal(result.css.nosniff, 'nosniff')
    assert.equal(result.js.csp, null)
    assert.equal(result.svg.status, 200)
    assert.match(result.svg.type || '', /image\/svg\+xml/)
    assert.equal(result.svg.nosniff, 'nosniff')
    assert.equal(result.svg.csp, 'sandbox')
  })
})
