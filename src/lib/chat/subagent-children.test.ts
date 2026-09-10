import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { listRunningSubagentChildren, listSubagentChildren } from './subagent-children'
import type { Session, Sessions } from '@/types'

function session(over: Partial<Session> & { id: string }): Session {
  return {
    name: 'x', cwd: '/tmp', user: 'agent', provider: 'claude-cli', model: '',
    claudeSessionId: null, messages: [], createdAt: 0, lastActiveAt: 0,
    ...over,
  } as Session
}

function store(list: Session[]): Sessions {
  return Object.fromEntries(list.map((s) => [s.id, s])) as Sessions
}

describe('listSubagentChildren', () => {
  it('finds the delegated children of one chat, newest first', () => {
    const sessions = store([
      session({ id: 'p', sessionType: 'human' }),
      session({ id: 'c1', sessionType: 'delegated', parentSessionId: 'p', lastActiveAt: 100 }),
      session({ id: 'c2', sessionType: 'delegated', parentSessionId: 'p', lastActiveAt: 200 }),
    ])
    assert.deepEqual(listSubagentChildren(sessions, 'p').map((s) => s.id), ['c2', 'c1'])
  })

  it('does not claim another chat\'s children', () => {
    const sessions = store([
      session({ id: 'c1', sessionType: 'delegated', parentSessionId: 'other' }),
    ])
    assert.deepEqual(listSubagentChildren(sessions, 'p'), [])
  })

  it('does not claim a chat the user branched off this one', () => {
    /*
     * Ugyanaz a csapda, mint az isConversation szűrőnél: a
     * buildNewAgentSessionPayload a felhasználó saját "új chat ebből"
     * sessionjére is ráteszi a szülőt, csak 'human' típussal. Az nem subagent.
     */
    const sessions = store([
      session({ id: 'branch', sessionType: 'human', parentSessionId: 'p' }),
    ])
    assert.deepEqual(listSubagentChildren(sessions, 'p'), [])
  })

  it('returns nothing for a chat that spawned nothing', () => {
    assert.deepEqual(listSubagentChildren(store([session({ id: 'p' })]), 'p'), [])
  })
})

/*
 * A fejléc alatti sáv csak a FUTÓ gyerekeket listázza.
 *
 * Egy befejezett subagent a transzkript inline sorából érhető el, ott van a
 * helye -- ide az kerül, amibe a felhasználó most bele tud nyúlni. Ha a
 * befejezettek is idekerülnének, a sáv egy régi chatben húsz sorra hízna.
 */
describe('listRunningSubagentChildren', () => {
  it('keeps only the ones still running', () => {
    const sessions = store([
      session({ id: 'done', sessionType: 'delegated', parentSessionId: 'p', active: false, lastActiveAt: 300 }),
      session({ id: 'live', sessionType: 'delegated', parentSessionId: 'p', active: true, lastActiveAt: 100 }),
    ])
    assert.deepEqual(listRunningSubagentChildren(sessions, 'p').map((s) => s.id), ['live'])
  })

  it('treats a missing active flag as not running', () => {
    // `active` opcionális; a hiánya nem bizonyíték arra, hogy fut.
    const sessions = store([
      session({ id: 'unknown', sessionType: 'delegated', parentSessionId: 'p' }),
    ])
    assert.deepEqual(listRunningSubagentChildren(sessions, 'p'), [])
  })

  it('still orders newest first', () => {
    const sessions = store([
      session({ id: 'older', sessionType: 'delegated', parentSessionId: 'p', active: true, lastActiveAt: 100 }),
      session({ id: 'newer', sessionType: 'delegated', parentSessionId: 'p', active: true, lastActiveAt: 900 }),
    ])
    assert.deepEqual(listRunningSubagentChildren(sessions, 'p').map((s) => s.id), ['newer', 'older'])
  })

  it('does not report a running chat the user branched off this one', () => {
    const sessions = store([
      session({ id: 'branch', sessionType: 'human', parentSessionId: 'p', active: true }),
    ])
    assert.deepEqual(listRunningSubagentChildren(sessions, 'p'), [])
  })
})
