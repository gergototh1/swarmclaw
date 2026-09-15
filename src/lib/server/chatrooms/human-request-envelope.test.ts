import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let mailbox: typeof import('@/lib/server/chatrooms/session-mailbox')
let storage: typeof import('@/lib/server/storage')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-human-request-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mailbox = await import('@/lib/server/chatrooms/session-mailbox')
  storage = await import('@/lib/server/storage')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function createTestSession(id: string): void {
  const sessions = storage.loadSessions()
  sessions[id] = {
    id, name: 'Test Session', cwd: '/tmp', user: 'tester',
    provider: 'ollama', model: 'test-model', claudeSessionId: null,
    agentId: 'agent-1', messages: [], createdAt: Date.now(), lastActiveAt: Date.now(),
  }
  storage.saveSessions(sessions)
}

const payload = {
  questions: [{ header: 'Adatbázis', question: 'Melyik legyen?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
  expectedFormat: null,
  notes: null,
}

describe('findPendingHumanRequestEnvelope', () => {
  it('finds the same question again', () => {
    createTestSession('s-dup')
    mailbox.sendMailboxEnvelope({
      toSessionId: 's-dup',
      type: 'human_request',
      payload: JSON.stringify(payload),
      fromSessionId: 's-dup',
      fromAgentId: 'a1',
      correlationId: 'c1',
      ttlSec: null,
    })
    const found = mailbox.findPendingHumanRequestEnvelope({
      sessionId: 's-dup',
      payload,
      fromSessionId: 's-dup',
      fromAgentId: 'a1',
    })
    assert.equal(found?.correlationId, 'c1')
  })

  it('does not match a different question', () => {
    createTestSession('s-diff')
    mailbox.sendMailboxEnvelope({
      toSessionId: 's-diff',
      type: 'human_request',
      payload: JSON.stringify(payload),
      fromSessionId: 's-diff',
      fromAgentId: 'a1',
      correlationId: 'c1',
      ttlSec: null,
    })
    const found = mailbox.findPendingHumanRequestEnvelope({
      sessionId: 's-diff',
      payload: { ...payload, questions: [{ ...payload.questions[0], question: 'Más kérdés?' }] },
      fromSessionId: 's-diff',
      fromAgentId: 'a1',
    })
    assert.equal(found, null)
  })

  it('still matches a legacy payload written before the schema change', () => {
    createTestSession('s-legacy')
    mailbox.sendMailboxEnvelope({
      toSessionId: 's-legacy',
      type: 'human_request',
      payload: JSON.stringify({ question: 'Melyik legyen?', options: ['SQLite', 'Postgres'], expectedFormat: null, notes: null }),
      fromSessionId: 's-legacy',
      fromAgentId: 'a1',
      correlationId: 'c-legacy',
      ttlSec: null,
    })
    const found = mailbox.findPendingHumanRequestEnvelope({
      sessionId: 's-legacy',
      payload: {
        questions: [{ question: 'Melyik legyen?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
        expectedFormat: null,
        notes: null,
      },
      fromSessionId: 's-legacy',
      fromAgentId: 'a1',
    })
    assert.equal(found?.correlationId, 'c-legacy')
  })
})
