# Olvasatlan-jelzés és natív értesítés — implementációs terv

> **Ágens-végrehajtóknak:** KÖTELEZŐ AL-SKILL: `superpowers:subagent-driven-development`
> (ajánlott) vagy `superpowers:executing-plans`. A lépések checkbox (`- [ ]`)
> szintaxissal követhetők.

**Spec:** `doc/specs/2026-09-09-olvasatlan-jelzes-es-ertesites-design.md`

**Cél:** A chat-lista jelezze, ha egy ügynök olyan chatben válaszolt, amit nem
nézel, és az Electron app küldjön erről natív értesítést, ki-be kapcsolhatóan.

**Architektúra:** A meglévő `Session.lastAssistantAt` mellé egy szerver-oldali
`lastReadAt` és egy `lastFailedTurnAt` kerül; az olvasatlanság ezekből
származtatott érték, nem tárolt boolean. A kliens a meglévő `sessions`
WS-topicról értesül, a natív értesítést pedig az Electron fő-folyamat küldi
preload + IPC-n keresztül.

**Tech stack:** Next.js 16, TypeScript, Zustand, TanStack Query, better-sqlite3,
Electron, `tsx --test` (node:test).

## Globális megkötések

- **Soha `any`.** `unknown`, `Record<string, unknown>` vagy rendes interfész.
- **Lint-szabályt nem némítunk.** A kódot javítjuk, nem a lintert.
- **Új teszt = felvenni a `package.json` `test:runtime` listájába.** A suite
  explicit fájllistával fut, nem glob-bal: ami nincs felsorolva, az nem fut le.
- **Store-írás async loaderben `setIfChanged`-dzsel** (`src/stores/set-if-changed.ts`),
  lokális mutáció után `invalidateFingerprint(key)`.
- **Modul-szintű állapot `hmrSingleton`-nal** (`src/lib/shared-utils.ts`), soha
  bare `const x = new Map()`.
- **Egyelemű session-írás `patchSession`-nel**, nem `saveCollection`-nel.
- **Commit-üzenet záró sora ezen a forkon, SZO SZERINT ez, minden feladatnal:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  **Ha te egy delegalt al-ugynok vagy, NE a sajat modellneved ird ide.** A repo
  szempontjabol a segito modell a sessiont vivo modell; hogy belul melyik szintre
  delegaltak egy tasket, az implementacios reszlet, es a ledger rogziti. Negy
  kulonbozo modellnev a history-ban szetszorja a szerzoseget, nem kovethetove teszi.
- **`CLAUDE.md` és `AGENTS.md` szinkronban marad**, ha bármelyikbe szabály kerül.

---

### Task 1: macOS értesítés-próba (kockázatzárás)

Ez az első task, mert a válasza átszabhatja a 9-es taskot. A `SwarmClaw.app`
`Signature=adhoc`; hogy ebből megjelenik-e rendszer-értesítés, azt egyetlen
próba dönti el.

**Files:**
- Create: `scripts/notification-spike.mjs`

**Interfaces:**
- Consumes: semmi.
- Produces: semmi kód. Egy **eldöntött tény**, amit a 9-es task feltételez.

- [ ] **Step 1: Írd meg a próbaszkriptet**

```js
// scripts/notification-spike.mjs
// Eldobható. Azt az egy kérdést dönti el, hogy egy ad-hoc alairt buildbol
// megjelenik-e macOS rendszer-ertesites. Torolheto, amint a valasz megvan.
import { app, Notification } from 'electron'

app.whenReady().then(() => {
  console.log('[spike] Notification.isSupported() =', Notification.isSupported())
  if (!Notification.isSupported()) {
    console.log('[spike] NEM TAMOGATOTT — a 9-es task athuzasa kell')
    app.quit()
    return
  }
  const n = new Notification({ title: 'SwarmClaw', body: 'Ertesites-proba' })
  n.on('show', () => console.log('[spike] show esemeny megjott'))
  n.on('click', () => console.log('[spike] kattintas'))
  n.show()
  setTimeout(() => app.quit(), 15000)
})
```

- [ ] **Step 2: Futtasd a csomagolt build Electronjával**

Run: `npx electron scripts/notification-spike.mjs`

Elvárt: a konzolon `Notification.isSupported() = true` **és** a képernyő jobb
felső sarkában megjelenik egy értesítés.

- [ ] **Step 3: Rögzítsd az eredményt**

Ha az értesítés **megjelent**: írd a spec „Kockázat" szakaszába, hogy a próba
`<dátum>`-kor lefutott és zöld. Mehet a terv változatlanul.

Ha **nem jelent meg**: ÁLLJ MEG, és szólj a felhasználónak. Az aláírás hiánya a
9-es taskot átszabja (aláírt build kell, vagy más értesítési út). Ne kezdd el a
9-est vaktában.

- [ ] **Step 4: Commit**

```bash
git add scripts/notification-spike.mjs doc/specs/2026-09-09-olvasatlan-jelzes-es-ertesites-design.md
git commit -m "$(cat <<'EOF'
chore: notification spike for ad-hoc signed macOS build

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Session-mezők és az olvasatlanság-származtatás

**Files:**
- Modify: `src/types/session.ts:93` (a `lastAssistantAt` mellé)
- Create: `src/lib/chat/session-unread.ts`
- Create: `src/lib/chat/session-unread.test.ts`
- Modify: `src/lib/server/storage-normalization.ts:820` (új `sessions` ág elé)
- Modify: `package.json` (`test:runtime` lista)

**Interfaces:**
- Consumes: `Session` a `@/types`-ból.
- Produces:
  - `Session.lastReadAt?: number | null`
  - `Session.lastFailedTurnAt?: number | null`
  - `sessionUnreadState(session): { unread: boolean; isError: boolean; lastActivityAt: number }`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// src/lib/chat/session-unread.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionUnreadState } from './session-unread'

test('minden ures -> nincs olvasatlan', () => {
  assert.deepEqual(sessionUnreadState({}), { unread: false, isError: false, lastActivityAt: 0 })
})

test('valasz a legutobbi olvasas utan -> olvasatlan', () => {
  const s = sessionUnreadState({ lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('egyenloseg nem olvasatlan', () => {
  assert.equal(sessionUnreadState({ lastAssistantAt: 100, lastReadAt: 100 }).unread, false)
})

test('hibas turn a valasz utan -> olvasatlan, hibakent', () => {
  const s = sessionUnreadState({ lastAssistantAt: 150, lastFailedTurnAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, true)
})

test('hibas turn a valasz elott -> olvasatlan, de nem hibakent', () => {
  const s = sessionUnreadState({ lastAssistantAt: 200, lastFailedTurnAt: 150, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('mar olvasott hibas turn nem olvasatlan', () => {
  assert.equal(sessionUnreadState({ lastFailedTurnAt: 100, lastReadAt: 200 }).unread, false)
})

test('hianyzo lastReadAt nullakent szamit', () => {
  assert.equal(sessionUnreadState({ lastAssistantAt: 1 }).unread, true)
})
```

- [ ] **Step 2: Futtasd, hogy lássad a bukást**

Run: `npx tsx --test src/lib/chat/session-unread.test.ts`
Elvárt: FAIL — `Cannot find module './session-unread'`

- [ ] **Step 3: Írd meg a származtatást**

