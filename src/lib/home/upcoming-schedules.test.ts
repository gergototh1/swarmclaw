import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Schedule } from '@/types'
import { selectUpcomingSchedules, NEXT_24H_MS } from './upcoming-schedules'

const NOW = 1_000_000_000_000

const schedule = (over: Partial<Schedule> & { id: string }): Schedule => ({
  name: over.id,
  agentId: 'agent-1',
  taskPrompt: 'do the thing',
  scheduleType: 'cron',
  status: 'active',
  createdAt: NOW,
  ...over,
})

describe('selectUpcomingSchedules', () => {
  it('returns an empty list when nothing is scheduled', () => {
    assert.deepEqual(selectUpcomingSchedules({}, NOW), [])
  })

  it('excludes a schedule with no nextRunAt', () => {
    const schedules = { a: schedule({ id: 'a' }) }
    assert.deepEqual(selectUpcomingSchedules(schedules, NOW), [])
  })

  it('excludes a schedule whose nextRunAt is in the past', () => {
    const schedules = { a: schedule({ id: 'a', nextRunAt: NOW - 1 }) }
    assert.deepEqual(selectUpcomingSchedules(schedules, NOW), [])
  })

  it('excludes a schedule beyond the 24-hour window', () => {
    const schedules = { a: schedule({ id: 'a', nextRunAt: NOW + NEXT_24H_MS + 1 }) }
    assert.deepEqual(selectUpcomingSchedules(schedules, NOW), [])
  })

  it('includes a schedule exactly at the window boundary', () => {
    const schedules = { a: schedule({ id: 'a', nextRunAt: NOW + NEXT_24H_MS }) }
    assert.deepEqual(selectUpcomingSchedules(schedules, NOW).map((s) => s.id), ['a'])
  })

  it('sorts soonest first', () => {
    const schedules = {
      later: schedule({ id: 'later', nextRunAt: NOW + 10_000 }),
      soonest: schedule({ id: 'soonest', nextRunAt: NOW + 1_000 }),
      middle: schedule({ id: 'middle', nextRunAt: NOW + 5_000 }),
    }
    assert.deepEqual(
      selectUpcomingSchedules(schedules, NOW).map((s) => s.id),
      ['soonest', 'middle', 'later'],
    )
  })

  it('caps the result to the given limit', () => {
    const schedules: Record<string, Schedule> = {}
    for (let i = 0; i < 8; i++) {
      schedules[`s${i}`] = schedule({ id: `s${i}`, nextRunAt: NOW + 1_000 + i })
    }
    assert.equal(selectUpcomingSchedules(schedules, NOW).length, 5)
    assert.equal(selectUpcomingSchedules(schedules, NOW, 3).length, 3)
  })
})
