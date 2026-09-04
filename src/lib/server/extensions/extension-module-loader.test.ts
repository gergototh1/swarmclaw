import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { runWithTempDataDir } from '../test-utils/run-with-temp-data-dir'

/**
 * The loader, on the runtimes the product actually ships on.
 *
 * Every other extension test in this repo runs under `node --import tsx`,
 * which installs loader hooks that transpile what they resolve -- an
 * extension's `.mjs` sources included. That makes the test runner's module
 * system a different one from the product's, and it is how a loader that could
 * not load an ESM extension in the desktop app at all passed two rounds of
 * green tests: nothing exercised the shipped path.
 *
 * So these cases run the loader's own source, transpiled but otherwise
 * untouched, under:
 *
 *   - plain Node, no tsx           -- `next dev`, `node .next/standalone/server.js`
 *   - Electron's embedded Node     -- the desktop app, which spawns
 *                                     `process.execPath` with
 *                                     `ELECTRON_RUN_AS_NODE=1`
 *
 * The Electron case uses this repo's own `electron` devDependency. If it is not
 * installed the case fails rather than skips: a silent skip here is the same
 * blind spot in a different shape.
 */

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')
const loaderSource = path.join(repoRoot, 'src/lib/server/extensions/extension-module-loader.ts')

/**
 * Transpiles the loader to plain ESM so a runtime with no TypeScript support
 * can import it. esbuild only strips types here: the loader imports nothing but
 * node: builtins, so what runs under the child is the shipped module, not a
 * bundle of it.
 */
function buildLoaderModule(): { outFile: string; cleanup: () => void } {
  const require = createRequire(import.meta.url)
  const esbuildBin = path.join(path.dirname(require.resolve('esbuild/package.json')), 'bin/esbuild')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-extension-loader-'))
  const outFile = path.join(outDir, 'extension-module-loader.mjs')
  const result = spawnSync(
    esbuildBin,
    [loaderSource, '--format=esm', '--platform=node', '--target=node20', `--outfile=${outFile}`],
    { encoding: 'utf-8' },
  )
  assert.equal(result.status, 0, result.stderr || 'esbuild failed')
  return { outFile, cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }) }
}

function electronExecPath(): string {
  const require = createRequire(import.meta.url)
  const resolved: unknown = require('electron')
  assert.equal(
    typeof resolved,
    'string',
    'the electron devDependency must be installed to exercise the desktop runtime',
  )
  return resolved as string
}

interface LoadResult {
  kind: string
  generation: number
  name: string
  tag: string
  entryRuns: number
  depRuns: number
}

interface DriverOutput {
  node: string
  electron: string | null
  resolveHooks: boolean
  requireEsm: string
  loads: LoadResult[]
}

/**
 * Builds two extensions in the child's data directory -- one ESM, one CommonJS,
 * each with the entry importing a second file -- loads both, edits the *imported*
 * file on disk, and loads both again under the next generation.
 *
 * Editing the imported file rather than the entry is deliberate. A generation
 * stamp on the entry URL alone re-executes the entry and nothing it imports,
 * which is where every real extension keeps its code; a test that only edited
 * the entry would pass against a loader that cannot pick up an edit that
 * matters.
 */
