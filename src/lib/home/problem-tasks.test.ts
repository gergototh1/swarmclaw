import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BoardTask } from '@/types'
import { selectProblemTasks } from './problem-tasks'

function task(over: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    title: over.id,
    description: '',
    status: 'backlog',
    agentId: 'a1',
    createdAt: 0,
    ...over,
  } as BoardTask
}

function byId(tasks: BoardTask[]): Record<string, BoardTask> {
  return Object.fromEntries(tasks.map((t) => [t.id, t]))
}

describe('selectProblemTasks', () => {
  it('includes a failed task', () => {
    const out = selectProblemTasks(byId([task({ id: 't1', status: 'failed' })]))
    assert.deepEqual(out.map((r) => [r.task.id, r.kind]), [['t1', 'failed']])
  })

  it('includes a blocked task', () => {
    const out = selectProblemTasks(byId([task({ id: 't1', blockedBy: ['t9'] })]))
    assert.deepEqual(out.map((r) => [r.task.id, r.kind]), [['t1', 'blocked']])
  })

  it('lists a task that is both failed and blocked once, as failed', () => {
    const out = selectProblemTasks(byId([task({ id: 't1', status: 'failed', blockedBy: ['t9'] })]))
    assert.equal(out.length, 1)
    assert.equal(out[0]!.kind, 'failed')
  })

  it('excludes a task that is neither failed nor blocked', () => {
    const out = selectProblemTasks(byId([
      task({ id: 'ok', status: 'completed' }),
      task({ id: 'empty', blockedBy: [] }),
    ]))
    assert.deepEqual(out, [])
  })

  it('orders newest first, preferring updatedAt over createdAt', () => {
    const out = selectProblemTasks(byId([
      task({ id: 'old', status: 'failed', createdAt: 10 }),
      task({ id: 'new', status: 'failed', createdAt: 1, updatedAt: 30 }),
      task({ id: 'mid', status: 'failed', createdAt: 20 }),
    ]))
    assert.deepEqual(out.map((r) => r.task.id), ['new', 'mid', 'old'])
  })

  it('yields an empty array for no tasks', () => {
    assert.deepEqual(selectProblemTasks({}), [])
  })
})
