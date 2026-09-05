import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-schedule-route-test-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
        SWARMCLAW_BUILD_MODE: '1',
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('runScheduleNow for a schedule an extension manages', () => {
  it('refuses with 409 and creates no task while the extension is disabled, and queues a run once it is enabled', () => {
    const output = runWithTempDataDir(`
      const unwrap = (mod) => mod.default || mod
      const { getExtensionManager } = unwrap(await import('@/lib/server/extensions'))
      const { reconcileExtensionManagedResources } = unwrap(await import('@/lib/server/extension-managed-resources'))
      const { loadSchedules } = unwrap(await import('@/lib/server/schedules/schedule-repository'))
      const { loadTasks } = unwrap(await import('@/lib/server/tasks/task-repository'))
      const { runScheduleNow } = unwrap(await import('@/lib/server/schedules/schedule-route-service'))

      const extensionId = 'run_now_managed.mjs'
      const m = getExtensionManager()
      await m.saveExtensionSource(extensionId, \`export default {
        name: 'Run Now Fixture',
        tools: [],
        managedResources: {
          agents: [{ agentKey: 'worker', displayName: 'Managed Worker', provider: 'ollama', model: 'test-model', heartbeatEnabled: false }],
          schedules: [{
            scheduleKey: 'hourly', displayName: 'Managed hourly run', taskPrompt: 'Do the managed work.', taskMode: 'task',
            agentRef: { resourceKind: 'agent', resourceKey: 'worker' },
            scheduleType: 'cron', cron: '0 * * * *', timezone: 'UTC', status: 'active',
          }],
        },
      }\`)
      reconcileExtensionManagedResources(extensionId)
      const created = Object.values(loadSchedules()).find((s) => s.managedByExtension?.extensionId === extensionId)
      if (!created) throw new Error('reconcile did not create the managed schedule')

      await m.setEnabled(extensionId, false)
      const activationWhileDisabled = m.getActivationState(extensionId)
      const refused = runScheduleNow(created.id)
      const afterRefusal = loadSchedules()[created.id]
      const tasksAfterRefusal = Object.keys(loadTasks()).length

      await m.setEnabled(extensionId, true)
      const accepted = runScheduleNow(created.id)
      const afterRun = loadSchedules()[created.id]

      console.log(JSON.stringify({
        activationWhileDisabled,
        refused,
        tasksAfterRefusal,
        historyActionsAfterRefusal: (afterRefusal.history || []).map((entry) => entry.action),
        runNumberAfterRefusal: afterRefusal.runNumber || 0,
        lastRunAtAfterRefusal: afterRefusal.lastRunAt ?? null,
        acceptedOk: accepted.ok,
        acceptedQueued: accepted.ok ? accepted.payload.queued : null,
        tasksAfterRun: Object.keys(loadTasks()).length,
        runNumberAfterRun: afterRun.runNumber || 0,
        latestActionAfterRun: afterRun.history?.[0]?.action ?? null,
      }))
    `)

    assert.equal(output.activationWhileDisabled, 'disabled')
    assert.equal(output.refused.ok, false)
    assert.equal(output.refused.status, 409)
    assert.match(output.refused.payload.error, /Extension run_now_managed\.mjs is disabled/)
    assert.match(output.refused.payload.error, /Enable the extension/)
    assert.equal(output.tasksAfterRefusal, 0, 'a refused click creates no task')
    assert.equal(output.historyActionsAfterRefusal.includes('run_started'), false, 'a refused click records no run')
    assert.equal(output.runNumberAfterRefusal, 0)
    assert.equal(output.lastRunAtAfterRefusal, null)

    assert.equal(output.acceptedOk, true)
    assert.equal(output.acceptedQueued, true)
    assert.equal(output.tasksAfterRun, 1)
    assert.equal(output.runNumberAfterRun, 1)
    assert.equal(output.latestActionAfterRun, 'run_started')
  })

  it('refuses with 409 when the marker names an extension that is not loaded', () => {
    const output = runWithTempDataDir(`
      const unwrap = (mod) => mod.default || mod
      const storage = unwrap(await import('@/lib/server/storage'))
      const { loadTasks } = unwrap(await import('@/lib/server/tasks/task-repository'))
      const { runScheduleNow } = unwrap(await import('@/lib/server/schedules/schedule-route-service'))

      const now = Date.now()
      storage.saveAgents({
        'agent-1': {
          id: 'agent-1',
          name: 'Orphan Agent',
          provider: 'ollama',
          model: 'test-model',
          systemPrompt: 'test',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.upsertSchedule('sched-orphan', {
        id: 'sched-orphan',
        name: 'Orphaned managed run',
        agentId: 'agent-1',
        taskPrompt: 'Do the orphaned work.',
        scheduleType: 'cron',
        cron: '0 * * * *',
        timezone: 'UTC',
        status: 'active',
        nextRunAt: now + 60_000,
        managedByExtension: { extensionId: 'never_installed.mjs', resourceKind: 'schedule', resourceKey: 'hourly', reconciledAt: now },
        createdAt: now - 10_000,
        updatedAt: now - 10_000,
      })

      const refused = runScheduleNow('sched-orphan')
      console.log(JSON.stringify({
        refused,
        tasks: Object.keys(loadTasks()).length,
        runNumber: storage.loadSchedules()['sched-orphan'].runNumber || 0,
      }))
    `)

    assert.equal(output.refused.ok, false)
    assert.equal(output.refused.status, 409)
    assert.match(output.refused.payload.error, /Extension never_installed\.mjs is not loaded/)
    assert.equal(output.tasks, 0)
    assert.equal(output.runNumber, 0)
  })
})