```ts
// src/lib/chat/session-unread.ts

/**
 * Az olvasatlansag SZARMAZTATOTT ertek, nem tarolt boolean.
 *
 * Harom idobelyeg donti el, es mindharom a szerveren el:
 *   - `lastAssistantAt` -- az utolso ugynok-uzenet. Mar letezett; a
 *     `message-repository` tartja karban.
 *   - `lastFailedTurnAt` -- az utolso hibaval vegzodo turn. Azert kell kulon,
 *     mert egy elhasalt turn gyakran nem hagy maga utan uzenetet, tehat a
 *     `lastAssistantAt` nem mozdulna, es a hiba nemakent tunne el.
 *   - `lastReadAt` -- meddig olvastad.
 *
 * `isError` akkor igaz, ha a hiba az UTOLSO esemeny: egy kesobbi sikeres valasz
 * elmossa a korabbi hibat, mert a beszelgetes azota tovabb ment.
 */
export interface SessionUnreadInput {
  lastAssistantAt?: number | null
  lastFailedTurnAt?: number | null
  lastReadAt?: number | null
}

export interface SessionUnreadState {
  unread: boolean
  isError: boolean
  lastActivityAt: number
}

function at(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function sessionUnreadState(session: SessionUnreadInput): SessionUnreadState {
  const assistant = at(session.lastAssistantAt)
  const failed = at(session.lastFailedTurnAt)
  const read = at(session.lastReadAt)
  const lastActivityAt = Math.max(assistant, failed)
  const unread = lastActivityAt > read
  return { unread, isError: unread && failed >= assistant && failed > 0, lastActivityAt }
}
```

- [ ] **Step 4: Vedd fel a két mezőt a típusra**

`src/types/session.ts`, közvetlenül a `lastAssistantAt?: number | null` sor alá:

```ts
  /** Meddig olvasta a felhasznalo ezt a chatet. Lasd `session-unread.ts`. */
  lastReadAt?: number | null
  /** Az utolso hibaval vegzodott turn ideje. Lasd `session-unread.ts`. */
  lastFailedTurnAt?: number | null
```

- [ ] **Step 5: Normalizáció — új `sessions` ág**

`src/lib/server/storage-normalization.ts`, a `if (table === 'schedules') {` ág
elé:

```ts
  if (table === 'sessions') {
    const session = value as StoredObject
    if (typeof session.lastReadAt !== 'number') session.lastReadAt = null
    if (typeof session.lastFailedTurnAt !== 'number') session.lastFailedTurnAt = null
    return session
  }
```

- [ ] **Step 6: Vedd fel a tesztet a suite-ba**

`package.json`, a `test:runtime` értékének végére, szóközzel elválasztva:

```
src/lib/chat/session-unread.test.ts
```

- [ ] **Step 7: Futtasd**

Run: `npx tsx --test src/lib/chat/session-unread.test.ts`
Elvárt: PASS, 7 teszt.

- [ ] **Step 8: Commit**

```bash
git add src/lib/chat/session-unread.ts src/lib/chat/session-unread.test.ts src/types/session.ts src/lib/server/storage-normalization.ts package.json
git commit -m "$(cat <<'EOF'
feat: derive chat unread state from server-side timestamps

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `POST /api/chats/:id/read` és a CLI-manifeszt

**Files:**
- Create: `src/app/api/chats/[id]/read/route.ts`
- Create: `src/app/api/chats/[id]/read/read-route.test.ts`
- Modify: `src/cli/index.js:670` (a `messages` cmd elé)
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: `patchSession` (`src/lib/server/sessions/session-repository.ts:66`),
  `notify` (`src/lib/server/ws-hub.ts:101`).
- Produces: `POST /api/chats/:id/read` → `200 { ok: true, lastReadAt: number }`
  vagy `404`.

**Miért külön route.** A meglévő `PUT /api/chats/:id` mögött az
`updateChatSession` (`src/lib/server/chats/chat-session-service.ts:220`) mezőnkénti
fehérlista, ami ügynök-újrakötést és route-feloldást is végez. Egy
olvasás-jelölőért, ami minden chatváltáskor fut, ez pazarlás és
mellékhatás-kockázat.

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// src/app/api/chats/[id]/read/read-route.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'

test('a route egy szam lastReadAt-tel ter vissza, es patchSession-t hiv', async () => {
  const patched: Array<{ id: string; lastReadAt: unknown }> = []
  const mod = await import('./read-route-logic')
  const before = Date.now()
  const res = mod.markSessionRead('s1', {
    patch: (id, updater) => {
      const next = updater({ id } as never)
      patched.push({ id, lastReadAt: (next as { lastReadAt?: unknown })?.lastReadAt })
      return next
    },
  })
  assert.equal(res?.ok, true)
  assert.ok(typeof res?.lastReadAt === 'number' && res.lastReadAt >= before)
  assert.equal(patched.length, 1)
  assert.equal(patched[0].lastReadAt, res?.lastReadAt)
})

test('ismeretlen session eseten null', async () => {
  const mod = await import('./read-route-logic')
  assert.equal(mod.markSessionRead('nincs', { patch: () => null }), null)
})
```

- [ ] **Step 2: Futtasd, hogy lássad a bukást**

Run: `npx tsx --test "src/app/api/chats/[id]/read/read-route.test.ts"`
Elvárt: FAIL — `Cannot find module './read-route-logic'`

- [ ] **Step 3: Írd meg a logikát és a route-ot**

```ts
// src/app/api/chats/[id]/read/read-route-logic.ts
import type { Session } from '@/types'

/**
 * A jelolo logika a route-tol kulon, hogy tesztelheto legyen HTTP nelkul.
 * A `patch` seam a `patchSession`; a teszt sajatot ad be.
 */
export interface MarkReadDeps {
  patch: (id: string, updater: (current: Session | null) => Session | null) => Session | null
}

export function markSessionRead(id: string, deps: MarkReadDeps): { ok: true; lastReadAt: number } | null {
  const lastReadAt = Date.now()
  const next = deps.patch(id, (current) => {
    if (!current) return null
    return { ...current, lastReadAt }
  })
  return next ? { ok: true, lastReadAt } : null
}
```

```ts
// src/app/api/chats/[id]/read/route.ts
import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { patchSession } from '@/lib/server/sessions/session-repository'
import { notify } from '@/lib/server/ws-hub'
import { markSessionRead } from './read-route-logic'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = markSessionRead(id, { patch: patchSession })
  if (!result) return notFound()
  notify('sessions')
  return NextResponse.json(result)
}
```

- [ ] **Step 4: Vedd fel a CLI-manifesztbe**

`src/cli/index.js`, a `cmd('messages', 'GET', '/chats/:id/messages', ...)` sor elé:

```js
      cmd('read', 'POST', '/chats/:id/read', 'Mark a chat read up to now'),
```

- [ ] **Step 5: Vedd fel a tesztet a suite-ba**

`package.json`, `test:runtime` végére:

```
'src/app/api/chats/*/read/read-route.test.ts'
```

**A CSILLAG KELL, NEM A SZOGLETES ZAROJEL.** A Node sajat `--test` futtatoja a
`[id]`-t karakterosztaly-globnak olvassa, nem literalis utvonal-szegmensnek, es
a fajlt CSENDBEN kihagyja: a suite zolden fut le, exit 0, a te teszted meg soha
nem futott. A shell-idezojel ez ellen nem ved -- az csak a shell globolasat
allitja meg, a Node belso illeszteset nem. A repo sajat bevalt megoldasa is a
csillag: lasd `'src/app/api/providers/*/route.test.ts'` es
`'src/app/api/extensions/*/assets/route.test.ts'` a `test:runtime`-ban.

