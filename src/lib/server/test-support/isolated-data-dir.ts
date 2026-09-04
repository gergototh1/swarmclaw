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

export const ISOLATED_DATA_DIR = process.env.DATA_DIR
