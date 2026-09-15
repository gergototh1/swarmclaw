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
let watchJobs: typeof import('@/lib/server/runtime/watch-jobs')

const payload = {
  questions: [{ header: 'Adatbázis', question: 'Melyik legyen?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
  expectedFormat: null,
  notes: null,
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-human-answer-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  // The logger appends to DATA_DIR/app.log without creating the directory
  // first, so without this every log line a woken turn emits fails with ENOENT.
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })
  process.env.SWARMCLAW_BUILD_MODE = '1'
  answerModule = await import('@/lib/server/human-question-answer')
  mailbox = await import('@/lib/server/chatrooms/session-mailbox')
  repo = await import('@/lib/server/messages/message-repository')
  storage = await import('@/lib/server/storage')
  watchJobs = await import('@/lib/server/runtime/watch-jobs')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  // Deliberately not deleting tempDir. `sendMailboxEnvelope` fires
  // `triggerMailboxWatchJobs` without awaiting it, and a triggered mailbox job
  // wakes its session — so every test here that sends an envelope starts a real
  // background chat turn, not just the ones taking the fallback branch. Nothing
  // hands back a handle to await, so deleting DATA_DIR in teardown always races
  // that turn's own logging and buries the run in ENOENT traces. A temp dir
  // under the OS temp root is cheap and gets reclaimed; unreadable output is not.
})

function createTestSession(id: string): void {
  const sessions = storage.loadSessions()
  sessions[id] = {
    id, name: 'Test Session', cwd: '/tmp', user: 'tester',
    provider: 'ollama', model: 'test-model', claudeSessionId: null,
    // Port 1 is never bound, so if any path here ever did start a real chat
    // turn it would fail with ECONNREFUSED immediately rather than talking to
    // a real Ollama daemon that happens to be running on this machine.
    apiEndpoint: 'http://127.0.0.1:1',
    agentId: 'agent-1', messages: [], createdAt: Date.now(), lastActiveAt: Date.now(),
  }
  storage.saveSessions(sessions)
}

/**
 * Registers the durable wait an agent leaves behind when it calls
 * `wait_for_reply`, so `answerHumanQuestion` takes the waiter branch and never
 * reaches the real `enqueueSessionRun`.
 *
 * Every integration test in this file seeds one. A genuine fallback run starts
 * a real chat turn whose post-turn steps leak a 15s timer that keeps the whole
 * process alive (`generateAbstract` in memory-abstract.ts races a hardcoded
 * `setTimeout` it never clears) — a pre-existing bug, out of scope here, and
 * the reason the fallback's *decision* is covered by the predicate tests below
 * instead of by executing a turn.
 */
async function seedWaiter(sessionId: string, correlationId: string): Promise<void> {
  await watchJobs.createWatchJob({
    type: 'mailbox',
    sessionId,
    resumeMessage: 'A human reply arrived in the mailbox.',
    target: { sessionId },
    condition: { correlationId },
  })
}

/**
 * A `human_request` envelope with no `messageSeq`, the shape written before the
 * question message existed. Nothing for `closeQuestionMessage` to point at.
 */
function seedLegacyQuestion(sessionId: string, correlationId: string): void {
  createTestSession(sessionId)
  mailbox.sendMailboxEnvelope({
    toSessionId: sessionId,
    type: 'human_request',
    payload: JSON.stringify(payload),
    fromSessionId: sessionId,
    fromAgentId: 'a1',
    correlationId,
    ttlSec: null,
  })
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
  it('writes the answer into the transcript, closes the question and replies', async () => {
    const seq = seedQuestion('s-answer', 'c1')
    await seedWaiter('s-answer', 'c1')
    const result = answerModule.answerHumanQuestion({
      sessionId: 's-answer',
      correlationId: 'c1',
      answers: [{ header: 'Adatbázis', question: 'Melyik legyen?', selected: ['SQLite'] }],
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.enqueued, false, 'a registered waiter is woken by the envelope, so no fallback run is needed')

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

  it('succeeds without throwing when the stored request has no messageSeq (legacy envelope)', async () => {
    seedLegacyQuestion('s-legacy', 'c-legacy')
    await seedWaiter('s-legacy', 'c-legacy')
    const result = answerModule.answerHumanQuestion({
      sessionId: 's-legacy',
      correlationId: 'c-legacy',
      answers: [{ header: 'Adatbázis', question: 'Melyik legyen?', selected: ['SQLite'] }],
    })
    assert.equal(result.ok, true)

    const envelopes = mailbox.listMailbox('s-legacy', { includeAcked: true })
    assert.ok(envelopes.some((envelope) => envelope.type === 'human_reply' && envelope.correlationId === 'c-legacy'))
    assert.equal(envelopes.find((envelope) => envelope.type === 'human_request')?.status, 'ack')
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

/**
 * `answerHumanQuestion` decides whether to enqueue a fallback run by asking
 * whether the reply envelope it is about to send would wake any durable wait.
 * It asks `mailboxWatchJobMatches` — the same predicate the real trigger uses.
 *
 * These cover that decision directly. Driving it through the module instead
 * would mean letting the fallback branch start a real chat turn, which is what
 * previously made this file take ~15s and print stray ENOENT traces.
 */
describe('the waiter predicate behind the fallback decision', () => {
  function job(condition: Record<string, unknown>, targetSessionId = 's-pred'): import('@/types').WatchJob {
    return {
      id: 'job-1',
      type: 'mailbox',
      status: 'active',
      sessionId: 's-pred',
      resumeMessage: 'r',
      target: { sessionId: targetSessionId },
      condition,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  const reply = { type: 'human_reply', correlationId: 'c1', fromSessionId: 's-pred', payload: '{}' }

  it('counts a wait for this correlationId', () => {
    assert.equal(watchJobs.mailboxWatchJobMatches(job({ correlationId: 'c1' }), 's-pred', reply), true)
  })

  it('counts a wait with no correlationId at all', () => {
    assert.equal(watchJobs.mailboxWatchJobMatches(job({}), 's-pred', reply), true)
  })

  it('does not count a wait for a different correlationId', () => {
    assert.equal(watchJobs.mailboxWatchJobMatches(job({ correlationId: 'other' }), 's-pred', reply), false)
  })

  it('does not count a wait registered for a different envelope type', () => {
    // The hole this closes: such a wait never fires on our `human_reply`, so
    // treating it as a waiter would skip the fallback and drop the answer.
    assert.equal(watchJobs.mailboxWatchJobMatches(job({ type: 'other_type', correlationId: 'c1' }), 's-pred', reply), false)
  })

  it('does not count a wait aimed at another session', () => {
    assert.equal(watchJobs.mailboxWatchJobMatches(job({ correlationId: 'c1' }, 's-elsewhere'), 's-pred', reply), false)
  })
})
