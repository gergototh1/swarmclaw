import type { BoardTask } from '@/types'

export interface ProblemTaskRow {
  task: BoardTask
  kind: 'failed' | 'blocked'
}

/**
 * Select failed and blocked kanban tasks for the home page's "Needs you" list.
 *
 * A failed task is always listed as failed, not blocked, via an `else if`,
 * so it never appears twice.
 *
 * Results are sorted newest-first by `updatedAt || createdAt`.
 */
export function selectProblemTasks(tasks: Record<string, BoardTask>): ProblemTaskRow[] {
  const rows: ProblemTaskRow[] = []
  for (const task of Object.values(tasks)) {
    if (task.status === 'failed') rows.push({ task, kind: 'failed' })
    else if ((task.blockedBy?.length ?? 0) > 0) rows.push({ task, kind: 'blocked' })
  }
  return rows.sort((a, b) => (b.task.updatedAt || b.task.createdAt || 0) - (a.task.updatedAt || a.task.createdAt || 0))
}
