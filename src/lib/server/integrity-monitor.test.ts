import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let integrityMonitor: typeof import('./integrity-monitor')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-integrity-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  integrityMonitor = await import('./integrity-monitor')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('integrity-monitor', () => {
  it('returns disabled result when integrityMonitorEnabled is false', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: false })
    assert.equal(result.enabled, false)
    assert.equal(result.checkedFiles, 0)
    assert.equal(result.drifts.length, 0)
    assert.ok(result.checkedAt > 0)
  })

  it('returns disabled for string "false"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: 'false' })
    assert.equal(result.enabled, false)
  })

  it('returns disabled for string "0"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: '0' })
    assert.equal(result.enabled, false)
  })

  it('returns disabled for string "off"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: 'off' })
    assert.equal(result.enabled, false)
  })

  it('defaults to enabled when setting is null', () => {
    const result = integrityMonitor.runIntegrityMonitor(null)
    assert.equal(result.enabled, true)
    assert.ok(result.checkedAt > 0)
  })

  it('defaults to enabled when setting is undefined', () => {
    const result = integrityMonitor.runIntegrityMonitor()
    assert.equal(result.enabled, true)
  })

  it('enabled with string "true"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: 'true' })
    assert.equal(result.enabled, true)
  })

  it('enabled with string "1"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: '1' })
    assert.equal(result.enabled, true)
  })

  it('enabled run returns result with checkedFiles and drifts array', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    assert.equal(result.enabled, true)
    assert.ok(typeof result.checkedFiles === 'number')
    assert.ok(Array.isArray(result.drifts))
    assert.ok(result.checkedAt > 0)
  })

  it('second run with no changes produces zero drifts', () => {
    // First run establishes baselines
    integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    // Second run with no changes
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    assert.equal(result.drifts.length, 0)
  })

  it('detects file modification as drift', () => {
    // Create an extension file in the data/plugins dir
    const extDir = path.join(process.env.DATA_DIR!, 'plugins')
    fs.mkdirSync(extDir, { recursive: true })
    const extFile = path.join(extDir, 'test-integrity-extension.js')
    fs.writeFileSync(extFile, 'module.exports = { name: "test" }')

    // First run: baseline
    integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })

    // Modify the file
    fs.writeFileSync(extFile, 'module.exports = { name: "modified" }')

    // Second run: should detect drift
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    const drift = result.drifts.find((d) => d.filePath === path.resolve(extFile))
    assert.ok(drift, 'should detect modified extension file')
    assert.equal(drift!.type, 'modified')
    assert.ok(drift!.previousHash)
    assert.ok(drift!.nextHash)
    assert.notEqual(drift!.previousHash, drift!.nextHash)
  })

  it('deleted extension file is no longer in watch targets (no drift)', () => {
    // pushIfExists skips non-existent files, so deletion means the file
    // simply drops out of the watch targets — no drift is generated.
    const extDir = path.join(process.env.DATA_DIR!, 'plugins')
    fs.mkdirSync(extDir, { recursive: true })
    const extFile = path.join(extDir, 'test-delete-extension.js')
    fs.writeFileSync(extFile, 'module.exports = {}')

    // Baseline
    integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })

    // Delete
    fs.unlinkSync(extFile)

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    const drift = result.drifts.find((d) => d.filePath === path.resolve(extFile))
    assert.equal(drift, undefined, 'deleted file should not appear as drift')
  })

  it('new extension file is baselined without drift on first run', () => {
    const extDir = path.join(process.env.DATA_DIR!, 'plugins')
    fs.mkdirSync(extDir, { recursive: true })
    const extFile = path.join(extDir, 'brand-new-extension.js')
    fs.writeFileSync(extFile, 'module.exports = { name: "new" }')

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    // First time seeing the file — establishes baseline, no drift
    const drift = result.drifts.find((d) => d.filePath === path.resolve(extFile))
    assert.equal(drift, undefined, 'new file on first run should not produce drift')
    assert.ok(result.checkedFiles > 0)
  })
})

/**
 * The workspace-backed extension layout, monitored.
 *
 * `data/extensions/<name>` is a generated shim for an extension that keeps its
 * code in a managed workspace, and the shim's content never changes however
 * much the extension does. Baselining the workspace *entry* on top of it was
 * not enough either: an entry is wiring, and AI Signal's is 3.6 KB against
 * 172 KB of logic in `src/*.mjs` beside it, so a monitor that stopped at the
 * entry reported clean while roughly 98% of the executing code had been
 * replaced.
 *
 * These cases run under tsx only. `runIntegrityMonitor` reads and writes its
 * baselines through the SQLite-backed storage layer, whose native module is
 * built for one Node ABI at a time, so this subject cannot be driven under
 * Electron's embedded Node the way `extension-module-loader.test.ts` drives the
 * loader.
 *
 * The layout below is the one `extensions/aisignal/scripts/install.mjs` writes,
 * spelled out rather than imported so that a change to the installer shows up
 * here as a disagreement instead of being silently followed.
 */