const DRIVER_SCRIPT = `
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const loader = await import(process.env.EXTENSION_LOADER_URL)
const root = process.env.DATA_DIR
const nodeRequire = createRequire(path.join(root, 'noop.js'))

function writeExtension(kind, tag) {
  const dir = path.join(root, kind)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  if (kind === 'esm') {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'esm-ext', type: 'module' }))
    fs.writeFileSync(path.join(dir, 'src', 'dep.mjs'),
      'globalThis.__esmDep = (globalThis.__esmDep || 0) + 1\\nexport const tag = ' + JSON.stringify(tag) + '\\n')
    fs.writeFileSync(path.join(dir, 'index.js'),
      "import { tag } from './src/dep.mjs'\\nglobalThis.__esmEntry = (globalThis.__esmEntry || 0) + 1\\n"
      + 'export default { name: "esm-extension", tag, entryRuns: globalThis.__esmEntry, depRuns: globalThis.__esmDep }\\n')
  } else {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cjs-ext' }))
    fs.writeFileSync(path.join(dir, 'src', 'dep.js'),
      'globalThis.__cjsDep = (globalThis.__cjsDep || 0) + 1\\nmodule.exports = { tag: ' + JSON.stringify(tag) + ' }\\n')
    fs.writeFileSync(path.join(dir, 'index.js'),
      "const { tag } = require('./src/dep.js')\\nglobalThis.__cjsEntry = (globalThis.__cjsEntry || 0) + 1\\n"
      + 'module.exports = { name: "cjs-extension", tag, entryRuns: globalThis.__cjsEntry, depRuns: globalThis.__cjsDep }\\n')
  }
  return path.join(dir, 'index.js')
}

const entries = { esm: writeExtension('esm', 'first'), cjs: writeExtension('cjs', 'first') }

// What the previous loader did, on an ESM extension, on this runtime. Its own
// copy: on a Node new enough for require(esm) the call succeeds, and a success
// executes the module, which would show up in the execution counts below.
const probeDir = path.join(root, 'require-probe')
fs.mkdirSync(probeDir, { recursive: true })
fs.writeFileSync(path.join(probeDir, 'package.json'), JSON.stringify({ name: 'probe', type: 'module' }))
fs.writeFileSync(path.join(probeDir, 'index.js'), 'export default { name: "probe" }\\n')
let requireEsm = 'ok'
try { nodeRequire(path.join(probeDir, 'index.js')) } catch (err) { requireEsm = err.code || err.message }

const loads = []
async function loadBoth(generation) {
  for (const kind of ['esm', 'cjs']) {
    loader.evictExtensionCommonJsCache(nodeRequire.cache, {
      entryPaths: [entries[kind]],
      containerDir: path.join(root, kind),
      containerRoot: root,
    })
    const namespace = await loader.importExtensionModule(entries[kind], generation)
    const value = loader.extensionModuleExport(namespace)
    loads.push({ kind, generation, ...value })
  }
}

await loadBoth(1)
writeExtension('esm', 'second')
writeExtension('cjs', 'second')
await loadBoth(2)

console.log(JSON.stringify({
  node: process.versions.node,
  electron: process.versions.electron || null,
  resolveHooks: loader.ensureExtensionResolveHooks(),
  requireEsm,
  loads,
}))
`

function pick(output: DriverOutput, kind: string, generation: number): LoadResult {
  const found = output.loads.find((load) => load.kind === kind && load.generation === generation)
  assert.ok(found, `no ${kind} load recorded for generation ${generation}`)
  return found
}

function assertLoadsAndReloads(output: DriverOutput): void {
  assert.equal(output.resolveHooks, true, 'resolve hooks must register on every shipped runtime')

  for (const kind of ['esm', 'cjs']) {
    const first = pick(output, kind, 1)
    const second = pick(output, kind, 2)

    assert.equal(first.tag, 'first', `${kind}: first load must run the extension`)
    assert.equal(first.entryRuns, 1, `${kind}: entry must execute exactly once on first load`)
    assert.equal(first.depRuns, 1, `${kind}: imported file must execute exactly once on first load`)

    assert.equal(second.tag, 'second', `${kind}: reload must pick up the edited imported file`)
    assert.equal(second.entryRuns, 2, `${kind}: reload must re-execute the entry`)
    assert.equal(second.depRuns, 2, `${kind}: reload must re-execute the imported file`)
  }
}

