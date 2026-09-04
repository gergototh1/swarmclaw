import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

export interface RunWithTempDataDirOptions {
  prefix?: string
  dataDir?: string
  workspaceDir?: string
  browserProfilesDir?: string
  timeoutMs?: number
  /**
   * The executable to run the script with. Defaults to `process.execPath`, the
   * Node running the test.
   *
   * This exists so a test can drive a *shipped* runtime rather than the one the
   * test runner happens to be. The product runs on plain Node (`next dev`,
   * `node .next/standalone/server.js`) and on Electron's embedded Node, and
   * those are not the same Node: Electron 33 bundles 20.18.3, which cannot
   * `require()` an ESM file at all. Point this at
   * `require('electron')` -- the path to the Electron binary -- with
   * `ELECTRON_RUN_AS_NODE=1` in `env` to exercise it.
   */
  execPath?: string
  /**
   * Whether to run the script through `tsx`. Defaults to true, which is what
   * lets a script `import('@/lib/server/...')` TypeScript directly.
   *
   * Pass false to run under an unmodified module system. tsx installs loader
   * hooks that transpile what they resolve, including an extension's own `.mjs`
   * files, so a script that runs only under tsx says nothing about how the
   * shipped loader treats an ESM extension. That gap is exactly how the
   * ERR_REQUIRE_ESM defect stayed invisible through two green test rounds. A
   * script with this off cannot use TypeScript or `@/` specifiers and must
   * reach the code under test some other way -- as plain JS, or transpiled to a
   * temporary file first.
   */
  useTsx?: boolean
  /** Extra environment variables for the child, merged over the defaults. */
  env?: Record<string, string>
}

export function runWithTempDataDir<T = unknown>(
  script: string,
  options: RunWithTempDataDirOptions = {},
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
  //
  // That symlink reload test ('re-executes an edited extension when DATA_DIR
  // reaches it through a symlink') is the *only* consumer left that exercises
  // a symlinked data directory -- every other caller now gets the realpath'd
  // `tempDir` above. Do not delete that test as redundant with this
  // realpathing: it is the one place left that would catch a regression in
  // the module-cache-key symlink handling this comment describes.
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
    const useTsx = options.useTsx !== false
    const args = [
      ...(useTsx ? ['--import', 'tsx'] : []),
      '--input-type=module',
      '--eval',
      script,
    ]
    const result = spawnSync(options.execPath || process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        WORKSPACE_DIR: workspaceDir,
        ...(browserProfilesDir ? { BROWSER_PROFILES_DIR: browserProfilesDir } : {}),
        ...(options.env || {}),
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
