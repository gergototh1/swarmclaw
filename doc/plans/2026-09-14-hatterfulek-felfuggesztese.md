# Suspending background tab frames — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tab the reader is not looking at stops doing work: no animations, no polling, no refetch on every push event, and — if it stays in the background — no WebSocket of its own. Switching back to it brings it up to date at once.

**Architecture:** Each tab is a same-origin iframe running the whole app, and its `document.visibilityState` is `visible` as long as the window is, so nothing today tells a hidden frame that it is hidden. The host already talks to frames over a zod-validated `postMessage` protocol; this adds one message (`active`) to it. The frame stores that flag in a tiny module (`frame-active.ts`) that `usePageActive` folds into its answer, so every existing consumer — `useWs`, and through it every topic subscription and fallback poll — follows automatically. CSS animations stop through a data attribute on `<html>`. A frame that stays inactive past a grace period closes its socket and reconnects when it is activated again.

**Tech Stack:** Next 16 App Router, React 19, zustand, zod, `node:test` + `tsx`.

**Measured starting point (desktop app, 20 s averages during a run):** GPU 30%, renderer 16%, WindowServer 41%, with the same chat open in two tabs. Idle ~1%. A reviewer traced the duplication: every frame runs `useAppBootstrap` → its own `connectWs()`, its own `useWs('sessions', …)`, its own `LiveQuerySync` with 11 topics, so one `notify('sessions')` costs N full `GET /sessions` round trips and N `JSON.stringify` fingerprints.

## Decisions this plan makes

1. **The frame is told, not asked.** The host knows which tab is active; a frame cannot tell. One `active` message, sent on every activation change and once when a frame reports `ready`.
2. **`usePageActive` is the single seam.** It already gates `useWs`'s polling; extending it means the whole data layer follows without touching each caller. What it does not yet gate — a push event arriving on a hidden frame — is fixed in the same task.
3. **A reactivated frame refreshes once**, not per missed event: one coalesced run per topic.
4. **The socket closes only after a grace period** (30 s inactive), so flicking between two tabs does not churn connections.
5. **No relay.** The host does not proxy data to frames; a background frame simply does less, and catches up when it comes back. A shared single socket is a bigger change and stays out of this plan.
6. **The active frame is unaffected.** Everything here is a no-op in a plain window and in the host itself (`isFrameActive()` returns true when nothing ever set it).

## Global Constraints

- No `any`. Never disable or suppress a lint rule. `npm run lint:baseline` must pass.
- Module-level mutable state uses `hmrSingleton` from `@/lib/shared-utils`.
- The security invariant of the tab protocol stays: the frame acts on a host message only when `event.origin === location.origin` and `event.source === window.parent`; the host acts only on messages from an iframe it created for that tab id.
- Nothing may change for the active tab, for a plain window, or for the host window.
- Do not start, stop or restart any server. Do not run the whole `npm run test:runtime`; run the files each task names with `npx tsx --test <files>`, plus `npx tsc --noEmit -p .` and `npx eslint <changed files>`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## File structure

| File | Responsibility |
|---|---|
| `src/lib/app/frame-active.ts` (new) | Whether this frame is the active tab: get, set, subscribe. |
| `src/hooks/use-page-active.ts` | Fold the frame flag into the existing visibility answer. |
| `src/lib/app/tab-protocol.ts` | The `active` host→frame message. |
| `src/components/layout/tab-host.tsx` | Send it on activation change and on `ready`. |
| `src/components/layout/tab-frame-bridge.tsx` | Apply it: store the flag, set the `<html>` attribute. |
| `src/app/globals.css` | Pause animations in an inactive frame. |
| `src/hooks/use-ws.ts` | Skip push handlers while inactive; one coalesced refresh on reactivation. |
| `src/lib/ws-client.ts` | (Task 4) idle-disconnect helper used by the bridge. |
| `src/components/home/tier-live.tsx` | Gate the two raw `setInterval`s on `usePageActive`. |

---

### Task 1: The frame-active flag, folded into `usePageActive`

**Files:**
- Create: `src/lib/app/frame-active.ts`, `src/lib/app/frame-active.test.ts`
- Modify: `src/hooks/use-page-active.ts`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Produces: `isFrameActive(): boolean` (true until something says otherwise), `setFrameActive(active: boolean): void`, `subscribeFrameActive(listener: () => void): () => void`.
- `usePageActive()` returns `document.visibilityState === 'visible' && isFrameActive()`, and re-renders on either change.

