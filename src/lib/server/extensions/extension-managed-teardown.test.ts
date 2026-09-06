import assert from 'node:assert/strict'
import test from 'node:test'

// Must be the first import that reaches data-dir.ts: this test upserts a
// project and a task and then deletes the project, and running that against
// a developer's own DATA_DIR would corrupt real data. See isolated-data-dir.ts.
import { assertIsolatedDataDir } from '@/lib/server/test-support/isolated-data-dir'

import { DATA_DIR, WORKSPACE_DIR } from '@/lib/server/data-dir'
import { loadProjects, upsertProject } from '@/lib/server/projects/project-repository'
import { getTask, saveTask } from '@/lib/server/tasks/task-repository'
import { removeExtensionManagedResources } from './extension-managed-teardown'

assertIsolatedDataDir({ DATA_DIR, WORKSPACE_DIR })

test('teardown deletes a managed project and detaches its tasks', () => {
  upsertProject('managed_project_x', {
    id: 'managed_project_x',
    name: 'CRM',
    description: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    managedByExtension: {
      extensionId: 'crm.mjs',
      resourceKind: 'project',
      resourceKey: 'crm',
      reconciledAt: Date.now(),
    },
  })
  saveTask('t1', {
    id: 't1',
    title: 'x',
    description: '',
    status: 'todo',
    agentId: 'a1',
    projectId: 'managed_project_x',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const result = removeExtensionManagedResources('crm.mjs')

  assert.deepEqual(result.deletedProjects, ['managed_project_x'])
  assert.equal(loadProjects()['managed_project_x'], undefined)
  assert.equal(getTask('t1')?.projectId, undefined)
})
