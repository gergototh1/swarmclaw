import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/*
 * THIS FILE GETS ITS OWN DATA DIRECTORY
 * =====================================
 * Every test here reconciles extension-managed resources through the route,
 * which saves agents and schedules, and the `afterEach` below restores the
 * collections it read at load. Against the real DATA_DIR -- the developer's
 * own instance -- that restore is not a safety net: this file runs as one of
 * many parallel `test:runtime` processes writing the same SQLite file, and an
 * interrupted restore leaves whatever the test had written. It was the one
 * managed-resources test still doing that after its sibling,
 * src/lib/server/extension-managed-resources.test.ts, was moved.
 *
 * The import below must stay FIRST among the imports that reach `data-dir.ts`:
 * DATA_DIR is read once, at import time, and ES modules evaluate their
 * dependencies in import order. The assertion under the imports is what
 * catches the import moving: it runs at module level, so a wrong directory
 * aborts the file before its first test writes anything.
 */
import { assertIsolatedDataDir } from '@/lib/server/test-support/isolated-data-dir'

import { DATA_DIR, WORKSPACE_DIR } from '@/lib/server/data-dir'
import { getExtensionManager } from '@/lib/server/extensions'
import { loadAgents, loadSchedules, loadSettings, saveAgents, saveSchedules, saveSettings } from '@/lib/server/storage'
import { GET, POST } from './route'

assertIsolatedDataDir({ DATA_DIR, WORKSPACE_DIR })

const originalAgents = loadAgents()
const originalSchedules = loadSchedules()
const originalSettings = loadSettings()

let seq = 0

function extensionId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now()}_${seq}`
}

afterEach(() => {
  saveAgents(originalAgents)
  saveSchedules(originalSchedules)
  saveSettings(originalSettings)
})

test('managed resources route reconciles one extension', async () => {
  const id = extensionId('route_managed_resources')
  getExtensionManager().registerBuiltin(id, {
    name: 'Route Managed Fixture',
    managedResources: {
      agents: [
        {
          agentKey: 'operator',
          displayName: 'Route Operator',
          provider: 'openai',
          model: 'gpt-4o-mini',
        },
      ],
    },
  })

  const before = await GET(new Request('http://local/api/extensions/managed-resources'))
  assert.equal(before.status, 200)
  const beforeBody = await before.json()
  const extension = beforeBody.extensions.find((entry: { extensionId: string }) => entry.extensionId === id)
  assert.equal(extension.agents[0].status, 'missing')

  const response = await POST(new Request('http://local/api/extensions/managed-resources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reconcile', extensionId: id }),
  }))

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.createdAgents.length, 1)
  const agent = loadAgents()[body.createdAgents[0]]
  assert.ok(agent)
  assert.equal(agent.managedByExtension?.extensionId, id)
})

test('managed resources route configures and lists a local folder', async () => {
  const id = extensionId('route_managed_folder')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-route-folder-'))
  fs.mkdirSync(path.join(tempDir, 'inputs'))
  fs.writeFileSync(path.join(tempDir, 'inputs', 'task.txt'), 'task\n')

  getExtensionManager().registerBuiltin(id, {
    name: 'Route Folder Fixture',
    managedResources: {
      localFolders: [
        {
          folderKey: 'workspace',
          displayName: 'Workspace Folder',
          access: 'readWrite',
          requiredDirectories: ['inputs'],
          requiredFiles: ['inputs/task.txt'],
        },
      ],
    },
  })

  const configure = await POST(new Request('http://local/api/extensions/managed-resources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'configure_local_folder',
      extensionId: id,
      folderKey: 'workspace',
      path: tempDir,
    }),
  }))
  assert.equal(configure.status, 200)
  const configured = await configure.json()
  assert.equal(configured.status.healthy, true)

  const listing = await GET(new Request(`http://local/api/extensions/managed-resources?action=list_local_folder&extensionId=${encodeURIComponent(id)}&folderKey=workspace&recursive=true`))
  assert.equal(listing.status, 200)
  const listingBody = await listing.json()
  assert.ok(listingBody.entries.some((entry: { path: string }) => entry.path === 'inputs/task.txt'))

  const traversal = await POST(new Request('http://local/api/extensions/managed-resources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'list_local_folder',
      extensionId: id,
      folderKey: 'workspace',
      relativePath: '../outside',
    }),
  }))
  assert.equal(traversal.status, 400)

  fs.rmSync(tempDir, { recursive: true, force: true })
})
