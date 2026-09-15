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

let mailbox: typeof import('@/lib/server/chatrooms/session-mailbox')
let repo: typeof import('@/lib/server/messages/message-repository')
let storage: typeof import('@/lib/server/storage')

const payload = {
  questions: [{ header: 'Adatbázis', question: 'Melyik legyen?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
  expectedFormat: null,
  notes: null,
}

before(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-mailbox-answer-route-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  // The logger appends to DATA_DIR/app.log without creating the directory
  // first, so without this every log line a woken turn emits fails with ENOENT.
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mailbox = await import('@/lib/server/chatrooms/session-mailbox')
  repo = await import('@/lib/server/messages/message-repository')
  storage = await import('@/lib/server/storage')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  // Deliberately not deleting tempDir. Answering (or superseding) a question
  // may wake a real chat turn, and this module returns no handle to await it
  // by. Deleting DATA_DIR here would race that turn's own logging and bury the
  // run in ENOENT traces. A temp dir under the OS temp root is cheap and gets
  // reclaimed; unreadable test output is not. See human-question-answer.test.ts.
})

function createTestSession(id: string): void {
  const sessions = storage.loadSessions()
  sessions[id] = {
    id, name: 'Test Session', cwd: '/tmp', user: 'tester',
    provider: 'ollama', model: 'test-model', claudeSessionId: null,
    // Port 1 is never bound, so a fallback chat turn fails fast (ECONNREFUSED)
    // instead of hanging or reaching a real local Ollama daemon.
    apiEndpoint: 'http://127.0.0.1:1',
    agentId: 'agent-1', messages: [], createdAt: Date.now(), lastActiveAt: Date.now(),
  }
  storage.saveSessions(sessions)
}

function seedQuestion(sessionId: string, correlationId: string): number {
  createTestSession(sessionId)
  const seq = repo.appendMessage(sessionId, {
    role: 'assistant',
    text: 'Melyik legyen?',
    time: Date.now(),
    kind: 'question',
    question: payload,
    questionState: { correlationId, status: 'pending' },
    historyExcluded: true,
  })
  mailbox.sendMailboxEnvelope({
    toSessionId: sessionId,
    type: 'human_request',
    payload: JSON.stringify({ ...payload, messageSeq: seq }),
    fromSessionId: sessionId,
    fromAgentId: 'a1',
    correlationId,
    ttlSec: null,
  })
  return seq
}

describe('POST /api/chats/:id/mailbox action=answer', () => {
  it('answers an open question', async () => {
    const seq = seedQuestion('s-route', 'c1')
    const route = await import('@/app/api/chats/[id]/mailbox/route')
    const response = await route.POST(
      new Request('http://localhost/api/chats/s-route/mailbox', {
        method: 'POST',
        body: JSON.stringify({
          action: 'answer',
          correlationId: 'c1',
          answers: [{ header: 'Adatbázis', question: 'Melyik legyen?', selected: ['SQLite'] }],
        }),
      }),
      { params: Promise.resolve({ id: 's-route' }) },
    )
    assert.equal(response.status, 200)
    const body = await response.json() as { ok: boolean }
    assert.equal(body.ok, true)
    assert.equal(repo.getMessageBySeq('s-route', seq)?.questionState?.status, 'answered')
  })

  it('rejects an answer to a question that is not open', async () => {
    createTestSession('s-route-404')
    const route = await import('@/app/api/chats/[id]/mailbox/route')
    const response = await route.POST(
      new Request('http://localhost/api/chats/s-route-404/mailbox', {
        method: 'POST',
        body: JSON.stringify({ action: 'answer', correlationId: 'nope', answers: [] }),
      }),
      { params: Promise.resolve({ id: 's-route-404' }) },
    )
    assert.equal(response.status, 404)
  })

  it('rejects malformed answers with a 400', async () => {
    seedQuestion('s-route-400', 'c-bad')
    const route = await import('@/app/api/chats/[id]/mailbox/route')
    const response = await route.POST(
      new Request('http://localhost/api/chats/s-route-400/mailbox', {
        method: 'POST',
        body: JSON.stringify({ action: 'answer', correlationId: 'c-bad', answers: 'not-an-array' }),
      }),
      { params: Promise.resolve({ id: 's-route-400' }) },
    )
    assert.equal(response.status, 400)
  })
})

describe('POST /api/chats/:id/chat supersedes a pending question only for a real user message', () => {
  it('closes an open question when the user types instead of answering', async () => {
    const seq = seedQuestion('s-guard-user', 'c-user')
    const chatRoute = await import('@/app/api/chats/[id]/chat/route')
    await chatRoute.POST(
      new Request('http://localhost/api/chats/s-guard-user/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'never mind, let me type instead', internal: false }),
      }),
      { params: Promise.resolve({ id: 's-guard-user' }) },
    )
    assert.equal(repo.getMessageBySeq('s-guard-user', seq)?.questionState?.status, 'superseded')
  })

  it('leaves an open question open for an internal (heartbeat) turn', async () => {
    const seq = seedQuestion('s-guard-internal', 'c-internal')
    const chatRoute = await import('@/app/api/chats/[id]/chat/route')
    await chatRoute.POST(
      new Request('http://localhost/api/chats/s-guard-internal/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'heartbeat tick', internal: true }),
      }),
      { params: Promise.resolve({ id: 's-guard-internal' }) },
    )
    assert.equal(repo.getMessageBySeq('s-guard-internal', seq)?.questionState?.status, 'pending')
  })
})