Ellenorzes, hogy tenyleg fut: futtasd a teljes suite-ot es keresd meg benne a
teszt NEVET, ne csak azt nezd, hogy zold:

Run: `npm run test:runtime 2>&1 | grep -c "ismeretlen session eseten null"`
Elvárt: `1` vagy tobb. Ha `0`, a fajl nem fut, barmit is mond az exit kod.

- [ ] **Step 6: Futtasd mindkettőt**

Run: `npx tsx --test "src/app/api/chats/[id]/read/read-route.test.ts" && npm run test:cli`
Elvárt: PASS mindkettő. A `test:cli` a route-lefedettséget is nézi — ha az új
route nincs a manifesztben, itt bukik.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/chats/[id]/read" src/cli/index.js package.json
git commit -m "$(cat <<'EOF'
feat: add POST /api/chats/:id/read

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Hibás turn rögzítése

**Files:**
- Create: `src/lib/server/runtime/session-run-manager/failed-turn.ts`
- Create: `src/lib/server/runtime/session-run-manager/failed-turn.test.ts`
- Modify: `src/lib/server/runtime/session-run-manager/drain.ts:137` (a `Run finished` log után)
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: `patchSession`, `Session.lastFailedTurnAt` (Task 2).
- Produces: `recordFailedTurn(sessionId, status, deps): boolean` — `true`, ha írt.

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// src/lib/server/runtime/session-run-manager/failed-turn.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { recordFailedTurn } from './failed-turn'

function deps() {
  const writes: number[] = []
  return {
    writes,
    patch: (_id: string, updater: (c: never) => never) => {
      const next = updater({ id: 'x' } as never) as { lastFailedTurnAt?: number } | null
      if (next && typeof next.lastFailedTurnAt === 'number') writes.push(next.lastFailedTurnAt)
      return next
    },
  }
}

test('failed status ir', () => {
  const d = deps()
  assert.equal(recordFailedTurn('s1', 'failed', { patch: d.patch }), true)
  assert.equal(d.writes.length, 1)
})

test('completed nem ir -- azt a lastAssistantAt jelzi', () => {
  const d = deps()
  assert.equal(recordFailedTurn('s1', 'completed', { patch: d.patch }), false)
  assert.equal(d.writes.length, 0)
})

test('cancelled nem ir -- amit a felhasznalo szakitott felbe, arrol nem szolunk', () => {
  const d = deps()
  assert.equal(recordFailedTurn('s1', 'cancelled', { patch: d.patch }), false)
  assert.equal(d.writes.length, 0)
})

test('ismeretlen session eseten false', () => {
  assert.equal(recordFailedTurn('nincs', 'failed', { patch: () => null }), false)
})
```

- [ ] **Step 2: Futtasd, hogy lássad a bukást**

Run: `npx tsx --test src/lib/server/runtime/session-run-manager/failed-turn.test.ts`
Elvárt: FAIL — `Cannot find module './failed-turn'`

- [ ] **Step 3: Írd meg**

```ts
// src/lib/server/runtime/session-run-manager/failed-turn.ts
import type { Session } from '@/types'

/**
 * Egy hibaval vegzodott turn idejenek rogzitese.
 *
 * MIERT CSAK A `failed`. A `completed` turn a `lastAssistantAt`-on keresztul
 * amugy is jelez, tehat ott irni ketszeres konyveles lenne. A `cancelled`
 * pedig a felhasznalo sajat dontese volt -- arrol ertesitest kuldeni
 * ertelmetlen.
 */
export interface RecordFailedTurnDeps {
  patch: (id: string, updater: (current: Session | null) => Session | null) => Session | null
}