- [ ] **Step 1: Write the failing test**

Create `src/lib/app/frame-active.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isFrameActive, setFrameActive, subscribeFrameActive } from './frame-active'

describe('frame-active', () => {
  it('is active until something says otherwise', () => {
    assert.equal(isFrameActive(), true)
  })

  it('notifies subscribers only when the value actually changes', () => {
    let calls = 0
    const off = subscribeFrameActive(() => { calls++ })
    setFrameActive(false)
    setFrameActive(false)
    assert.equal(isFrameActive(), false)
    assert.equal(calls, 1)
    setFrameActive(true)
    assert.equal(calls, 2)
    off()
    setFrameActive(false)
    assert.equal(calls, 2, 'an unsubscribed listener is not called')
    setFrameActive(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/lib/app/frame-active.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/app/frame-active.ts`**

```ts
import { hmrSingleton } from '@/lib/shared-utils'

/**
 * Whether this window is the tab the reader is looking at.
 *
 * A tab is a same-origin iframe inside a visible window, so its own
 * `document.visibilityState` is always `visible` — the browser cannot tell it
 * that the host is showing a different tab. The host sends an `active` message
 * instead, and this is where that lands; `usePageActive` folds it into the
 * answer every data hook already asks for.
 *
 * Defaults to active, so a plain window, the host window, and a frame whose
 * host never says anything all behave exactly as before.
 */
const state = hmrSingleton('frameActive_state', () => ({
  active: true,
  listeners: new Set<() => void>(),
}))

export function isFrameActive(): boolean {
  return state.active
}

export function setFrameActive(active: boolean): void {
  if (state.active === active) return
  state.active = active
  for (const listener of state.listeners) listener()
}

export function subscribeFrameActive(listener: () => void): () => void {
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}
```

- [ ] **Step 4: Fold it into `usePageActive`**

Rewrite `src/hooks/use-page-active.ts`:

```tsx
'use client'

import { useSyncExternalStore } from 'react'
import { isFrameActive, subscribeFrameActive } from '@/lib/app/frame-active'

function subscribe(cb: () => void) {
  document.addEventListener('visibilitychange', cb)
  const offFrame = subscribeFrameActive(cb)
  return () => {
    document.removeEventListener('visibilitychange', cb)
    offFrame()
  }
}

function getSnapshot(): boolean {
  // A background tab frame is "hidden" as far as the app is concerned, even
  // though the browser still calls its document visible: the reader is looking
  // at another tab of the same window.
  return document.visibilityState === 'visible' && isFrameActive()
}

function getServerSnapshot(): boolean {
  return true
}

/** Returns `true` when this window — and, in the tab host, this tab — is the one on screen. SSR-safe. */
export function usePageActive(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsx --test src/lib/app/frame-active.test.ts`; `npx tsc --noEmit -p .`; `npx eslint src/lib/app/frame-active.ts src/lib/app/frame-active.test.ts src/hooks/use-page-active.ts`
Expected: PASS / no errors.
Register the test in `package.json`'s `test:runtime` (mind the separating spaces — a glued path is silently ignored; `src/lib/app/test-runtime-paths.test.ts` guards this).

```bash
git add src/lib/app/frame-active.ts src/lib/app/frame-active.test.ts src/hooks/use-page-active.ts package.json
git commit -m "Let a tab frame know it is in the background

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The host says which frame is active, and inactive frames stop animating

**Files:**
- Modify: `src/lib/app/tab-protocol.ts` (+ `src/lib/app/tab-protocol.test.ts`)
- Modify: `src/components/layout/tab-host.tsx`
- Modify: `src/components/layout/tab-frame-bridge.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `setFrameActive` (Task 1).
- Produces: host→frame message `{ source: 'sc-host', type: 'active', active: boolean }`, parsed by the existing `parseHostMessage`.

- [ ] **Step 1: Extend the protocol, test first**

In `src/lib/app/tab-protocol.test.ts` add, in the host-message group:

```ts
  it('accepts an active message and rejects a malformed one', () => {
    assert.deepEqual(parseHostMessage({ source: 'sc-host', type: 'active', active: false }), { source: 'sc-host', type: 'active', active: false })
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'active' }), null)
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'active', active: 'yes' }), null)
  })
```

Run it, see it fail, then add the variant to `hostMessageSchema` in `src/lib/app/tab-protocol.ts`:

