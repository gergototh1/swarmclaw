import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

/*
 * Regression for: the desktop notification body (and the chat list's own
 * preview) showed the chat NAME instead of the agent's reply. Root cause: in
 * a real install every session's stored `lastMessageSummary.text` had length
 * 0 while the real text (1000-1500 chars) sat in the `session_messages`
 * table -- the same staleness `getMessageCounts()` already works around for
 * `messageCount`. This pins that the list endpoint fills
 * `lastMessageSummary.text` from the message table instead of trusting the
 * stale stored field.
 */
test('GET /api/chats fills lastMessageSummary from the message table when the stored summary is empty', () => {
  const output = runWithTempDataDir<{
    text: string
    role: string
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const routeMod = await import('./src/app/api/chats/route')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    const realText = 'a'.repeat(1200)

    storage.saveSessions({
      sess_stale_summary: {
        id: 'sess_stale_summary',
        name: 'Stale Summary Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        // The empty stored summary is the bug: every real-install session had
        // this shape while the real text lived only in session_messages.
        lastMessageSummary: { role: 'assistant', text: '', time: now },
        createdAt: now,
        lastActiveAt: now,
      },
    })

    repo.appendMessage('sess_stale_summary', { role: 'user', text: 'ping', time: now - 10 })
    repo.appendMessage('sess_stale_summary', { role: 'assistant', text: realText, time: now })

    // appendMessage keeps the blob's lastMessageSummary in sync as it goes
    // (syncSessionMeta), which is exactly why the real-install bug is hard to
    // repro from a fresh write path: it only shows up for rows that predate
    // that sync, or were written some other way. Force the drift explicitly
    // here so the fixture matches the reported state -- messages in the
    // table, an empty summary on the stored record -- without depending on
    // how that drift originally happened.
    storage.patchSession('sess_stale_summary', (current) => {
      if (!current) return null
      current.lastMessageSummary = { role: 'assistant', text: '', time: now }
      return current
    })

    const response = await route.GET(new Request('http://local/api/chats'))
    const payload = await response.json()
    const summary = payload.sess_stale_summary.lastMessageSummary

    console.log(JSON.stringify({ text: summary?.text ?? '', role: summary?.role ?? '' }))
  `, { prefix: 'swarmclaw-chats-list-summary-' })

  assert.equal(output.role, 'assistant')
  assert.ok(output.text.length > 0, 'lastMessageSummary.text must not be empty')
  assert.ok(output.text.startsWith('aaaa'), 'must carry the real message text, not the empty stored summary')
})