export function recordFailedTurn(
  sessionId: string,
  status: string,
  deps: RecordFailedTurnDeps,
): boolean {
  if (status !== 'failed') return false
  const lastFailedTurnAt = Date.now()
  const next = deps.patch(sessionId, (current) => {
    if (!current) return null
    return { ...current, lastFailedTurnAt }
  })
  return next !== null
}
```

- [ ] **Step 4: Kösd be a drain-be**

`src/lib/server/runtime/session-run-manager/drain.ts` — import a fájl tetejére:

```ts
import { recordFailedTurn } from './failed-turn'
```

és **KET helyre**, mert a `drain.ts`-nek ket kulon hibaaga van:

(a) kozvetlenul a `log.info('session-run', \`Run finished ${next.run.id}\`, {...})`
hivas utan -- ez a puha hiba, amikor a turn lefutott, de `result.error`-t hozott:

```ts
      recordFailedTurn(next.run.sessionId, next.run.status, { patch: patchSession })
```

(b) es a `catch (err: unknown)` agban, kozvetlenul a
`log.error('session-run', \`Run failed ${next.run.id}\`, {...})` hivas utan --
ez a kemeny hiba, amikor az `executeExecutionChatTurn` DOBOTT:

```ts
      recordFailedTurn(next.run.sessionId, next.run.status, { patch: patchSession })
```

**A (b) ag a fontosabb, es majdnem kimaradt.** Egy dobott kivetel valoszinubben
hagy maga utan NULLA assistant-uzenetet, mint egy puha `result.error` -- vagyis
pont az az eset, amiert a `lastFailedTurnAt` mezo egyaltalan letezik. A
`cancelled`-del nem kell kulon foglalkozni: a `recordFailedTurn` maga szuri.

Ha a `patchSession` még nincs importálva ebben a fájlban, vedd fel:

```ts
import { patchSession } from '@/lib/server/sessions/session-repository'
```

- [ ] **Step 5: Vedd fel a tesztet a suite-ba, és futtasd**

`package.json` `test:runtime` végére:
`src/lib/server/runtime/session-run-manager/failed-turn.test.ts`

Run: `npx tsx --test src/lib/server/runtime/session-run-manager/failed-turn.test.ts`
Elvárt: PASS, 4 teszt.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/runtime/session-run-manager/failed-turn.ts src/lib/server/runtime/session-run-manager/failed-turn.test.ts src/lib/server/runtime/session-run-manager/drain.ts package.json
git commit -m "$(cat <<'EOF'
feat: record failed turn timestamp for unread signalling

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `useWindowFocused` hook

**Files:**
- Create: `src/hooks/use-window-focused.ts`
- Create: `src/hooks/use-window-focused.test.ts`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: semmi.
- Produces:
  - `useWindowFocused(): boolean`
  - `focusedSnapshot(): boolean` — a tesztelhető, React-mentes mag.

**Miért nem a `usePageActive`.** Az (`src/hooks/use-page-active.ts`)
*lathatosagot* mer (`visibilitychange` / `visibilityState`): egy Electron-ablak,
ami latszik, de mas app van elotte, `visible`-t mond. A 2. dontes fokuszt ker.

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// src/hooks/use-window-focused.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { focusedSnapshot } from './use-window-focused'

test('document nelkul (SSR) true', () => {
  const g = globalThis as { document?: unknown }
  const saved = g.document
  delete g.document
  try {
    assert.equal(focusedSnapshot(), true)
  } finally {
    if (saved !== undefined) g.document = saved
  }
})

test('document.hasFocus() eredmenyet adja vissza', () => {
  const g = globalThis as { document?: unknown }
  const saved = g.document
  g.document = { hasFocus: () => false }
  try {
    assert.equal(focusedSnapshot(), false)
    g.document = { hasFocus: () => true }
    assert.equal(focusedSnapshot(), true)
  } finally {
    if (saved === undefined) delete g.document
    else g.document = saved
  }
})
```

- [ ] **Step 2: Futtasd, hogy lássad a bukást**

Run: `npx tsx --test src/hooks/use-window-focused.test.ts`
Elvárt: FAIL — `Cannot find module './use-window-focused'`

- [ ] **Step 3: Írd meg**

```ts
// src/hooks/use-window-focused.ts
'use client'

import { useSyncExternalStore } from 'react'

function subscribe(cb: () => void) {
  window.addEventListener('focus', cb)
  window.addEventListener('blur', cb)
  return () => {
    window.removeEventListener('focus', cb)
    window.removeEventListener('blur', cb)
  }
}

/**
 * A fokusz pillanatkepe. Kulon exportalva, mert ez a resz tesztelheto React es
 * DOM-kornyezet nelkul is.
 *
 * SSR-en `true`: a szerveren nincs ablak, es a `false` azt jelentene, hogy
 * minden chat olvasatlanul renderelodik elso festeskor.
 */
export function focusedSnapshot(): boolean {
  if (typeof document === 'undefined') return true
  return document.hasFocus()
}

function getServerSnapshot(): boolean {
  return true
}

/** `true`, amig ez az ablak a fokuszalt. Nem ugyanaz, mint `usePageActive`. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, focusedSnapshot, getServerSnapshot)
}
```

- [ ] **Step 4: Vedd fel a suite-ba, és futtasd**

`package.json` `test:runtime` végére: `src/hooks/use-window-focused.test.ts`

Run: `npx tsx --test src/hooks/use-window-focused.test.ts`
Elvárt: PASS, 2 teszt.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-window-focused.ts src/hooks/use-window-focused.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: add useWindowFocused hook

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Olvasottság a szerverre — store-migráció és türelmi idő

**Files:**
- Create: `src/stores/chat-read-migration.ts`
- Create: `src/stores/chat-read-migration.test.ts`
- Modify: `src/stores/slices/data-slice.ts:136-141`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: `POST /api/chats/:id/read` (Task 3), `invalidateFingerprint`
  (`src/stores/set-if-changed.ts`).
- Produces:
  - `markChatRead(id: string): Promise<void>` — a store-on, immár szerverre írva.
  - `migrateLocalReadTimestamps(deps): Promise<boolean>` — `true`, ha a kulcs törölhető.
  - `READ_GRACE_MS = 3000`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// src/stores/chat-read-migration.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateLocalReadTimestamps } from './chat-read-migration'

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
```

- [ ] **Step 2: Futtasd, hogy lássad a bukást**

Run: `npx tsx --test src/stores/chat-read-migration.test.ts`
Elvárt: FAIL — `Cannot find module './chat-read-migration'`

- [ ] **Step 3: Írd meg a migrációt**

```ts
// src/stores/chat-read-migration.ts

/**
 * A `localStorage` `sc_last_read` kulcsanak egyszeri felkoltoztetese a szerverre.
 *
 * MIERT KELL EGYALTALAN. Az olvasottsag eddig kliens-oldalon elt. Ha csak
 * atallnank a szerver-oldali mezore, minden korabban olvasott chat egyszerre
 * olvasatlanra ugrana -- egy tele lista pirossal, amirol a felhasznalo tudja,
 * hogy hazugsag.
 *
 * HIBANAL NEM TORLUNK. A visszateresi ertek azt mondja meg, torolheto-e a
 * kulcs. Reszleges sikernel `false`: inkabb fusson meg egyszer a kovetkezo
 * betolteskor, mint hogy elvesszen.
 */
export const LOCAL_READ_KEY = 'sc_last_read'

export interface MigrateReadDeps {
  read: () => Record<string, number>
  push: (sessionId: string) => Promise<void>
}

export async function migrateLocalReadTimestamps(deps: MigrateReadDeps): Promise<boolean> {
  const stored = deps.read()
  const ids = Object.keys(stored)
  if (ids.length === 0) return true
  const results = await Promise.allSettled(ids.map((id) => deps.push(id)))
  return results.every((r) => r.status === 'fulfilled')
}
```

- [ ] **Step 4: Állítsd át a store-t — a chatroom-ok érintése NÉLKÜL**

**FIGYELEM, ez a task legkonnyebben elrontott lepese.** A `markChatRead`-et ma
nem csak a chat-lista hivja: a `src/components/chatrooms/chatroom-view.tsx:235,240`
is, chatroom-azonositoval. Ha egyszeruen atirod szerver-hivasra, a chatroom-ok
`POST /chats/<chatroom-id>/read`-et kuldenenek, ami 404-et ad, es a chatroom-ok
olvasottsaga csendben elromlik. A chatroom-ok az 1. dontes szerint kivul esnek
a hatokoron -- **ugyanugy kell mukodniuk, mint ma.**

Ezert a meglevo `localStorage`-os par MEGMARAD, uj neven, es melle jon egy uj
fuggveny a chateknek.

`src/stores/slices/data-slice.ts` — a `lastReadTimestamps` / `markChatRead` pár
(136-141. sor) helyére:

```ts
  // A chatroom-ok olvasottsaga marad kliens-oldalon: rajuk ez a funkcio nem
  // vonatkozik (1. dontes), es a szerveren nincs is hova irni.
  lastReadTimestamps: safeStorageGetJson<Record<string, number>>('sc_last_read', {}),
  markChatroomRead: (id) => {
    const ts = { ...get().lastReadTimestamps, [id]: Date.now() }
    set({ lastReadTimestamps: ts })
    safeStorageSet('sc_last_read', JSON.stringify(ts))
  },
  // A chatek olvasottsaga a szerveren el.
  markChatRead: async (id) => {
    try {
      await api('POST', `/chats/${id}/read`)
      invalidateFingerprint('sessions')
    } catch {
      // Az optimista jeloles visszaall a kovetkezo betoltessel. A legrosszabb,
      // ami tortenhet, hogy egy pont ott marad.
    }
  },
```

A típusdeklarációban (49-50. sor):

```ts
  lastReadTimestamps: Record<string, number>
  markChatroomRead: (id: string) => void
  markChatRead: (id: string) => Promise<void>
```

- [ ] **Step 4b: Nevezd át a chatroom hívási helyeit**

`src/components/chatrooms/chatroom-view.tsx` — a 116., 235. és 240. sorban
`markChatRead` helyett `markChatroomRead`. Egyeb valtozas ott nincs.

Run: `npx tsc --noEmit -p tsconfig.json`
Elvárt: nincs olyan hiba, hogy `markChatRead` hianyzo vagy rossz tipusu. Ha
barhol maradt `markChatRead(` chatroom-azonositoval, a typecheck itt kiderul.

- [ ] **Step 4c: HIVD MEG A MIGRACIOT — enelkul halott kod**

A `migrateLocalReadTimestamps` onmagaban semmit nem csinal. Ha senki nem hivja,
a fuggveny letezik, a tesztje zold, es az elso betolteskor MINDEN korabban
olvasott chat olvasatlanra ugrik -- pontosan az, ami ellen a migracio kesziult.

`src/stores/slices/session-slice.ts:101` a session-betolto:
`loadSessions: createLoader<AppState>(set, 'sessions', () => fetchChats())`.
A migracionak EGYSZER kell lefutnia, a sessionok elso sikeres betoltese utan.
Csomagold be:

```ts
  loadSessions: async () => {
    await createLoader<AppState>(set, 'sessions', () => fetchChats())()
    await runChatReadMigrationOnce()
  },
```

es a `chat-read-migration.ts`-be egy egyszer-futo burkolat, `hmrSingleton`-nal,
hogy a Next HMR ne inditsa ujra:

```ts
import { hmrSingleton } from '@/lib/shared-utils'

const migrationState = hmrSingleton('chatReadMigration_done', () => ({ done: false }))

/**
 * Egyszer fut le a folyamat eleteben. A `done` akkor is bebillen, ha a migracio
 * reszlegesen hasalt el -- a kulcs viszont OLYANKOR MEGMARAD, tehat a kovetkezo
 * INDITAS ujraprobalja. Igy egy betoltesen belul nem porog ujra, de egy elveszett
 * ertek sem ragad benn oroKre.
 */
export async function runChatReadMigrationOnce(): Promise<void> {
  if (migrationState.done) return
  migrationState.done = true
  if (typeof localStorage === 'undefined') return
  const raw = localStorage.getItem(LOCAL_READ_KEY)
  if (!raw) return
  let stored: Record<string, number>
  try {
    stored = JSON.parse(raw) as Record<string, number>
  } catch {
    localStorage.removeItem(LOCAL_READ_KEY)
    return
  }
  const ok = await migrateLocalReadTimestamps({
    read: () => stored,
    push: async (id) => { await api('POST', `/chats/${id}/read`) },
  })
  if (ok) localStorage.removeItem(LOCAL_READ_KEY)
}
```

Teszt hozza (ugyanabban a fajlban), ami a HIVAST koti le, nem csak a tiszta
fuggvenyt: hamis `localStorage`-dzsel fusson le egyszer, a masodik hivas ne
csinaljon semmit, es sikeres migracio utan a kulcs tunjon el, hibas utan
MARADJON MEG.

- [ ] **Step 5: Türelmi idő konstans**

Ugyanebbe a fájlba, a slice fölé:

```ts
/**
 * Ennyit varunk fokuszvesztes utan, mielott olvasatlannak tekintenenk barmit.
 * Enelkul minden ablakvaltas hamis olvasatlant szulne.
 */
export const READ_GRACE_MS = 3000
```

- [ ] **Step 6: Vedd fel a suite-ba, és futtasd**

`package.json` `test:runtime` végére: `src/stores/chat-read-migration.test.ts`

Run: `npx tsx --test src/stores/chat-read-migration.test.ts`
Elvárt: PASS, 3 teszt.

- [ ] **Step 7: Commit**

```bash
git add src/stores/chat-read-migration.ts src/stores/chat-read-migration.test.ts src/stores/slices/data-slice.ts package.json
git commit -m "$(cat <<'EOF'
feat: move chat read state from localStorage to the server

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: A `/chat` lista sorai — olvasatlan, dolgozik, és a fókusz-szabály

> **EZ A FELADAT UJRA LETT IRVA.** Az elso valtozat a `chat-list.tsx` /
> `chat-card.tsx` parost celozta. **Azok HALOTT KODOK**: a `ChatList`-re nulla
> hivatkozas van a fában, a `ChatCard`-ot csak a `chat-list.tsx` importálja.
> A `/chat` oldal valodi listaja a `ConversationList`
> (`src/components/chat/conversation-list.tsx`), es az sajat sorokat renderel,
> nem `ChatCard`-ot. A `d10733d0` commit munkaja ezert a kepernyore soha nem
> jutott volna ki.

**Files:**
- Modify: `src/components/chat/conversation-list.tsx`
- Create: `src/components/chat/conversation-row-state.ts`
- Create: `src/components/chat/conversation-row-state.test.ts`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: `sessionUnreadState` (Task 2), `useWindowFocused` (Task 5),
  `markChatRead` és `READ_GRACE_MS` (Task 6).
- Produces: `conversationRowState(session)` → `{ unread, isError, working }`.

**Amit a `ConversationList` ma tud** (olvasd el, mielott hozzanyulsz):
soronkent avatar + cim + `ugynok neve · ido`, magyar szoveggel; van
`data-testid="conversation-row"` es `data-session-id`; es MAR fel van iratkozva
mindket topicra: `useWs('sessions', loadSessions, 15_000)` es
`useWs('runs', loadSessions, 5_000)`. Uj feliratkozas NEM kell -- a `runs`
5 masodperces tartaleka hajtja a "dolgozik" jelzest.

- [ ] **Step 1: Írd meg a bukó tesztet a sor-állapotra**

```ts
// src/components/chat/conversation-row-state.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationRowState } from './conversation-row-state'

test('semmi sem tortent -> se olvasatlan, se dolgozik', () => {
  assert.deepEqual(conversationRowState({}), { unread: false, isError: false, working: false })
})

test('olvasatlan valasz', () => {
  const s = conversationRowState({ lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('hibas turn -> olvasatlan, hibakent', () => {
  const s = conversationRowState({ lastAssistantAt: 100, lastFailedTurnAt: 200, lastReadAt: 50 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, true)
})

test('active -> dolgozik', () => {
  assert.equal(conversationRowState({ active: true }).working, true)
})

test('a dolgozik fuggetlen az olvasatlantol: egyszerre is igaz lehet', () => {
  const s = conversationRowState({ active: true, lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.working, true)
  assert.equal(s.unread, true)
})

test('active hianyzik vagy false -> nem dolgozik', () => {
  assert.equal(conversationRowState({ active: false }).working, false)
  assert.equal(conversationRowState({}).working, false)
})
```

- [ ] **Step 2: Futtasd, hogy lássad a bukást**

Run: `npx tsx --test src/components/chat/conversation-row-state.test.ts`
Elvárt: FAIL — `Cannot find module './conversation-row-state'`

- [ ] **Step 3: Írd meg**

```ts
// src/components/chat/conversation-row-state.ts
import { sessionUnreadState, type SessionUnreadInput } from '@/lib/chat/session-unread'

/**
 * Amit egy sor magarol tud. Harom fuggetlen teny, nem egy allapotgep:
 * egy chat lehet EGYSZERRE olvasatlan es dolgozo (valaszolt, aztan tovabb
 * ment), ezert nem `status`-t adunk vissza, hanem harom boolt.
 *
 * `working` a `session.active`, amit a futasido tart karban. A lista mar fel
 * van iratkozva a `runs` topicra, tehat ez magatol frissul.
 */
export interface ConversationRowInput extends SessionUnreadInput {
  active?: boolean
}

export interface ConversationRowState {
  unread: boolean
  isError: boolean
  working: boolean
}

export function conversationRowState(session: ConversationRowInput): ConversationRowState {
  const { unread, isError } = sessionUnreadState(session)
  return { unread, isError, working: session.active === true }
}
```

- [ ] **Step 4: Rajzold ki a sorban**

A `conversation-list.tsx` sor-blokkjaban, az `ago(now, s.lastActiveAt)` melle.
Kovesd a fajl megleve magyar szovegeit es Tailwind-osztalyait; ne hozz be uj
design-nyelvet.

- **dolgozik**: zold, pulzalo pont + `dolgozik` felirat.
- **olvasatlan**: tomor pont a sor jobb szelen (`bg-accent-bright`), hibas
  esetben piros (`bg-red-500`) es `title` attributumban a magyarazat.
- Az aktiv (megnyitott) sor is mutathatja mindkettot -- a jelzest az
  olvasottsag tunteti el, nem a kivalasztas.

Minden uj elemre `data-testid` kerul (`row-working`, `row-unread`), hogy egy
kesobbi e2e ne osztalynevekre fogodzon.

- [ ] **Step 5: Fókusz-szabály és türelmi idő**

Ugyanebben a komponensben:

```tsx
  const windowFocused = useWindowFocused()

  // Az aktiv chat akkor lesz olvasott, ha az ablak is fokuszban van.
  useEffect(() => {
    if (!activeId) return
    if (!windowFocused) return
    void markChatRead(activeId)
  }, [activeId, windowFocused, markChatRead])

  // Fokuszvesztes utan `READ_GRACE_MS`-ig meg olvasottnak szamit: enelkul
  // minden ablakvaltas hamis olvasatlant szulne. A lejartakor UJRA megnezzuk a
  // fokuszt -- ha kozben visszatert, jeloljunk; ha nem, ne.
  useEffect(() => {
    if (!activeId) return
    if (windowFocused) return
    const timer = setTimeout(() => {
      if (document.hasFocus()) void markChatRead(activeId)
    }, READ_GRACE_MS)
    return () => clearTimeout(timer)
  }, [activeId, windowFocused, markChatRead])
```

A `clearTimeout` a takaritasban NEM elhagyhato: gyors chat-valtasnal egy
elarvult idozito a ROSSZ chatet jelolne olvasottnak.

- [ ] **Step 6: Vedd fel a suite-ba, és futtasd**

`package.json` `test:runtime` végére: `src/components/chat/conversation-row-state.test.ts`

Run: `npm run test:runtime 2>&1 | grep -c "a dolgozik fuggetlen"`
Elvárt: 1 vagy tobb. Ha 0, a fajl nem fut.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/conversation-list.tsx src/components/chat/conversation-row-state.ts src/components/chat/conversation-row-state.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: show unread and working state in the conversation list

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 8: A két kapcsoló

**Files:**
- Modify: `src/types/app-settings.ts` (az `AppSettings` interfészbe)
- Modify: `src/types/agent.ts` (az `Agent` interfészbe)
- Modify: `src/views/settings/section-user-preferences.tsx`
- Modify: `src/lib/server/storage-normalization.ts` (agents ág)
- Create: `src/lib/chat/notification-gate.ts`
- Create: `src/lib/chat/notification-gate.test.ts`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: `AppSettings`, `Agent`.
- Produces:
  - `AppSettings.agentReplyNotifications?: boolean`
  - `Agent.replyNotificationsMuted?: boolean`
  - `shouldNotifyForReply(input): boolean`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// src/lib/chat/notification-gate.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldNotifyForReply } from './notification-gate'

const base = {
  globalEnabled: true,
  agentMuted: false,
  isActiveSession: false,
  windowFocused: false,
}

test('alapeset: nem aktiv chat, nincs fokusz -> ertesit', () => {
  assert.equal(shouldNotifyForReply(base), true)
})

test('globalisan kikapcsolva -> nem ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, globalEnabled: false }), false)
})

test('ugynok nemitva -> nem ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, agentMuted: true }), false)
})