```ts
  z.object({ source: z.literal('sc-host'), type: z.literal('active'), active: z.boolean() }),
```

with a comment saying the host is the only thing that knows which tab is on screen, so it tells each frame.

- [ ] **Step 2: Send it from the host**

In `src/components/layout/tab-host.tsx`:
- where the host posts to a frame (the same `post(frame, …)` helper `flush` uses), add an effect that runs whenever the active tab id or the set of mounted frames changes, and posts `{ source: 'sc-host', type: 'active', active: frame.id === activeId }` to every mounted frame whose window exists;
- also send it to a frame right after it reports `ready`, so a frame that boots in the background learns it immediately;
- keep it a no-op for a frame that is not mounted.

Write the comment: a frame cannot see the strip, so this is the only way it learns it is not the tab being looked at.

- [ ] **Step 3: Apply it in the frame**

In `src/components/layout/tab-frame-bridge.tsx`, in the handler for host messages, add the `active` case:

```tsx
      case 'active':
        setFrameActive(message.active)
        // CSS has no way to ask the host, so the flag rides on the root element:
        // `globals.css` pauses animations under it.
        document.documentElement.toggleAttribute('data-tab-inactive', !message.active)
        return
```

and make sure the bridge clears the attribute and sets the flag back to active on unmount.

- [ ] **Step 4: Pause animations under the attribute**

In `src/app/globals.css`, next to the `prefers-reduced-motion` block:

```css
/* A tab the reader is not looking at is still laid out (so its scroll position
   and layout survive), which means its animations would otherwise keep the
   compositor busy at the display's refresh rate for every background tab. */
html[data-tab-inactive] *,
html[data-tab-inactive] *::before,
html[data-tab-inactive] *::after {
  animation-play-state: paused !important;
  transition: none !important;
}
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsx --test src/lib/app/tab-protocol.test.ts src/lib/app/frame-active.test.ts`; `npx tsc --noEmit -p .`; `npx eslint` on the changed files.

```bash
git add src/lib/app/tab-protocol.ts src/lib/app/tab-protocol.test.ts src/components/layout/tab-host.tsx src/components/layout/tab-frame-bridge.tsx src/app/globals.css
git commit -m "Tell each tab frame whether it is the one on screen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: A background frame stops reacting to push events, and catches up once

**Files:**
- Modify: `src/hooks/use-ws.ts`
- Create: `src/lib/app/ws-catch-up.ts`, `src/lib/app/ws-catch-up.test.ts` (the pure part)
- Modify: `package.json` (`test:runtime`)

Today `useWs` gates only its fallback polling on `usePageActive`; a push event still runs the handler in every frame, so one `notify('sessions')` costs a full `GET /sessions` per open tab. This task skips the handler while the frame is inactive, remembers that something was missed, and runs it exactly once when the frame comes back.

**Interfaces:**
- Produces: `createCatchUp(run: () => void): { onEvent(active: boolean): void; onActiveChange(active: boolean): void }` — `onEvent` runs immediately when active and otherwise records a miss; `onActiveChange(true)` runs once if anything was missed; `onActiveChange(false)` does nothing.

- [ ] **Step 1: Write the failing test**

Create `src/lib/app/ws-catch-up.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCatchUp } from './ws-catch-up'

describe('createCatchUp', () => {
  it('runs at once while active', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onEvent(true)
    c.onEvent(true)
    assert.equal(runs, 2)
  })

  it('coalesces everything missed while inactive into one run', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onEvent(false)
    c.onEvent(false)
    c.onEvent(false)
    assert.equal(runs, 0)
    c.onActiveChange(true)
    assert.equal(runs, 1)
    c.onActiveChange(true)
    assert.equal(runs, 1, 'nothing missed since the last catch-up')
  })

  it('does not run when going inactive, and misses after that still coalesce', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onActiveChange(false)
    assert.equal(runs, 0)
    c.onEvent(false)
    c.onActiveChange(true)
    assert.equal(runs, 1)
  })
})
```

- [ ] **Step 2: Run it, see it fail, then implement `src/lib/app/ws-catch-up.ts`**

```ts
/**
 * What a subscription does with events that arrive while nobody is looking.
 *
 * A background tab frame used to run every push handler — and most of those
 * handlers refetch a whole collection, so one server notification cost one
 * request per open tab. Skipping them is only safe if coming back is not
 * silent: the frame runs the handler once when it is shown again, however many
 * events it missed.
 */
