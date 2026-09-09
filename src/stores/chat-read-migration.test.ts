import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateLocalReadTimestamps, runChatReadMigrationOnce, LOCAL_READ_KEY } from './chat-read-migration'

interface FakeLocalStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function makeFakeLocalStorage(initial: Record<string, string> = {}): FakeLocalStorage {
  const store: Record<string, string> = { ...initial }
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = value },
    removeItem: (key) => { delete store[key] },
  }
}

function makeFetchMock(shouldFail: (url: string) => boolean) {
  return async (input: unknown) => {
    const url = String(input)
    if (shouldFail(url)) throw new Error('network fail')
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
      text: async () => '',
    } as unknown as Response
  }
}

/**
 * `runChatReadMigrationOnce` bebillenti a `done` flag-et egy modul-szintu
 * `hmrSingleton`-ban, ami a tesztek kozott is megmarad -- ezert kell
 * kezzel visszaallitani a kovetkezo teszt elott, hogy az fusson.
 */
function resetMigrationDoneFlag(): void {
  const state = (globalThis as Record<string, unknown>).chatReadMigration_done as { done: boolean } | undefined
  if (state) state.done = false
}

test('ures tarolo eseten nincs hivas, es torolheto', async () => {
  const calls: string[] = []
  const ok = await migrateLocalReadTimestamps({
    read: () => ({}),
    push: async (id) => { calls.push(id) },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, [])
})

test('minden kulcsot felkuld, es utana torolheto', async () => {
  const calls: string[] = []
  const ok = await migrateLocalReadTimestamps({
    read: () => ({ a: 1, b: 2 }),
    push: async (id) => { calls.push(id) },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls.sort(), ['a', 'b'])
})

test('ha barmelyik felkuldes elhasal, NEM torolheto -- inkabb fusson ketszer', async () => {
  const ok = await migrateLocalReadTimestamps({
    read: () => ({ a: 1, b: 2 }),
    push: async (id) => { if (id === 'b') throw new Error('halt') },
  })
  assert.equal(ok, false)
})

test('runChatReadMigrationOnce: egyszer fut le -- a masodik hivas semmit nem csinal', async () => {
  const savedLocalStorage = (globalThis as { localStorage?: unknown }).localStorage
  const savedFetch = globalThis.fetch
  resetMigrationDoneFlag()

  let fetchCalls = 0
  const fake = makeFakeLocalStorage({ [LOCAL_READ_KEY]: JSON.stringify({ a: 1 }) })
  ;(globalThis as { localStorage?: unknown }).localStorage = fake
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls += 1
    return makeFetchMock(() => false)(input)
  }) as typeof fetch

  try {
    await runChatReadMigrationOnce()
    assert.equal(fetchCalls, 1)
    await runChatReadMigrationOnce()
    assert.equal(fetchCalls, 1, 'a masodik hivas nem kuldott ujabb kerest')
  } finally {
    if (savedLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else (globalThis as { localStorage?: unknown }).localStorage = savedLocalStorage
    globalThis.fetch = savedFetch
    resetMigrationDoneFlag()
  }
})

test('runChatReadMigrationOnce: sikeres migracio utan a kulcs eltunik', async () => {
  const savedLocalStorage = (globalThis as { localStorage?: unknown }).localStorage
  const savedFetch = globalThis.fetch
  resetMigrationDoneFlag()

  const fake = makeFakeLocalStorage({ [LOCAL_READ_KEY]: JSON.stringify({ a: 1, b: 2 }) })
  ;(globalThis as { localStorage?: unknown }).localStorage = fake
  globalThis.fetch = makeFetchMock(() => false) as typeof fetch

  try {
    await runChatReadMigrationOnce()
    assert.equal(fake.getItem(LOCAL_READ_KEY), null)
  } finally {
    if (savedLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else (globalThis as { localStorage?: unknown }).localStorage = savedLocalStorage
    globalThis.fetch = savedFetch
    resetMigrationDoneFlag()
  }
})

test('runChatReadMigrationOnce: reszleges hiba eseten a kulcs megmarad', async () => {
  const savedLocalStorage = (globalThis as { localStorage?: unknown }).localStorage
  const savedFetch = globalThis.fetch
  resetMigrationDoneFlag()

  const fake = makeFakeLocalStorage({ [LOCAL_READ_KEY]: JSON.stringify({ a: 1, b: 2 }) })
  ;(globalThis as { localStorage?: unknown }).localStorage = fake
  globalThis.fetch = makeFetchMock((url) => url.includes('/b/read')) as typeof fetch

  try {
    await runChatReadMigrationOnce()
    assert.equal(fake.getItem(LOCAL_READ_KEY), JSON.stringify({ a: 1, b: 2 }), 'a kulcs megmaradt, hogy a kovetkezo inditas ujraprobalja')
  } finally {
    if (savedLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else (globalThis as { localStorage?: unknown }).localStorage = savedLocalStorage
    globalThis.fetch = savedFetch
    resetMigrationDoneFlag()
  }
})

test('runChatReadMigrationOnce: ervenytelen JSON torli a kulcsot, es nem push-ol semmit', async () => {
  const savedLocalStorage = (globalThis as { localStorage?: unknown }).localStorage
  const savedFetch = globalThis.fetch
  resetMigrationDoneFlag()

  let fetchCalls = 0
  const fake = makeFakeLocalStorage({ [LOCAL_READ_KEY]: 'nem-json{{{' })
  ;(globalThis as { localStorage?: unknown }).localStorage = fake
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls += 1
    return makeFetchMock(() => false)(input)
  }) as typeof fetch

  try {
    await runChatReadMigrationOnce()
    assert.equal(fake.getItem(LOCAL_READ_KEY), null)
    assert.equal(fetchCalls, 0)
  } finally {
    if (savedLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else (globalThis as { localStorage?: unknown }).localStorage = savedLocalStorage
    globalThis.fetch = savedFetch
    resetMigrationDoneFlag()
  }
})
