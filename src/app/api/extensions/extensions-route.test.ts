import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

/*
 * THIS FILE GETS ITS OWN DATA DIRECTORY
 * =====================================
 * Enabling an extension through this route now reconciles what it declares,
 * which saves agents and schedules. Against the real DATA_DIR -- the
 * developer's own instance -- the `afterEach` restore is not a safety net:
 * this file runs as one of many parallel `test:runtime` processes writing the
 * same SQLite file, and an interrupted restore leaves whatever the test wrote.
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
import { PATCH, POST } from './route'

assertIsolatedDataDir({ DATA_DIR, WORKSPACE_DIR })

const originalAgents = loadAgents()
const originalSchedules = loadSchedules()
const originalSettings = loadSettings()

let seq = 0

function extensionId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now()}_${seq}`
}

function post(body: unknown): Promise<Response> {
  return POST(new Request('http://local/api/extensions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

afterEach(() => {
  saveAgents(originalAgents)
  saveSchedules(originalSchedules)
  saveSettings(originalSettings)
})

function registerDeclaringExtension(id: string): void {
  getExtensionManager().registerBuiltin(id, {
    name: 'Extensions Route Fixture',
    managedResources: {
      agents: [
        { agentKey: 'sweeper', displayName: 'Route Sweeper', provider: 'openai', model: 'gpt-4o-mini' },
      ],
      schedules: [
        {
          scheduleKey: 'daily',
          displayName: 'Route Daily',
          agentRef: { resourceKind: 'agent', resourceKey: 'sweeper' },
          cron: '0 9 * * *',
        },
      ],
    },
  })
}

/**
 * The defect this file pins: an operator switched an extension on, was told
 * "Extension enabled", and got none of the agents and routines it declared,
 * because the only thing that created them was a control they had to go and
 * find. The enable now does it, and says what it did.
 */
test('enabling an extension through the route creates the agents and routines it declares', async () => {
  const id = extensionId('extensions_route_enable')
  registerDeclaringExtension(id)

  const response = await post({ filename: id, enabled: true })
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.ok, true)
  assert.equal(body.managedResources.status, 'reconciled')
  assert.equal(body.managedResources.trigger, 'enable')
  assert.equal(body.managedResources.extensionId, id)
  assert.equal(body.managedResources.result.createdAgents.length, 1)
  assert.equal(body.managedResources.result.createdSchedules.length, 1)
  assert.equal(body.managedResources.result.skipped.length, 0)

  const agentId: string = body.managedResources.result.createdAgents[0]
  assert.equal(loadAgents()[agentId]?.managedByExtension?.extensionId, id)
  assert.ok(loadSchedules()[body.managedResources.result.createdSchedules[0] as string])
})

test('disabling an extension reconciles nothing and reports no opinion about its resources', async () => {
  const id = extensionId('extensions_route_disable')
  registerDeclaringExtension(id)

  const enabled = await post({ filename: id, enabled: true })
  const created: string[] = (await enabled.json()).managedResources.result.createdAgents

  const response = await post({ filename: id, enabled: false })
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.ok, true)
  // Null, not an outcome with every count at zero: switching an extension off
  // says nothing about the resources, and a reported reconcile would be a run
  // that never happened.
  assert.equal(body.managedResources, null)
  // The agent the enable created is still there. Disable does not remove
  // managed resources -- the scheduler skips the routines while the extension
  // is off, and an uninstall is what removes them.
  assert.ok(loadAgents()[created[0]], 'disabling deleted the agent the enable created')
})

test('an extension that declares nothing enables without a reconcile being reported', async () => {
  const id = extensionId('extensions_route_plain')
  getExtensionManager().registerBuiltin(id, { name: 'Route Plain Fixture' })

  const response = await post({ filename: id, enabled: true })
  const body = await response.json()

  assert.equal(body.ok, true)
  assert.equal(body.managedResources.status, 'not_declared')
  assert.equal(body.managedResources.result, undefined)
})

test('a filename the host does not have is refused by name and reconciles nothing', async () => {
  const response = await post({ filename: 'never_installed.mjs', enabled: true })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error, 'Extension not found')
  assert.equal(body.managedResources, undefined)
})

test('update-all reports the extensions it reached instead of claiming it updated all of them', async () => {
  // No external extension exists in this throwaway directory, so the honest
  // answer is zero. The route used to answer "All extensions updated" whatever
  // happened, which read the same when every download had failed.
  const response = await PATCH(new Request('http://local/api/extensions?all=true', { method: 'PATCH' }))
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.deepEqual(body.updated, [])
  assert.deepEqual(body.failed, [])
  assert.deepEqual(body.managedResources, [])
  assert.equal(body.ok, true)
  assert.doesNotMatch(body.message, /All extensions updated/)
})