describe('extension module loader on the shipped runtimes', () => {
  const built = buildLoaderModule()
  const loaderUrl = pathToFileURL(built.outFile).href
  after(() => { built.cleanup() })

  it('loads and reloads ESM and CommonJS extensions under plain Node', () => {
    const output = runWithTempDataDir<DriverOutput>(DRIVER_SCRIPT, {
      prefix: 'extension-loader-node-',
      useTsx: false,
      env: { EXTENSION_LOADER_URL: loaderUrl },
    })

    assert.equal(output.electron, null, 'this case must run under plain Node, not Electron')
    assertLoadsAndReloads(output)
  })

  it("loads and reloads ESM and CommonJS extensions under Electron's embedded Node", () => {
    const output = runWithTempDataDir<DriverOutput>(DRIVER_SCRIPT, {
      prefix: 'extension-loader-electron-',
      useTsx: false,
      execPath: electronExecPath(),
      env: { EXTENSION_LOADER_URL: loaderUrl, ELECTRON_RUN_AS_NODE: '1' },
    })

    assert.ok(output.electron, 'this case must run under Electron, not plain Node')
    assertLoadsAndReloads(output)
  })

  /**
   * The reason the loader cannot go back to `require()`.
   *
   * `require(esm)` arrived in Node 20.19 / 22.12. Electron 33 bundles 20.18.3,
   * so the same extension file that a development Node requires without
   * complaint is unloadable in the desktop app. This case records that
   * difference from both runtimes in one place, so a future change that
   * reintroduces `require()` fails here with the reason rather than in the
   * packaged app with a missing extension.
   *
   * It asserts what each runtime does, not that they agree: on a Node new
   * enough for `require(esm)` the call succeeds, and pinning it to fail would
   * make the test wrong the moment Electron is upgraded.
   */
  it('records that require() of an ESM extension still fails on Electron and not on plain Node', () => {
    const underNode = runWithTempDataDir<DriverOutput>(DRIVER_SCRIPT, {
      prefix: 'extension-loader-require-node-',
      useTsx: false,
      env: { EXTENSION_LOADER_URL: loaderUrl },
    })
    const underElectron = runWithTempDataDir<DriverOutput>(DRIVER_SCRIPT, {
      prefix: 'extension-loader-require-electron-',
      useTsx: false,
      execPath: electronExecPath(),
      env: { EXTENSION_LOADER_URL: loaderUrl, ELECTRON_RUN_AS_NODE: '1' },
    })

    const [nodeMajor, nodeMinor] = underNode.node.split('.').map(Number)
    const nodeSupportsRequireEsm = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12)
      || (nodeMajor === 20 && nodeMinor >= 19)
    assert.equal(underNode.requireEsm, nodeSupportsRequireEsm ? 'ok' : 'ERR_REQUIRE_ESM')

    const [electronMajor, electronMinor] = underElectron.node.split('.').map(Number)
    const electronSupportsRequireEsm = electronMajor > 22
      || (electronMajor === 22 && electronMinor >= 12)
      || (electronMajor === 20 && electronMinor >= 19)
    assert.equal(underElectron.requireEsm, electronSupportsRequireEsm ? 'ok' : 'ERR_REQUIRE_ESM')

    // Whatever `require()` does on each, `import()` loaded and reloaded both
    // extensions on both. That is the property the loader depends on.
    assertLoadsAndReloads(underNode)
    assertLoadsAndReloads(underElectron)
  })

  /**
   * The test runner is not a shipped runtime, and this is the case that says
   * so out loud. tsx transpiles the extension's `.mjs` sources, so a result
   * here is evidence about tsx and not about the product. It is kept because
   * the manager-level extension tests all run under tsx: if this ever diverges
   * from the two cases above, those tests have stopped meaning what they
   * appear to mean.
   */
  it('behaves the same under the tsx test runner, which is not evidence about the product', () => {
    const output = runWithTempDataDir<DriverOutput>(DRIVER_SCRIPT, {
      prefix: 'extension-loader-tsx-',
      env: { EXTENSION_LOADER_URL: loaderUrl },
    })

    assertLoadsAndReloads(output)
  })
})
