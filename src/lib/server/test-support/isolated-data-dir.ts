/**
 * Points DATA_DIR and WORKSPACE_DIR at a throwaway directory, as a side effect
 * of being imported.
 *
 * A test that writes agents, schedules or settings writes them wherever
 * `data-dir.ts` resolved DATA_DIR to, and `data-dir.ts` resolves it once, at
 * import time. Left alone that is the developer's own instance: the suite then
 * edits a live database, several `test:runtime` processes write the same SQLite
 * file at once, and a test that deletes a row can leave it deleted --
 * `ensureDefaultAgent` re-seeds a `default` agent only when the agents table is
 * EMPTY, so an interrupted restore is permanent.
 *
 * This has to run before the first module that reads DATA_DIR is evaluated,
 * which is why it is a module with a side effect rather than a function: ES
 * modules evaluate their dependencies in import order, so
 *
 *     import '@/lib/server/test-support/isolated-data-dir'
 *     import { loadAgents } from '@/lib/server/storage'
 *
 * is ordered, while an assignment written in the test body is not. It also
 * keeps the test's own imports static, so the test and the code under test
 * share one module instance -- a dynamic `./storage` and an aliased
 * `@/lib/server/storage` are two instances with two collection caches, and a
 * write through one is invisible to a read through the other.
 *
 * The directory is removed when the process exits. Importing this from anything
 * but a test would repoint that process's whole data directory.
 *
 * Setting the variables is only half of it. If this import is written BELOW
 * one that reads DATA_DIR, the variables are set too late, `data-dir.ts` has
 * already resolved the instance's own directory, and every test in the file
 * writes there -- and a test that merely checks the result runs after the
 * other tests have already written. So a consumer also calls
 * `assertIsolatedDataDir` at the top level of the module, outside any
 * `test()`, with the constants `data-dir.ts` actually resolved: a throw there
 * aborts the file before its first test runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-test-data-'))

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // A leftover directory under the OS temp root is not worth failing a run.
  }
})

/**
 * Throws unless `data-dir.ts` resolved DATA_DIR and WORKSPACE_DIR to the
 * throwaway directory this module set up. Pass the constants imported from
 * `data-dir.ts` -- those are what storage opened -- and call it at module
 * level so nothing in the file runs against the wrong directory.
 */
export function assertIsolatedDataDir(resolved: { DATA_DIR: string; WORKSPACE_DIR: string }): void {
  if (resolved.DATA_DIR !== process.env.DATA_DIR || resolved.WORKSPACE_DIR !== process.env.WORKSPACE_DIR) {
    throw new Error(
      `data-dir.ts resolved DATA_DIR=${resolved.DATA_DIR} and WORKSPACE_DIR=${resolved.WORKSPACE_DIR} before this test file pointed them at ${root}; `
      + 'the isolated-data-dir import must be the first import that reaches data-dir.ts',
    )
  }
}