test('aktiv chat ES fokusz -> nem ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, isActiveSession: true, windowFocused: true }), false)
})

test('aktiv chat, de nincs fokusz -> ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, isActiveSession: true, windowFocused: false }), true)
})

test('nem aktiv chat, de van fokusz -> ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, isActiveSession: false, windowFocused: true }), true)
})
```

- [ ] **Step 2: Futtasd, hogy lássad a bukást**

Run: `npx tsx --test src/lib/chat/notification-gate.test.ts`
Elvárt: FAIL — `Cannot find module './notification-gate'`

- [ ] **Step 3: Írd meg a kaput**

```ts
// src/lib/chat/notification-gate.ts

/**
 * Ertesitendo-e egy beerkezett ugynok-valasz.
 *
 * EGY DONTESBOL SZARMAZIK A JELZES ES A PUSH IS. Amit a lista olvasottnak
 * tekint (aktiv chat + fokusz), arrol nem megy ertesites -- kulonben a ketto
 * ellentmondana egymasnak.
 */
export interface NotificationGateInput {
  globalEnabled: boolean
  agentMuted: boolean
  isActiveSession: boolean
  windowFocused: boolean
}

export function shouldNotifyForReply(input: NotificationGateInput): boolean {
  if (!input.globalEnabled) return false
  if (input.agentMuted) return false
  if (input.isActiveSession && input.windowFocused) return false
  return true
}
```

- [ ] **Step 4: Vedd fel a két mezőt**

`src/types/app-settings.ts`, az `AppSettings` interfészbe:

```ts
  /** Natv ertesites, ha egy ugynok valaszol. A lista-jelzest NEM kapcsolja ki. */
  agentReplyNotifications?: boolean
