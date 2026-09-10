import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

/*
 * Regression for the single-session sibling of the bug fixed in
 * `src/app/api/chats/route.test.ts`: `getChatSessionForApi()` returned the
 * stale, empty stored `lastMessageSummary` while the real text sat only in
 * `session_messages`. The list endpoint was fixed for every session at once;
 * this pins that opening or refreshing ONE chat (`GET /api/chats/:id`) gets
 * the same real summary rather than clobbering it with the empty stored
 * field once `refreshSession` (src/stores/slices/session-slice.ts) replaces
 * the whole store entry with this endpoint's response.
 */
test('GET /api/chats/:id fills lastMessageSummary from the message table when the stored summary is empty', () => {
  const output = runWithTempDataDir<{
    text: string
    role: string
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const routeMod = await import('./src/app/api/chats/[id]/route')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    const realText = 'a'.repeat(1200)

    storage.saveSessions({
      sess_stale_summary_single: {
        id: 'sess_stale_summary_single',
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

    repo.appendMessage('sess_stale_summary_single', { role: 'user', text: 'ping', time: now - 10 })
    repo.appendMessage('sess_stale_summary_single', { role: 'assistant', text: realText, time: now })

    // appendMessage keeps the blob's lastMessageSummary in sync as it goes
    // (syncSessionMeta), so force the drift explicitly here to match the
    // reported real-install state -- messages in the table, an empty summary
    // on the stored record -- without depending on how that drift originally
    // happened.
    storage.patchSession('sess_stale_summary_single', (current) => {
      if (!current) return null
      current.lastMessageSummary = { role: 'assistant', text: '', time: now }
      return current
    })

    const response = await route.GET(
      new Request('http://local/api/chats/sess_stale_summary_single'),
      { params: Promise.resolve({ id: 'sess_stale_summary_single' }) },
    )
    const payload = await response.json()
    const summary = payload.lastMessageSummary

    console.log(JSON.stringify({ text: summary?.text ?? '', role: summary?.role ?? '' }))
  `, { prefix: 'swarmclaw-chats-single-summary-' })

  assert.equal(output.role, 'assistant')
  assert.ok(output.text.length > 0, 'lastMessageSummary.text must not be empty')
  assert.ok(output.text.startsWith('aaaa'), 'must carry the real message text, not the empty stored summary')
})
