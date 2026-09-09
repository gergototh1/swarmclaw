import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, Session } from '../../types'
import type { AppState } from '../use-app-store'
import { useAppStore } from '../use-app-store'
import { selectActiveSessionId } from './session-slice'
import { LOCAL_READ_KEY } from '../chat-read-migration'

function makeState(overrides: Partial<AppState>): AppState {
  return {
    currentAgentId: null,
    agents: {},
    sessions: {},
    activeSessionIdOverride: null,
    ...overrides,
  } as AppState
}

function makeAgent(id: string, threadSessionId: string): Agent {
  return { id, threadSessionId } as unknown as Agent
}

function makeSession(id: string): Session {
  return { id } as unknown as Session
}

test('selectActiveSessionId prefers override when present', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: { 'thread-1': makeSession('thread-1'), 'task-1': makeSession('task-1') },
    activeSessionIdOverride: 'task-1',
  })
  assert.equal(selectActiveSessionId(state), 'task-1')
})

test('selectActiveSessionId chooses most recently active session for current agent', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: {
      'thread-1': { ...makeSession('thread-1'), agentId: 'agent-1', lastActiveAt: 100 } as unknown as Session,
      'old-1': { ...makeSession('old-1'), agentId: 'agent-1', lastActiveAt: 90 } as unknown as Session,
      'latest-1': { ...makeSession('latest-1'), agentId: 'agent-1', lastActiveAt: 200, messageCount: 1 } as unknown as Session,
      'other-agent': { ...makeSession('other-agent'), agentId: 'agent-2', lastActiveAt: 999 } as unknown as Session,
    },
  })
  assert.equal(selectActiveSessionId(state), 'latest-1')
})

test('selectActiveSessionId prefers most recent session with content over newer empty thread session', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: {
      'thread-1': { ...makeSession('thread-1'), agentId: 'agent-1', lastActiveAt: 300 } as unknown as Session,
      'work-1': { ...makeSession('work-1'), agentId: 'agent-1', lastActiveAt: 200, messageCount: 2 } as unknown as Session,
    },
  })
  assert.equal(selectActiveSessionId(state), 'work-1')
})

test('selectActiveSessionId falls back to thread session when agent has no loaded sessions', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: { 'unrelated': { ...makeSession('unrelated'), agentId: 'agent-2' } as unknown as Session },
  })
  assert.equal(selectActiveSessionId(state), 'thread-1')
})

test('selectActiveSessionId falls back to thread session when all loaded sessions are empty', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: {
      'thread-1': { ...makeSession('thread-1'), agentId: 'agent-1', lastActiveAt: 120 } as unknown as Session,
      'empty-newer': { ...makeSession('empty-newer'), agentId: 'agent-1', lastActiveAt: 220 } as unknown as Session,
    },
  })
  assert.equal(selectActiveSessionId(state), 'thread-1')
})

test('selectActiveSessionId ignores stale override ids', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: { 'thread-1': makeSession('thread-1') },
    activeSessionIdOverride: 'missing-session',
  })
  assert.equal(selectActiveSessionId(state), 'thread-1')
})

/**
 * R8: korabban letezett a migracios fuggveny, le is volt tesztelve, es
 * MEGSEM hivta senki -- holt kod egy zold teszttel. A hivas visszakerult a
 * `loadSessions`-be, de semmi nem venne eszre, ha megint kikerulne. Ez a
 * teszt a `loadSessions` KULSO, megfigyelheto hatasan keresztul bizonyitja a
 * bekotest: valodi `useAppStore`-t hasznal, es a `sc_last_read` kulcsot
 * fake `localStorage`-on, a POST /chats/:id/read hivast fake `fetch`-en at
 * figyeli. Ha a `await runChatReadMigrationOnce()` sor kikerulne a
 * `loadSessions`-bol, a `readCalls` ures maradna es a kulcs nem torlodne.
 */
function makeFakeLocalStorageForSessionSlice(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
  }
}

function resetMigrationDoneFlagForSessionSlice(): void {
  const state = (globalThis as Record<string, unknown>).chatReadMigration_done as { done: boolean } | undefined
  if (state) state.done = false
}

test('loadSessions meghivja a chat-read migraciot, es felkuldi a lokalis olvasottsagi kulcsokat', async () => {
  const savedLocalStorage = (globalThis as { localStorage?: unknown }).localStorage
  const savedFetch = globalThis.fetch
  const savedSessions = useAppStore.getState().sessions
  resetMigrationDoneFlagForSessionSlice()

  const fake = makeFakeLocalStorageForSessionSlice({ [LOCAL_READ_KEY]: JSON.stringify({ 'session-a': 123 }) })
  ;(globalThis as { localStorage?: unknown }).localStorage = fake

  const readCalls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url === '/api/chats') {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const readMatch = url.match(/^\/api\/chats\/([^/]+)\/read$/)
    if (readMatch) {
      readCalls.push(readMatch[1])
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }) as typeof fetch

  try {
    await useAppStore.getState().loadSessions()
    assert.deepEqual(readCalls, ['session-a'], 'a loadSessions elviszi a tarolt kulcsot a szerverre')
    assert.equal(fake.getItem(LOCAL_READ_KEY), null, 'sikeres migracio utan a lokalis kulcs torlodik')
  } finally {
    if (savedLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else (globalThis as { localStorage?: unknown }).localStorage = savedLocalStorage
    globalThis.fetch = savedFetch
    useAppStore.setState({ sessions: savedSessions })
    resetMigrationDoneFlagForSessionSlice()
  }
})
