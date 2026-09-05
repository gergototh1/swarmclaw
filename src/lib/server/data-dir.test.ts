import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function extractLastJson(stdout: string): Record<string, unknown> {
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
  return JSON.parse(jsonLine || '{}')
}

describe('data-dir resolution', () => {
  it('falls back to in-project workspace when the external workspace root exists but child writes fail', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-data-dir-'))
    const fakeHome = path.join(tempDir, 'home')
    const dataDir = path.join(tempDir, 'data')
    const externalWorkspace = path.join(fakeHome, '.swarmclaw', 'workspace')
    fs.mkdirSync(externalWorkspace, { recursive: true })
    fs.chmodSync(externalWorkspace, 0o555)

    try {
      // A runner that isolates itself with SWARMCLAW_HOME or WORKSPACE_DIR
      // would otherwise hand those to the subprocess and override the
      // fallback under test.
      const env = { ...process.env, HOME: fakeHome, DATA_DIR: dataDir } as NodeJS.ProcessEnv
      delete (env as Record<string, unknown>).SWARMCLAW_HOME
      delete (env as Record<string, unknown>).WORKSPACE_DIR
      delete (env as Record<string, unknown>).BROWSER_PROFILES_DIR

      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
        const modNs = await import('./src/lib/server/data-dir')
        const mod = modNs.default || modNs['module.exports'] || modNs
        console.log(JSON.stringify({
          dataDir: mod.DATA_DIR,
          workspaceDir: mod.WORKSPACE_DIR,
        }))
      `], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8',
      })

      assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
      const payload = extractLastJson(result.stdout || '')
      assert.equal(payload.dataDir, dataDir)
      assert.equal(payload.workspaceDir, path.join(dataDir, 'workspace'))
    } finally {
      fs.chmodSync(externalWorkspace, 0o755)
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('uses isolated temp dirs during build bootstrap when DATA_DIR is unset', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-data-dir-build-'))
    const fakeHome = path.join(tempDir, 'home')

    try {
      const env = { ...process.env, HOME: fakeHome, npm_lifecycle_event: 'build:ci' } as NodeJS.ProcessEnv
      delete (env as Record<string, unknown>).DATA_DIR
      delete (env as Record<string, unknown>).WORKSPACE_DIR
      delete (env as Record<string, unknown>).BROWSER_PROFILES_DIR

      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
        const modNs = await import('./src/lib/server/data-dir')
        const mod = modNs.default || modNs['module.exports'] || modNs
        console.log(JSON.stringify({
          isBuildBootstrap: mod.IS_BUILD_BOOTSTRAP,
          dataDir: mod.DATA_DIR,
          workspaceDir: mod.WORKSPACE_DIR,
          browserProfilesDir: mod.BROWSER_PROFILES_DIR,
        }))
      `], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8',
      })

      assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
      const payload = extractLastJson(result.stdout || '')
      const expectedDataDir = path.join(os.tmpdir(), 'swarmclaw-build-data')
      assert.equal(payload.isBuildBootstrap, true)
      assert.equal(payload.dataDir, expectedDataDir)
      assert.equal(payload.workspaceDir, path.join(expectedDataDir, 'workspace'))
      assert.equal(payload.browserProfilesDir, path.join(expectedDataDir, 'browser-profiles'))
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('derives runtime directories from SWARMCLAW_HOME when set', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-data-dir-home-'))
    const fakeHome = path.join(tempDir, 'home')
    const swarmclawHome = path.join(tempDir, 'project', '.swarmclaw')

    try {
      const env = { ...process.env, HOME: fakeHome, SWARMCLAW_HOME: swarmclawHome } as NodeJS.ProcessEnv
      delete (env as Record<string, unknown>).DATA_DIR
      delete (env as Record<string, unknown>).WORKSPACE_DIR
      delete (env as Record<string, unknown>).BROWSER_PROFILES_DIR

      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
        const modNs = await import('./src/lib/server/data-dir')
        const mod = modNs.default || modNs['module.exports'] || modNs
        console.log(JSON.stringify({
          dataDir: mod.DATA_DIR,
          workspaceDir: mod.WORKSPACE_DIR,
          browserProfilesDir: mod.BROWSER_PROFILES_DIR,
          runDir: mod.RUN_DIR,
        }))
      `], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8',
      })

      assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
      const payload = extractLastJson(result.stdout || '')
      assert.equal(payload.dataDir, path.join(swarmclawHome, 'data'))
      assert.equal(payload.workspaceDir, path.join(swarmclawHome, 'workspace'))
      assert.equal(payload.browserProfilesDir, path.join(swarmclawHome, 'browser-profiles'))
      assert.equal(payload.runDir, path.join(swarmclawHome, 'run'), 'beside data/, not inside it, when a home is set')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // The repo's docker-compose.yml mounts ./data as /app/data and sets neither
  // SWARMCLAW_HOME nor DATA_DIR, so the container resolves DATA_DIR from cwd
  // and the run directory lands inside the mounted volume. This pins that
  // layout so the comment on RUN_DIR describes what happens rather than what
  // a set home would give.
  it('puts the run directory inside DATA_DIR when no SWARMCLAW_HOME is set, as in the docker-compose layout', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-data-dir-run-'))
    const fakeHome = path.join(tempDir, 'home')
    const dataDir = path.join(tempDir, 'app', 'data')

    try {
      const env = { ...process.env, HOME: fakeHome, DATA_DIR: dataDir } as NodeJS.ProcessEnv
      delete (env as Record<string, unknown>).SWARMCLAW_HOME
      delete (env as Record<string, unknown>).WORKSPACE_DIR
      delete (env as Record<string, unknown>).BROWSER_PROFILES_DIR

      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
        const modNs = await import('./src/lib/server/data-dir')
        const mod = modNs.default || modNs['module.exports'] || modNs
        console.log(JSON.stringify({ dataDir: mod.DATA_DIR, runDir: mod.RUN_DIR }))
      `], {
        cwd: repoRoot,
        env,
        encoding: 'utf-8',
      })

      assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
      const payload = extractLastJson(result.stdout || '')
      assert.equal(payload.dataDir, dataDir)
      assert.equal(payload.runDir, path.join(dataDir, 'run'))
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