export interface CatchUp {
  /** A push event arrived. Runs the handler when active; records a miss when not. */
  onEvent(active: boolean): void
  /** The frame's active state changed. Runs the handler once if anything was missed. */
  onActiveChange(active: boolean): void
}

export function createCatchUp(run: () => void): CatchUp {
  let missed = false
  return {
    onEvent(active) {
      if (active) {
        run()
        return
      }
      missed = true
    },
    onActiveChange(active) {
      if (!active || !missed) return
      missed = false
      run()
    },
  }
}
```

- [ ] **Step 3: Use it in `useWs`**

In `src/hooks/use-ws.ts`:
- keep `const isActive = usePageActive()` and the existing `runHandler`;
- hold one `CatchUp` per hook instance in a ref: `const catchUpRef = useRef<CatchUp | null>(null)`, created on first use with `createCatchUp(() => runHandler())`;
- in the WS subscription effect, change the callback to `const cb = () => catchUpRef.current?.onEvent(isActiveRef.current)` — read the active flag through a ref so the subscription does not need to re-subscribe when it changes;
- keep an `isActiveRef` in sync with `isActive` in an effect, and in the same effect call `catchUpRef.current?.onActiveChange(isActive)`;
- leave the fallback-polling effect as it is (it already skips while inactive and refreshes on reactivation).

Add a comment saying why the subscription stays open while inactive: re-subscribing on every tab switch would cost more than the skipped handler, and the socket itself is dealt with in the next task.

- [ ] **Step 4: Verify and commit**

Run: `npx tsx --test src/lib/app/ws-catch-up.test.ts src/lib/app/frame-active.test.ts`; `npx tsc --noEmit -p .`; `npx eslint src/hooks/use-ws.ts src/lib/app/ws-catch-up.ts src/lib/app/ws-catch-up.test.ts`; register the new test in `test:runtime`.

```bash
git add src/hooks/use-ws.ts src/lib/app/ws-catch-up.ts src/lib/app/ws-catch-up.test.ts package.json
git commit -m "Skip push handlers in a background tab, and catch up once on return

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: A frame that stays in the background closes its socket

**Files:**
- Create: `src/lib/app/idle-socket.ts`, `src/lib/app/idle-socket.test.ts`
- Modify: `src/components/layout/tab-frame-bridge.tsx`
- Modify: `package.json` (`test:runtime`)

Each frame opens its own WebSocket (`connectWs()` in `use-app-bootstrap.ts`), so six live tabs mean six sockets and six sets of server-side subscriptions. A frame that has been in the background for a while does not need one; it catches up through Task 3 when it returns.

**Interfaces:**
- Produces: `createIdleSocket(options: { graceMs: number; connect: () => void; disconnect: () => void; setTimer?: …; clearTimer?: … }): { setActive(active: boolean): void; dispose(): void }` — going inactive starts the grace timer; going active cancels it and reconnects if it had disconnected; `dispose()` cancels the timer and leaves the socket as it is.

- [ ] **Step 1: Write the failing test**

Create `src/lib/app/idle-socket.test.ts` with a fake timer harness like `stream-batch.test.ts`'s, asserting:
- inactive for less than the grace period, then active again → never disconnected, never reconnected;
- inactive past the grace period → disconnected once; then active → reconnected once;
- repeated `setActive(false)` does not stack timers or disconnect twice;
- `dispose()` while the timer is pending does not disconnect.

Run it, see it fail.

- [ ] **Step 2: Implement `src/lib/app/idle-socket.ts`**

Plain state machine over the injected `connect`/`disconnect`/timer functions, with a doc comment explaining the grace period: flicking between two tabs must not churn the connection, and a socket is worth keeping for a few seconds of "I'll be right back".

- [ ] **Step 3: Wire it into the frame bridge**

In `src/components/layout/tab-frame-bridge.tsx`, create one `createIdleSocket({ graceMs: 30_000, connect: connectWs, disconnect: disconnectWs })` per bridge instance, call `setActive(...)` from the same place that handles the `active` message, and `dispose()` on unmount. Only in tab mode — the host and a plain window never call it.

Note for the implementer: check what `disconnectWs()` does to the store's connection-state listeners (`onWsStateChange`) — a disconnected frame must not start fallback polling instead, which would defeat the point. `useWs`'s polling is already gated on `usePageActive`, so an inactive frame polls nothing; verify that by reading, and say so in your report.