describe('integrity-monitor extension workspaces', () => {
  let extensionsDir = ''
  let workspaceDir = ''

  const workspaceFile = (...parts: string[]): string => path.join(workspaceDir, ...parts)

  before(() => {
    extensionsDir = path.join(process.env.DATA_DIR!, 'extensions')
    workspaceDir = path.join(extensionsDir, '.workspaces', 'aisignal_mjs')
    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(workspaceDir, 'node_modules', 'left-pad'), { recursive: true })

    fs.writeFileSync(workspaceFile('index.js'), "export { default } from './src/db.mjs'\n")
    fs.writeFileSync(workspaceFile('src', 'db.mjs'), 'export default { name: "aisignal", credential: "first" }\n')
    fs.writeFileSync(workspaceFile('package.json'), '{"name":"aisignal","type":"module"}\n')
    fs.writeFileSync(workspaceFile('package-lock.json'), '{"name":"aisignal","lockfileVersion":3}\n')
    fs.writeFileSync(
      path.join(workspaceDir, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = () => "first"\n',
    )
    fs.writeFileSync(path.join(extensionsDir, 'aisignal.mjs'), "export { default } from './.workspaces/aisignal_mjs/index.js'\n")
    fs.writeFileSync(path.join(extensionsDir, 'plain.js'), 'module.exports = { name: "plain" }\n')

    // Establish the baseline for everything above in one pass.
    integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
  })

  it('reports a drift for a source file below the workspace entry', () => {
    fs.writeFileSync(workspaceFile('src', 'db.mjs'), 'export default { name: "aisignal", credential: "stolen" }\n')

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    const drift = result.drifts.find((d) => d.filePath === path.resolve(workspaceFile('src', 'db.mjs')))
    assert.ok(drift, 'editing a file below the workspace entry must trip a drift')
    assert.equal(drift!.type, 'modified')
    assert.equal(drift!.kind, 'extension')
    assert.notEqual(drift!.previousHash, drift!.nextHash)
  })

  it('reports a drift for the workspace entry the loader imports', () => {
    fs.writeFileSync(workspaceFile('index.js'), "export { default } from './src/db.mjs'\n// tampered\n")

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    const drift = result.drifts.find((d) => d.filePath === path.resolve(workspaceFile('index.js')))
    assert.ok(drift, 'the workspace entry must stay monitored')
    assert.equal(drift!.type, 'modified')
  })

  it('reports a drift for the workspace manifest that declares the dependencies', () => {
    // The manifest is what makes the node_modules exclusion below safe to
    // state: packages under it are reachable only as declared dependencies, and
    // changing that declaration is visible here.
    fs.writeFileSync(workspaceFile('package.json'), '{"name":"aisignal","type":"module","dependencies":{"left-pad":"1.3.0"}}\n')

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    const drift = result.drifts.find((d) => d.filePath === path.resolve(workspaceFile('package.json')))
    assert.ok(drift, 'the workspace package.json must be monitored')
  })

  it('leaves the workspace node_modules out of the baseline, and nothing else', () => {
    fs.writeFileSync(
      path.join(workspaceDir, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = () => "second"\n',
    )
    // Written into a directory that is not named node_modules, to show the
    // exclusion is the literal name and not "anything that looks vendored".
    fs.mkdirSync(workspaceFile('vendor'), { recursive: true })
    fs.writeFileSync(workspaceFile('vendor', 'helper.mjs'), 'export const helper = () => "first"\n')
    integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    fs.writeFileSync(workspaceFile('vendor', 'helper.mjs'), 'export const helper = () => "second"\n')

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    assert.equal(
      result.drifts.some((d) => d.filePath.includes(`${path.sep}node_modules${path.sep}`)),
      false,
      'installed packages are deliberately unmonitored',
    )
    assert.ok(
      result.drifts.find((d) => d.filePath === path.resolve(workspaceFile('vendor', 'helper.mjs'))),
      'only the literal node_modules name is skipped',
    )
  })

  it('baselines a plain extension exactly once', () => {
    // The shim path and the resolved source path are the same file for an
    // extension with no workspace, and the id is sha1 of the resolved path, so
    // the two pushes collapse. One edit must therefore be one drift.
    fs.writeFileSync(path.join(extensionsDir, 'plain.js'), 'module.exports = { name: "plain-modified" }\n')

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    const drifts = result.drifts.filter((d) => d.filePath === path.resolve(path.join(extensionsDir, 'plain.js')))
    assert.equal(drifts.length, 1, 'a plain extension must not be baselined twice')
  })
})
