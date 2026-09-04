import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

export function runWithTempDataDir<T = unknown>(
  script: string,
  options: {
    prefix?: string
    dataDir?: string
    workspaceDir?: string
    browserProfilesDir?: string
    timeoutMs?: number
  } = {},
): T {
  // Realpath'd on purpose. `os.tmpdir()` is a symlink on macOS
  // (`/var/folders/...` -> `/private/var/folders/...`) and a real directory on
  // Linux, and code that has to agree with a path Node resolved -- the module
  // cache key in `extensions.ts` is the one that got this wrong -- then behaves
  // one way on a developer's machine and another way in CI. Handing every test a
  // resolved directory makes the two environments the same. A test that wants
  // the symlinked shape asks for it explicitly by passing an absolute
  // `dataDir`, which is what the reload test in extension-contracts.test.ts
  // does.
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || 'swarmclaw-test-')))
  const resolveTempPath = (value: string | undefined, fallback: string): string =>
    path.isAbsolute(value || '') ? String(value) : path.join(tempDir, value || fallback)
  const dataDir = resolveTempPath(options.dataDir, '')
  const workspaceDir = resolveTempPath(options.workspaceDir, 'workspace')
  const browserProfilesDir = options.browserProfilesDir
    ? resolveTempPath(options.browserProfilesDir, 'browser-profiles')
    : null

  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })
  if (browserProfilesDir) fs.mkdirSync(browserProfilesDir, { recursive: true })

  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        WORKSPACE_DIR: workspaceDir,
        ...(browserProfilesDir ? { BROWSER_PROFILES_DIR: browserProfilesDir } : {}),
      },
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? 120_000,
    })

    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout || 'subprocess failed')

    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}') as T
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