- [ ] **Step 4: Verify and commit**

Run: `npx tsx --test src/lib/app/idle-socket.test.ts src/lib/app/ws-catch-up.test.ts src/lib/app/frame-active.test.ts src/lib/app/tab-protocol.test.ts`; `npx tsc --noEmit -p .`; `npx eslint` on the changed files; register the test.

```bash
git add src/lib/app/idle-socket.ts src/lib/app/idle-socket.test.ts src/components/layout/tab-frame-bridge.tsx package.json
git commit -m "Close a background tab's socket after a grace period

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The two leftovers, then measure

**Files:**
- Modify: `src/components/home/tier-live.tsx`
- Modify: `src/components/layout/tab-host.tsx` and `src/components/layout/sidebar-rail.tsx` (one extension-pages fetch, not two)

- [ ] **Step 1: Gate the Home tiers on `usePageActive`**

`src/components/home/tier-live.tsx` polls `/missions` every 20 s and ticks a clock every 60 s with raw `setInterval`s, so a Home tab in the background keeps both running. Gate both on `usePageActive()` (clear the intervals when inactive, run one refresh when it becomes active again), the way `useWs` does.

- [ ] **Step 2: Fetch the extension pages once**

`useExtensionPages()` is called by both `tab-host.tsx` and `sidebar-rail.tsx` in the same window, and each instance does its own `GET /extensions/ui?type=pages`, its own `extensions` subscription and its own 60 s fallback timer. Make the hook share one fetch per window (module-level cache + subscriber set in an `hmrSingleton`, refreshed by the existing websocket topic), or lift it into the store — whichever fits the codebase better. Keep the hook's API unchanged, and keep `pagesForSection` and its tests working.

- [ ] **Step 3: Verify**

Run: `npx tsx --test src/hooks/use-extension-pages.test.ts src/lib/app/frame-active.test.ts src/lib/app/ws-catch-up.test.ts src/lib/app/idle-socket.test.ts`; `npx tsc --noEmit -p .`; `npx eslint` on the changed files; `npm run lint:baseline`.

- [ ] **Step 4: Live check (isolated test server on 127.0.0.1:3901 — do not start or stop anything)**

Record each result:
1. Open two tabs on the same chat. In the background frame, `document.documentElement.hasAttribute('data-tab-inactive')` is true and `getAnimations().filter(a => a.playState === 'running')` is empty; in the active frame both are the opposite.
2. Start a run in the active tab. In the background frame, the network panel shows no `GET /sessions` bursts while it is hidden.
3. Switch to the background tab: it updates at once (messages, tool rows, titles), without a reload.
4. Leave a tab in the background for more than 30 s: its WebSocket closes (`ws` connection count drops); switching back reconnects and the tab is up to date.
5. Switch tabs rapidly a few times: no connection churn (nothing closes), no lost updates.
6. A plain window (below 768 px, or with tabs off) behaves exactly as before.

- [ ] **Step 5: Measure**

Sample during a real run in the desktop app, the same way the starting numbers were taken, with the same chat open in two tabs:

```bash
top -l 11 -s 2 -o cpu -n 20 -stats pid,command,cpu | awk '/^PID/{n++} n>1 && ($2=="WindowServer" || $2 ~ /SidekickOS/) {sum[$1" "$2]+=$NF; cnt[$1" "$2]++} END {for (k in sum) printf "%-26s avg %.1f%% (%d samples)\n", k, sum[k]/cnt[k], cnt[k]}'
```

Report the averages beside the starting point (GPU 30%, renderer 16%, WindowServer 41%). If the renderer has not dropped, say so plainly.

- [ ] **Step 6: Commit**

```bash
git add src/components/home/tier-live.tsx src/components/layout/tab-host.tsx src/components/layout/sidebar-rail.tsx src/hooks/use-extension-pages.ts
git commit -m "Stop background polling on Home, and fetch the extension pages once

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in this plan

- **One shared WebSocket for the whole window.** A frame closing its own socket after 30 s gets most of the win without a relay layer; a single socket owned by the host (with `postMessage` fan-out or a `SharedWorker`) is the next step if the numbers still call for it.
- **Scoping the `runs` notification per session.** Server-side change: `queue/core.ts` fires a global `notify('runs')` at ~10 sites, and every mounted conversation list, agent chat list and queue view reloads on all of them. Worth doing, but it belongs with the server's notification model, not here.