```

`src/types/agent.ts`, az `Agent` interfészbe:

```ts
  /** Ha igaz, errol az ugynokrol nem megy natv ertesites. A lista-jelzes marad. */
  replyNotificationsMuted?: boolean
```

- [ ] **Step 5: Normalizáció**

`src/lib/server/storage-normalization.ts`, az `if (table === 'agents') {` ágon
belül, a `delegationEnabled` blokk mellé:

```ts
    if (typeof agent.replyNotificationsMuted !== 'boolean') {
      agent.replyNotificationsMuted = false
    }
```

- [ ] **Step 6: A globális kapcsoló a beállítások oldalon**

`src/views/settings/section-user-preferences.tsx` — a meglévő mezők közé, a
`section-runtime-loop.tsx:319-327` mintáját követve:

```tsx
            <label className="flex items-center gap-2 text-[12px] text-text-2">
              <input
                type="checkbox"
                checked={appSettings.agentReplyNotifications ?? true}
                onChange={(e) => patchSettings({ agentReplyNotifications: e.target.checked })}
                className="h-4 w-4 rounded-xs border-line-strong accent-accent"
              />
              Ertesites, ha egy ugynok valaszol
              <HintTip text="Natv rendszer-ertesites, ha egy ugynok olyan chatben valaszol, amit epp nem nezel. A lista olvasatlan-jelzeset ez nem kapcsolja ki." />
            </label>
```

Az importot vedd fel a fájl tetejére, ha még nincs:

```ts
import { HintTip } from '@/components/shared/hint-tip'
```

- [ ] **Step 7: A per-ügynök némítás**

Az ügynök-lapon, az `AdvancedSettingsSection`
(`src/components/shared/advanced-settings-section.tsx`) belsejébe. A mentés a lap
meglévő ügynök-patch útján megy — ne vezess be újat; a `patchAgent` a lapon már
használt függvény neve, ha ott máshogy hívják, azt használd.

```tsx
            <label className="flex items-center gap-2 text-[12px] text-text-2">
              <input
                type="checkbox"
                checked={agent.replyNotificationsMuted ?? false}
                onChange={(e) => patchAgent({ replyNotificationsMuted: e.target.checked })}
                className="h-4 w-4 rounded-xs border-line-strong accent-accent"
              />
              Ne kuldjon ertesitest errol az ugynokrol
              <HintTip text="A lista olvasatlan-jelzese megmarad, csak a natv rendszer-ertesites nem megy ki errol az ugynokrol." />
            </label>
```

- [ ] **Step 8: Vedd fel a suite-ba, és futtasd**

`package.json` `test:runtime` végére: `src/lib/chat/notification-gate.test.ts`

Run: `npx tsx --test src/lib/chat/notification-gate.test.ts && npx tsc --noEmit -p tsconfig.json`
Elvárt: PASS, 6 teszt, típushiba nélkül.

- [ ] **Step 9: Commit**

```bash
git add src/lib/chat/notification-gate.ts src/lib/chat/notification-gate.test.ts src/types/app-settings.ts src/types/agent.ts src/views/settings/section-user-preferences.tsx src/lib/server/storage-normalization.ts package.json
git commit -m "$(cat <<'EOF'
feat: add global and per-agent reply notification switches

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Electron preload, értesítés és kattintás

**Előfeltétel:** a Task 1 zöld. Ha nem az, ÁLLJ MEG.

**Files:**
- Create: `electron/preload.ts`
- Create: `electron/notification-payload.ts` (Electron-mentes, ezert teszteheto)
- Create: `electron/notification-payload.test.ts`
- Create: `electron/notifications.ts` (ez mar importal `electron`-t)
- Modify: `electron/main.ts:136-138` (`webPreferences`)
- Modify: `src/components/layout/live-query-sync.tsx` (vagy testvér komponens)
- Create: `src/components/layout/reply-notifier.tsx`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Consumes: `shouldNotifyForReply` (Task 8), `sessionUnreadState` (Task 2),
  `useWindowFocused` (Task 5).
- Produces:
  - `window.swarmclaw?.notify({ sessionId, title, body, isError })`
  - `window.swarmclaw?.onOpenChat(cb: (sessionId: string) => void)`
  - `buildNotificationPayload(session, agentName): { title, body, isError }`

- [ ] **Step 1: Írd meg a bukó tesztet a payload-építőre**

```ts
// electron/notification-payload.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNotificationPayload } from './notification-payload'

test('sikeres valasz: az ugynok neve a cim, a chat neve a torzs', () => {
  const p = buildNotificationPayload({ name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5 }, 'Marveen')
  assert.equal(p.title, 'Marveen')
  assert.equal(p.body, 'Valaszolt: Kutatas')
  assert.equal(p.isError, false)
})

test('hibas turn eseten mas torzs', () => {
  const p = buildNotificationPayload({ name: 'Kutatas', lastFailedTurnAt: 9, lastAssistantAt: 5 }, 'Marveen')
  assert.equal(p.isError, true)
  assert.equal(p.body, 'A futas hibaval vegzodott: Kutatas')
})

test('nevtelen ugynok eseten sem ures a cim', () => {
  const p = buildNotificationPayload({ name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5 }, '')
  assert.equal(p.title, 'SwarmClaw')
})
```

- [ ] **Step 2: Futtasd, hogy lássad a bukást**

Run: `npx tsx --test electron/notifications.test.ts`
Elvárt: FAIL — `Cannot find module './notifications'`

- [ ] **Step 3: Írd meg a fő-folyamat modult**

A tiszta reszt kulon fajlba, `electron` import NELKUL. Ez a projekt sajat
bevalt mintaja: az `electron/external-navigation.ts` fejlecze szo szerint ezt
mondja -- "Kept apart from `main.ts` so it can be tested without an Electron
runtime: ... nothing here imports `electron`". Ha a `buildNotificationPayload`
egy `electron`-t importalo fajlban lakna, a `tsx --test` nem tudna betolteni:
az `electron` csomag Electron-futtatas nelkul egy utvonal-sztringet exportal,
nem az API-t, es a nevesitett importok feloldasa elszall.

```ts
// electron/notification-payload.ts

export interface NotifiableSession {
  name: string
  lastAssistantAt?: number | null
  lastFailedTurnAt?: number | null
}

export interface NotificationPayload {
  title: string
  body: string
  isError: boolean
}

/**
 * A szoveg kulon fuggveny, hogy tesztelheto legyen Electron-futtatas nelkul.
 * Semmi felhasznaloi szoveget nem ertelmezunk ujra: a chat neve ugy megy at,
 * ahogy van.
 */
export function buildNotificationPayload(session: NotifiableSession, agentName: string): NotificationPayload {
  const failed = typeof session.lastFailedTurnAt === 'number' ? session.lastFailedTurnAt : 0
  const assistant = typeof session.lastAssistantAt === 'number' ? session.lastAssistantAt : 0
  const isError = failed > 0 && failed >= assistant
  return {
    title: agentName.trim() || 'SwarmClaw',
    body: isError ? `A futas hibaval vegzodott: ${session.name}` : `Valaszolt: ${session.name}`,
    isError,
  }
}

```

Es a mellette allo, `electron`-t importalo fel:

```ts
// electron/notifications.ts
import { app, BrowserWindow, Notification } from 'electron'
import type { NotificationPayload } from './notification-payload'

/**
 * A kattintas a fo-folyamatban lakik, mert `win.show()` / `win.focus()` a
 * rendererbol nem megbizhato.
 */
export function showReplyNotification(
  win: BrowserWindow | null,
  sessionId: string,
  payload: NotificationPayload,
): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: payload.title, body: payload.body })
  notification.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('swarmclaw:open-chat', sessionId)
  })
  notification.show()
}

/** A dock-ikon szamlaloja. macOS-en kivul csendben nem csinal semmit. */
export function setUnreadBadge(count: number): void {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setBadge(count > 0 ? String(count) : '')
}
```

- [ ] **Step 4: Írd meg a preloadot**

```ts
// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron'

/**
 * Egyetlen szuk felulet. `contextIsolation` bekapcsolva marad, a renderer
 * semmilyen Node-API-hoz nem fer hozza ezen kivul.
 */
contextBridge.exposeInMainWorld('swarmclaw', {
  notify: (payload: { sessionId: string; title: string; body: string; isError: boolean }) => {
    ipcRenderer.send('swarmclaw:notify', payload)
  },
  onOpenChat: (cb: (sessionId: string) => void) => {
    const handler = (_e: unknown, sessionId: string) => cb(sessionId)
    ipcRenderer.on('swarmclaw:open-chat', handler)
    return () => { ipcRenderer.off('swarmclaw:open-chat', handler) }
  },
})
```

- [ ] **Step 5: Kösd be a `main.ts`-be**

A `webPreferences` blokkba (136-138. sor), a meglévő két sor **mellé** —
azokat ne írd át:

```ts
      preload: path.join(__dirname, 'preload.js'),
```

És a fő-folyamatban, az ablak létrehozása után:

```ts
import { ipcMain } from 'electron'
import { showReplyNotification } from './notifications'

ipcMain.on('swarmclaw:notify', (_e, payload: { sessionId: string; title: string; body: string; isError: boolean }) => {
  showReplyNotification(mainWindow, payload.sessionId, payload)
})
```

- [ ] **Step 6: A renderer-oldali kiváltó**

```tsx
// src/components/layout/reply-notifier.tsx
'use client'

import { useEffect, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { sessionUnreadState } from '@/lib/chat/session-unread'
import { shouldNotifyForReply } from '@/lib/chat/notification-gate'
import { useWindowFocused } from '@/hooks/use-window-focused'
import { toast } from 'sonner'

interface Bridge {
  notify: (p: { sessionId: string; title: string; body: string; isError: boolean }) => void
  onOpenChat: (cb: (sessionId: string) => void) => () => void
}

function bridge(): Bridge | null {
  const w = window as unknown as { swarmclaw?: Bridge }
  return w.swarmclaw ?? null
}

/**
 * A DONTES itt van, a KIKULDES a fo-folyamatban. Csak itt ismert a fokusz es az
 * aktiv chat; csak ott megbizhato az ertesites egy hatterbe tett ablaknal.
 *
 * A `seen` az elso betoltes alapvonala: nelkule minden mar meglevo olvasatlan
 * chat ertesitest szulne induláskor.
 */
export function ReplyNotifier() {
  const sessions = useAppStore((s) => s.sessions)
  const agents = useAppStore((s) => s.agents)
  const appSettings = useAppStore((s) => s.appSettings)
  const activeSessionId = useAppStore(selectActiveSessionId)
  const setActiveSessionIdOverride = useAppStore((s) => s.setActiveSessionIdOverride)
  const windowFocused = useWindowFocused()
  const seen = useRef<Map<string, number> | null>(null)

  useEffect(() => {
    const b = bridge()
    if (!b) return
    return b.onOpenChat((sessionId) => {
      // A chat torolheto azota, hogy az ertesites kiment. Az ablak ilyenkor is
      // eljon (azt a fo-folyamat intezi) -- itt csak megmondjuk, miert nem nyilt
      // meg semmi, ahelyett hogy egy ures nezetben hagynank a felhasznalot.
      if (!useAppStore.getState().sessions?.[sessionId]) {
        toast.error('Ez a beszelgetes mar nem letezik.')
        return
      }
      setActiveSessionIdOverride(sessionId)
    })
  }, [setActiveSessionIdOverride])

  useEffect(() => {
    const b = bridge()
    if (!b) return
    const list = Object.values(sessions ?? {})

    // AZ ALAPVONALAT CSAK NEM URES LISTABOL SZABAD FELVENNI.
    //
    // A `sessions` `{}`-kent indul, es csak kesobb, aszinkron tolt be. Ha az
    // alapvonalat mar az elso, URES renderen felvennenk, a `seen` egy URES Map
    // lenne -- nem `null` --, es amikor a valodi lista megerkezik, MINDEN
    // olvasatlan chat ujdonsagnak latszana. Az eredmeny egy ertesites-zapor
    // minden hideg inditasnal: pontosan az, ami ellen ez az agalom keszult.
    //
    // Ezert a `length > 0` feltetel: amig nincs mit alapvonalba venni, a `seen`
    // marad `null`, es a ciklus sem fut le.
    if (seen.current === null) {
      if (list.length === 0) return
      seen.current = new Map(list.map((s) => [s.id, sessionUnreadState(s).lastActivityAt]))
      return
    }

    for (const session of list) {
      const state = sessionUnreadState(session)
      const previous = seen.current.get(session.id) ?? 0
      seen.current.set(session.id, state.lastActivityAt)
      if (state.lastActivityAt <= previous) continue
      if (!state.unread) continue

      const agent = session.agentId ? agents?.[session.agentId] : null
      const allowed = shouldNotifyForReply({
        globalEnabled: appSettings?.agentReplyNotifications ?? true,
        agentMuted: agent?.replyNotificationsMuted ?? false,
        isActiveSession: session.id === activeSessionId,
        windowFocused,
      })
      if (!allowed) continue

      b.notify({
        sessionId: session.id,
        title: (agent?.name || '').trim() || 'SwarmClaw',
        body: state.isError ? `A futas hibaval vegzodott: ${session.name}` : `Valaszolt: ${session.name}`,
        isError: state.isError,
      })
    }
  }, [sessions, agents, appSettings, activeSessionId, windowFocused])

  return null
}
```

Rendereld a `LiveQuerySync` mellé, ugyanabban a layout-ban, ahol az ma szerepel.

- [ ] **Step 7: Vedd fel a suite-ba, és futtasd**

`package.json` `test:runtime` végére: `electron/notification-payload.test.ts`

Run: `npx tsx --test electron/notification-payload.test.ts && npx tsc --noEmit -p tsconfig.json`
Elvárt: PASS, 3 teszt, típushiba nélkül.

- [ ] **Step 8: Commit**

```bash
git add electron/preload.ts electron/notification-payload.ts electron/notification-payload.test.ts electron/notifications.ts electron/main.ts src/components/layout/reply-notifier.tsx src/components/layout/live-query-sync.tsx package.json
git commit -m "$(cat <<'EOF'
feat: native desktop notification when an agent replies elsewhere

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Élő ellenőrzés és kiadási kapuk

A CLAUDE.md szerint a munka nincs kész, amíg élő ügynökkel nem futott le.

**Files:** nincs új fájl. Ez ellenőrzés.

- [ ] **Step 1: Teljes teszt- és lint-kapu**

Run: `npm run lint:baseline && npm run test:runtime && npm run test:cli`
Elvárt: mindhárom zöld. Ha a `lint:baseline` új ujjlenyomatot talál, javítsd a
kódot — **ne** a szabályt.

- [ ] **Step 2: Produkciós build**

Run: `NODE_ENV=production npm run build:ci`
Elvárt: sikeres build.

- [ ] **Step 3: Desktop build**

Run: `npm run electron:build`
Elvárt: sikeres csomagolás.

- [ ] **Step 4: Élő forgatókönyv — előtérben**

Indítsd a csomagolt appot. Nyiss két chatet. A nem-aktívban futtass egy valódi
ügynök-választ.
Elvárt: a nem-aktív chat sora olvasatlan-jelzést kap, **és** kijön egy natív
értesítés. Rákattintva az adott chat nyílik meg.

- [ ] **Step 5: Élő forgatókönyv — háttérben**

Tedd az appot háttérbe (másik alkalmazás elé). Futtass egy ügynök-választ.
Elvárt: az értesítés megjelenik. **Ez a tulajdonképpeni funkció** — ha itt
elmarad, a Task 9 nem kész, függetlenül attól, hogy a 4. lépés zöld volt.

- [ ] **Step 6: Élő forgatókönyv — kapcsolók**

Kapcsold ki a globálisat → nincs értesítés, de a lista-jelzés megvan. Kapcsold
vissza, némítsd az ügynököt → ugyanez, csak arra az ügynökre.

- [ ] **Step 7: Élő forgatókönyv — hibás turn**

Provokálj egy hibával végződő futást (például hibás modellel).
Elvárt: piros `!` a soron, és az értesítés törzse a hibás változat.

- [ ] **Step 8: Migráció ellenőrzése**

Az első indítás után a böngésző devtoolsban: a `sc_last_read` kulcs eltűnt, és a
korábban olvasott chatek **nem** ugrottak olvasatlanra.

- [ ] **Step 9: Töröld a próbaszkriptet**

```bash
git rm scripts/notification-spike.mjs
git commit -m "$(cat <<'EOF'
chore: drop notification spike

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
