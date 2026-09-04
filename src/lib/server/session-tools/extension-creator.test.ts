import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runWithTempDataDir } from '../test-utils/run-with-temp-data-dir'

/**
 * `extension_creator`, against the workspace layout.
 *
 * The tool is what an agent uses to build extensions, and its results are read
 * by a model that also holds shell and file-editing tools. So a path it reports
 * is not documentation: it is where the next edit goes. Since the loader
 * started importing the workspace entry, `data/extensions/<name>` is a
 * generated shim for any extension that has a workspace, and reporting it sent
 * that next edit to a file nothing reads.
 *
 * These cases run under tsx only. The tool goes through the extension manager,
 * which reaches the SQLite-backed storage layer, and that native module is
 * built for one Node ABI at a time.
 *
 * The package manager is stubbed on PATH throughout: a scaffold that carries a
 * `packageJson` installs dependencies, and a real install would be a network
 * request. The stub also gives the workspace a `node_modules` to notice, which
 * is what the delete case needs.
 */

function withStubPackageManager<T>(run: (env: Record<string, string>) => T): T {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-stub-npm-'))
  const stubNpm = path.join(binDir, 'npm')
  fs.writeFileSync(
    stubNpm,
    '#!/bin/sh\nmkdir -p node_modules/left-pad\nprintf \'{"name":"left-pad"}\' > node_modules/left-pad/package.json\nexit 0\n',
  )
  fs.chmodSync(stubNpm, 0o755)
  try {
    return run({ PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` })
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true })
  }
}

const SETUP = `
  import fs from 'node:fs'
  import path from 'node:path'
  const creatorMod = await import('@/lib/server/session-tools/extension-creator')
  const { buildExtensionCreatorTools } = creatorMod.default || creatorMod
  const [creator] = buildExtensionCreatorTools({ hasExtension: () => true, ctx: {} })
  const call = (args) => creator.invoke(args)

  const dataDir = process.env.DATA_DIR
  const extensionsDir = path.join(dataDir, 'extensions')
  const workspaceDir = path.join(extensionsDir, '.workspaces', 'scaf_js')
  const shimPath = path.join(extensionsDir, 'scaf.js')
  const entryPath = path.join(workspaceDir, 'index.js')
  const code = "export default { name: 'Scaffold Probe', tools: [] }"
`

describe('extension_creator against workspace-backed extensions', () => {
  it('reports the workspace entry as the scaffolded extension file, not the shim', () => {
    const out = withStubPackageManager((env) => runWithTempDataDir<{
      reportedPath: string
      entryPath: string
      reportedContent: string
      shimContent: string
      readAction: string
    }>(`
      ${SETUP}
      const scaffold = JSON.parse(await call({
        action: 'scaffold',
        filename: 'scaf.js',
        code,
        packageJson: { name: 'scaf', type: 'module' },
      }))

      console.log(JSON.stringify({
        reportedPath: scaffold.filePath,
        entryPath,
        reportedContent: fs.readFileSync(scaffold.filePath, 'utf8'),
        shimContent: fs.readFileSync(shimPath, 'utf8'),
        readAction: await call({ action: 'read', filename: 'scaf.js' }),
      }))
    `, { env }))

    assert.equal(out.reportedPath, out.entryPath, 'scaffold must report the file the loader imports')
    assert.equal(out.reportedContent.includes('Scaffold Probe'), true, 'the reported file must hold the code')
    assert.equal(
      out.shimContent.includes('Auto-generated extension workspace shim'),
      true,
      'the extensions-dir file is a shim, which is what makes reporting it a defect',
    )
    assert.equal(out.readAction, out.reportedContent, 'read and scaffold must agree on where the source is')
  })

  it('deletes a workspace-backed extension through the manager, leaving no workspace behind', () => {
    // Unlinking the extensions-dir file directly removed the shim and nothing
    // else: the workspace and its node_modules survived, the extensions.json
    // entry survived, the extension's database objects were never dropped, and
    // `manager.deleteExtension` then returned false because the file it looks
    // for was already gone, so no UI could finish the job. A later scaffold
    // under the same name found the stale workspace and wrote into it,
    // inheriting its old dependencies.
    const out = withStubPackageManager((env) => runWithTempDataDir<{
      deleteResult: string
      shimExists: boolean
      workspaceExists: boolean
      configHasEntry: boolean
      managerDeleteAfterwards: boolean
      staleDependencyAfterRescaffold: boolean
    }>(`
      ${SETUP}
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod

      await call({
        action: 'scaffold',
        filename: 'scaf.js',
        code,
        packageJson: { name: 'scaf', type: 'module' },
      })
      const installedPackage = path.join(workspaceDir, 'node_modules', 'left-pad', 'package.json')
      if (!fs.existsSync(installedPackage)) throw new Error('the stub package manager did not populate node_modules')
      // A file no install ever writes, so finding it after a delete and a fresh
      // scaffold means the new code landed in the old workspace.
      const staleMarker = path.join(workspaceDir, 'node_modules', '.left-over')
      fs.writeFileSync(staleMarker, 'from the deleted extension')

      const deleteResult = await call({ action: 'delete', filename: 'scaf.js' })
      const shimExistsAfterDelete = fs.existsSync(shimPath)
      const workspaceExistsAfterDelete = fs.existsSync(workspaceDir)

      const configPath = path.join(dataDir, 'extensions.json')
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
      const managerDeleteAfterwards = await getExtensionManager().deleteExtension('scaf.js')

      // A reinstall under the same name must start from an empty workspace.
      await call({ action: 'scaffold', filename: 'scaf.js', code, packageJson: { name: 'scaf', type: 'module' } })
      const staleDependencyAfterRescaffold = fs.existsSync(staleMarker)

      console.log(JSON.stringify({
        deleteResult,
        shimExists: shimExistsAfterDelete,
        workspaceExists: workspaceExistsAfterDelete,
        configHasEntry: Object.prototype.hasOwnProperty.call(config, 'scaf.js'),
        managerDeleteAfterwards,
        staleDependencyAfterRescaffold,
      }))
    `, { env }))

    assert.equal(out.deleteResult.startsWith('Deleted'), true, 'the delete must report success')
    assert.equal(out.shimExists, false, 'the extensions-dir file must be gone')
    assert.equal(out.workspaceExists, false, 'the workspace and its node_modules must be gone')
    assert.equal(out.configHasEntry, false, 'the extensions.json entry must be gone')
    assert.equal(
      out.managerDeleteAfterwards,
      false,
      'nothing is left for the manager to delete, which is only true because the tool went through it',
    )
    assert.equal(
      out.staleDependencyAfterRescaffold,
      false,
      'a reinstall under the same name must not inherit the deleted extension\'s node_modules',
    )
  })

  it('reports file not found for an extension that does not exist', () => {
    const out = withStubPackageManager((env) => runWithTempDataDir<{ deleteMissing: string }>(`
      ${SETUP}
      console.log(JSON.stringify({ deleteMissing: await call({ action: 'delete', filename: 'absent.js' }) }))
    `, { env }))

    assert.equal(out.deleteMissing, 'File not found: absent.js')
  })
})
