import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('appendMessage notifies both generic and per-session message topics', () => {
  const output = runWithTempDataDir<{
    genericTopics: string[]
    sessionTopics: string[]
  }>(`
    const { WebSocket } = await import('ws')
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    storage.saveSessions({
      'sess-notify': {
        id: 'sess-notify',
        name: 'Notify Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    const genericPayloads = []
    const sessionPayloads = []
    globalThis.__swarmclaw_ws__ = {
      wss: null,
      clients: new Set([
        {
          ws: {
            readyState: WebSocket.OPEN,
            send(payload) { genericPayloads.push(JSON.parse(payload)) },
          },
          topics: new Set(['messages']),
        },
        {
          ws: {
            readyState: WebSocket.OPEN,
            send(payload) { sessionPayloads.push(JSON.parse(payload)) },
          },
          topics: new Set(['messages:sess-notify']),
        },
      ]),
    }

    repo.appendMessage('sess-notify', {
      role: 'user',
      text: 'hello',
      time: 1,
    })

    console.log(JSON.stringify({
      genericTopics: genericPayloads.map((payload) => payload.topic),
      sessionTopics: sessionPayloads.map((payload) => payload.topic),
    }))
  `, { prefix: 'swarmclaw-message-repo-notify-' })

  assert.deepEqual(output.genericTopics, ['messages'])
  assert.deepEqual(output.sessionTopics, ['messages:sess-notify'])
})

test('lazy migration compacts legacy session message blobs after table persistence', () => {
  const output = runWithTempDataDir<{
    returnedTexts: string[]
    secondReadTexts: string[]
    blobMessageCount: number
    messageCount: number
    lastMessageText: string | null
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    storage.saveSessions({
      'sess-legacy-blob': {
        id: 'sess-legacy-blob',
        name: 'Legacy blob session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [
          { role: 'user', text: 'first legacy prompt', time: 1 },
          { role: 'assistant', text: 'first legacy reply', time: 2 },
          { role: 'user', text: 'second legacy prompt', time: 3 },
        ],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    const returned = repo.getMessages('sess-legacy-blob')
    const secondRead = repo.getMessages('sess-legacy-blob')
    const stored = storage.loadSessions()['sess-legacy-blob']

    console.log(JSON.stringify({
      returnedTexts: returned.map((message) => message.text),
      secondReadTexts: secondRead.map((message) => message.text),
      blobMessageCount: Array.isArray(stored.messages) ? stored.messages.length : -1,
      messageCount: stored.messageCount,
      lastMessageText: stored.lastMessageSummary?.text || null,
    }))
  `, { prefix: 'swarmclaw-message-repo-compact-' })

  assert.deepEqual(output.returnedTexts, [
    'first legacy prompt',
    'first legacy reply',
    'second legacy prompt',
  ])
  assert.deepEqual(output.secondReadTexts, output.returnedTexts)
  assert.equal(output.blobMessageCount, 0)
  assert.equal(output.messageCount, 3)
  assert.equal(output.lastMessageText, 'second legacy prompt')
})

test('bulk migration reports compaction for table-backed legacy blobs', () => {
  const output = runWithTempDataDir<{
    result: {
      migrated: number
      compacted: number
      skipped: number
      total: number
    }
    blobMessageCount: number
    messageCount: number
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    const messages = [
      { role: 'user', text: 'stale blob prompt', time: 10 },
      { role: 'assistant', text: 'stale blob reply', time: 20 },
    ]

    storage.saveSessions({
      'sess-table-backed-blob': {
        id: 'sess-table-backed-blob',
        name: 'Table backed blob session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    const db = storage.getDb()
    const insert = db.prepare('INSERT INTO session_messages (session_id, seq, data) VALUES (?, ?, ?)')
    messages.forEach((message, index) => {
      insert.run('sess-table-backed-blob', index, JSON.stringify(message))
    })

    const result = repo.migrateAllSessions()
    const stored = storage.loadSessions()['sess-table-backed-blob']

    console.log(JSON.stringify({
      result,
      blobMessageCount: Array.isArray(stored.messages) ? stored.messages.length : -1,
      messageCount: stored.messageCount,
    }))
  `, { prefix: 'swarmclaw-message-repo-migrate-report-' })

  assert.equal(output.result.migrated, 0)
  assert.equal(output.result.compacted, 1)
  assert.equal(output.result.skipped, 1)
  assert.equal(output.result.total, 1)
  assert.equal(output.blobMessageCount, 0)
  assert.equal(output.messageCount, 2)
})

test('partial and suppressed saves do not advance lastAssistantAt; the finished reply does', () => {
  const output = runWithTempDataDir<{
    afterPartial: number | null
    afterSuppressed: number | null
    afterFinal: number | null
    summaryAfterPartial: string | null
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    storage.saveSessions({
      'sess-visible': {
        id: 'sess-visible',
        name: 'Visible reply session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    const read = () => storage.loadSessions()['sess-visible']
    const user = { role: 'user', text: 'do the thing', time: 10 }
    repo.appendMessage('sess-visible', user)

    repo.replaceAllMessages('sess-visible', [
      user,
      { role: 'assistant', text: '', time: 20, streaming: true, toolEvents: [{ name: 'Bash', input: '{}' }] },
    ])
    const afterPartial = read().lastAssistantAt ?? null
    const summaryAfterPartial = read().lastMessageSummary?.role ?? null

    repo.replaceAllMessages('sess-visible', [
      user,
      { role: 'assistant', text: 'HEARTBEAT_OK', time: 25, suppressed: true },
    ])
    const afterSuppressed = read().lastAssistantAt ?? null

    repo.replaceAllMessages('sess-visible', [
      user,
      { role: 'assistant', text: 'Done: three results.', time: 30 },
    ])
    const afterFinal = read().lastAssistantAt ?? null

    console.log(JSON.stringify({ afterPartial, afterSuppressed, afterFinal, summaryAfterPartial }))
  `, { prefix: 'swarmclaw-message-repo-visible-' })

  assert.equal(output.afterPartial, null)
  assert.equal(output.afterSuppressed, null)
  assert.equal(output.afterFinal, 30)
  // The chat-list preview still follows the last row, partial or not.
  assert.equal(output.summaryAfterPartial, 'assistant')
})

test('lazy migration takes lastAssistantAt from the last visible reply, not a trailing partial', () => {
  const output = runWithTempDataDir<{ lastAssistantAt: number | null }>(`
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    storage.saveSessions({
      'sess-migrate-visible': {
        id: 'sess-migrate-visible',
        name: 'Migrate visible',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [
          { role: 'user', text: 'q', time: 1 },
          { role: 'assistant', text: 'real answer', time: 2 },
          { role: 'assistant', text: '', time: 3, streaming: true },
        ],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    repo.getMessages('sess-migrate-visible')
    console.log(JSON.stringify({ lastAssistantAt: storage.loadSessions()['sess-migrate-visible'].lastAssistantAt ?? null }))
  `, { prefix: 'swarmclaw-message-repo-migrate-visible-' })

  assert.equal(output.lastAssistantAt, 2)
})
