import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { Message, Session } from '@/types'

/*
 * A transzkript a message repositoryban van, nem a session objektumon.
 *
 * `buildSessionArchivePayload` `getMessageCount`/`getRecentMessages` hívásokkal
 * dolgozik (message-repository.ts), amióta az üzenetek kikerültek a session
 * rekordból a `session_messages` táblába. A teszt viszont még `session.messages`
 * tömböt adott át, amit az implementáció nem néz -- így `messageCount` 0 volt,
 * a függvény `null`-t adott, és a fájl két tesztje azóta piros. Nem a kód
 * romlott el: a fixture maradt le.
 *
 * Ezért kell ide temp DATA_DIR és dinamikus import: a repository SQLite-ot nyit
 * a modul betöltésekor, tehát a környezetet előbb kell beállítani.
 */
const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let archive: typeof import('@/lib/server/memory/session-archive-memory')
let messages: typeof import('@/lib/server/messages/message-repository')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-session-archive-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  archive = await import('@/lib/server/memory/session-archive-memory')
  messages = await import('@/lib/server/messages/message-repository')
})

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

function sessionFixture(id: string, name: string, persona: string): Session {
  return {
    id,
    name,
    cwd: process.cwd(),
    user: 'Alice',
    provider: 'openai',
    model: 'gpt-4.1',
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    createdAt: Date.parse('2026-03-05T00:00:00.000Z'),
    lastActiveAt: Date.parse('2026-03-05T10:00:00.000Z'),
    sessionType: 'human',
    identityState: { personaLabel: persona },
  } as Session
}

test('buildSessionArchivePayload summarizes session transcript and metadata', () => {
  const session = sessionFixture('session-1', 'Support Thread', 'Debugger')
  messages.appendMessages(session.id, [
    { role: 'user', text: 'Can you help me debug this issue?', time: 1 },
    { role: 'assistant', text: 'Yes, show me the stack trace.', time: 2, toolEvents: [{ name: 'files', input: '{}' }] },
  ] as Message[])

  const payload = archive.buildSessionArchivePayload(session, { name: 'Swarmy' })

  assert.ok(payload)
  assert.equal(payload?.title, 'Session archive: Support Thread')
  assert.match(payload?.content || '', /Transcript excerpt:/)
  assert.match(payload?.content || '', /Swarmy/)
  assert.equal(payload?.metadata.tier, 'archive')
  assert.equal(payload?.references[0]?.type, 'session')
})

test('buildSessionArchiveMarkdown creates a portable markdown snapshot', () => {
  const session = sessionFixture('session-3', 'Architecture Review', 'Reviewer')
  messages.appendMessages(session.id, [
    { role: 'user', text: 'Summarize the new connector policy.', time: 1 },
    { role: 'assistant', text: 'It now uses scoped sessions and freshness resets.', time: 2 },
  ] as Message[])

  const payload = archive.buildSessionArchivePayload(session, { name: 'Swarmy' })
  assert.ok(payload)

  const markdown = archive.buildSessionArchiveMarkdown(session, payload!, { name: 'Swarmy' })
  assert.match(markdown, /^# Session archive: Architecture Review/m)
  assert.match(markdown, /## Archive Snapshot/)
  assert.match(markdown, /## Transcript Excerpt/)
  assert.match(markdown, /\*\*Swarmy\*\*/)
})

test('buildSessionArchivePayload skips trivial sessions', () => {
  const session = sessionFixture('session-2', 'Too Short', 'Nobody')
  messages.appendMessages(session.id, [
    { role: 'user', text: 'hi', time: 1 },
  ] as Message[])

  assert.equal(archive.buildSessionArchivePayload(session), null)
})

test('buildSessionArchivePayload skips a session with no transcript at all', () => {
  // A repository az egyetlen forrás: egy session, amihez nem tartozik üzenet,
  // nem archiválható, akkor sem, ha a session rekord egyébként teljes.
  const session = sessionFixture('session-4', 'Empty', 'Nobody')
  assert.equal(archive.buildSessionArchivePayload(session), null)
})
