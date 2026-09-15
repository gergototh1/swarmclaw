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
let answerModule: typeof import('@/lib/server/human-question-answer')
let mailbox: typeof import('@/lib/server/chatrooms/session-mailbox')
let repo: typeof import('@/lib/server/messages/message-repository')
let storage: typeof import('@/lib/server/storage')

const payload = {
  questions: [{ header: 'Adatbázis', question: 'Melyik legyen?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
  expectedFormat: null,
  notes: null,
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-human-answer-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  answerModule = await import('@/lib/server/human-question-answer')
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

describe('answerHumanQuestion', () => {
  it('writes the answer into the transcript, closes the question and replies', () => {
    const seq = seedQuestion('s-answer', 'c1')
    const result = answerModule.answerHumanQuestion({
      sessionId: 's-answer',
      correlationId: 'c1',
      answers: [{ header: 'Adatbázis', question: 'Melyik legyen?', selected: ['SQLite'] }],
    })
    assert.equal(result.ok, true)

    const question = repo.getMessageBySeq('s-answer', seq)
    assert.equal(question?.questionState?.status, 'answered')
    assert.deepEqual(question?.questionState?.answers?.[0].selected, ['SQLite'])

    const messages = repo.getMessages('s-answer')
    const last = messages[messages.length - 1]
    assert.equal(last.role, 'user')
    assert.match(last.text, /SQLite/)

    const envelopes = mailbox.listMailbox('s-answer', { includeAcked: true })
    assert.ok(envelopes.some((envelope) => envelope.type === 'human_reply' && envelope.correlationId === 'c1'))
    const request = envelopes.find((envelope) => envelope.type === 'human_request')
    assert.equal(request?.status, 'ack')
  })

  it('rejects an option that is not on the list', () => {
    seedQuestion('s-bad', 'c2')
    const result = answerModule.answerHumanQuestion({
      sessionId: 's-bad',
      correlationId: 'c2',
      answers: [{ question: 'Melyik legyen?', selected: ['MySQL'] }],
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.status, 400)
  })

  it('rejects an unknown correlationId', () => {
    createTestSession('s-missing')
    const result = answerModule.answerHumanQuestion({
      sessionId: 's-missing',
      correlationId: 'nope',
      answers: [{ question: 'Melyik legyen?', selected: ['SQLite'] }],
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.status, 404)
  })
})

describe('supersedePendingHumanQuestions', () => {
  it('closes the open question and acks its envelope', () => {
    const seq = seedQuestion('s-super', 'c3')
    const closed = answerModule.supersedePendingHumanQuestions('s-super')
    assert.equal(closed, 1)
    assert.equal(repo.getMessageBySeq('s-super', seq)?.questionState?.status, 'superseded')
    const request = mailbox.listMailbox('s-super', { includeAcked: true }).find((envelope) => envelope.type === 'human_request')
    assert.equal(request?.status, 'ack')
  })

  it('does nothing when there is no open question', () => {
    createTestSession('s-empty')
    assert.equal(answerModule.supersedePendingHumanQuestions('s-empty'), 0)
  })
})
