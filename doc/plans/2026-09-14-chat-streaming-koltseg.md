# Streaming chat rendering cost — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A streaming agent answer stops costing a full markdown + syntax-highlight reparse of the whole message on every chunk, and stops forcing a synchronous layout on every DOM growth — without changing what the reader sees.

**Architecture:** Three independent changes. (1) The chat store coalesces stream text into at most one state write per ~50 ms, so the live bubble re-renders ~20×/s instead of per chunk; a non-text event flushes first, so ordering is unchanged. (2) `MarkdownBody` splits the text into markdown blocks and memoizes each, so a chunk re-parses only the last block instead of the whole message (the pattern Vercel's AI SDK cookbook and `streamdown` use). (3) The message list's `ResizeObserver` writes `scrollTop` at most once per animation frame instead of on every resize callback.

**Tech Stack:** Next 16 App Router, React 19, zustand, react-markdown + remark-gfm + rehype-highlight, `node:test` + `tsx`.

**Measured starting point (desktop app, 20 s averages during a 13-minute run with 19 Bash calls):** GPU process 30%, renderer 16%, main 9%, WindowServer 41%. Idle: ~1% each. The same chat was open in two tabs, and nothing throttles the hidden one — that is a separate change, not in this plan.

## Global Constraints

- No `any`. Never disable or suppress a lint rule. `npm run lint:baseline` must pass.
- No new dependencies.
- Nothing in this plan may change what is rendered once a chunk has landed: same text, same markdown, same code highlighting, same tool rows. Only the timing and the amount of repeated work changes.
- Module-level mutable state uses `hmrSingleton` from `@/lib/shared-utils`.
- Do NOT touch the tab host, the rail, `dashboard-shell.tsx`, or the WebSocket layer — a separate plan covers background frames.
- Do not start, stop or restart any server. Do not run the whole `npm run test:runtime`; run the files each task names with `npx tsx --test <files>`, plus `npx tsc --noEmit -p .` and `npx eslint <changed files>`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## File structure

| File | Responsibility |
|---|---|
| `src/lib/chat/stream-batch.ts` (new) | Pure patch coalescer: merge patches, flush on a timer or on demand. |
| `src/lib/chat/markdown-blocks.ts` (new) | Pure splitter: markdown text → stable block strings (fenced code kept whole). |
| `src/components/shared/markdown-body.tsx` | Render one memoized `MarkdownBlock` per block. |
| `src/components/chat/message-bubble.tsx` | Stable (`useCallback` / `useMemo`) render props, so the memo actually holds. |
| `src/stores/use-chat-store.ts` | Text and thinking chunks go through the batcher; every other event flushes first. |
| `src/components/chat/message-list.tsx` | `ResizeObserver` → one scroll write per animation frame. |

---

### Task 1: Coalesce stream text into ~20 writes per second

**Files:**
- Create: `src/lib/chat/stream-batch.ts`, `src/lib/chat/stream-batch.test.ts`
- Modify: `src/stores/use-chat-store.ts`
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Produces: `createStreamBatch<T extends object>(options: { intervalMs: number; apply: (patch: Partial<T>) => void; setTimer?: (fn: () => void, ms: number) => number; clearTimer?: (id: number) => void }): StreamBatch<T>` with `push(patch: Partial<T>): void`, `flush(): void`, `dispose(): void`.
- Behaviour: the first `push` applies immediately (the reader must see the first token at once) and opens a window; further pushes inside the window are merged and applied when it closes; `flush()` applies a pending patch now and closes the window; `dispose()` drops a pending patch and any timer.

- [ ] **Step 1: Write the failing test**

Create `src/lib/chat/stream-batch.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStreamBatch } from './stream-batch'

interface State { text: string; phase: string }

function harness(intervalMs = 50) {
  const applied: Partial<State>[] = []
  let now = 0
  const timers: { id: number; at: number; fn: () => void }[] = []
  let nextId = 1
  const batch = createStreamBatch<State>({
    intervalMs,
    apply: (patch) => applied.push(patch),
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
  })
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => t.at <= now)) {
      const i = timers.indexOf(timer)
      if (i >= 0) timers.splice(i, 1)
      timer.fn()
    }
  }
  return { applied, batch, advance, pendingTimers: () => timers.length }
}

describe('createStreamBatch', () => {
  it('applies the first patch at once, then merges the rest of the window into one write', () => {
    const { applied, batch, advance } = harness()
    batch.push({ text: 'a' })
    assert.deepEqual(applied, [{ text: 'a' }])
    batch.push({ text: 'ab' })
    batch.push({ text: 'abc' })
    batch.push({ phase: 'responding' })
    assert.equal(applied.length, 1, 'nothing else is written inside the window')
    advance(50)
    assert.deepEqual(applied, [{ text: 'a' }, { text: 'abc', phase: 'responding' }])
  })

  it('opens a new window only when something is pushed again', () => {
    const { applied, batch, advance, pendingTimers } = harness()
    batch.push({ text: 'a' })
    advance(50)
    assert.equal(pendingTimers(), 0, 'an idle stream keeps no timer running')
    batch.push({ text: 'ab' })
    assert.deepEqual(applied, [{ text: 'a' }, { text: 'ab' }])
  })

  it('flush applies a pending patch immediately and leaves nothing behind', () => {
    const { applied, batch, advance } = harness()
    batch.push({ text: 'a' })
    batch.push({ text: 'ab' })
    batch.flush()
    assert.deepEqual(applied, [{ text: 'a' }, { text: 'ab' }])
    batch.flush()
    advance(100)
    assert.equal(applied.length, 2, 'a flush with nothing pending writes nothing')
  })

  it('dispose drops the pending patch and its timer', () => {
    const { applied, batch, advance, pendingTimers } = harness()
    batch.push({ text: 'a' })
    batch.push({ text: 'ab' })
    batch.dispose()
    assert.equal(pendingTimers(), 0)
    advance(100)
    assert.deepEqual(applied, [{ text: 'a' }])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/lib/chat/stream-batch.test.ts`
Expected: FAIL — `Cannot find module './stream-batch'`.

- [ ] **Step 3: Implement `src/lib/chat/stream-batch.ts`**

```ts
/**
 * Coalesces the patches a stream produces into at most one state write per window.
 *
 * A streamed answer arrives as many small chunks, and each one used to write the
 * store — so the live bubble re-rendered (and re-parsed its markdown) per chunk.
 * The reader cannot see more than the display refreshes, so a window of a few
 * tens of milliseconds is invisible to them and removes most of the work.
 *
 * The first patch is applied straight away: the first token must appear without
 * delay. Timers are injected so the behaviour is testable without real time.
 */
export interface StreamBatch<T extends object> {
  /** Merge a patch into the current window, applying it at once if the window is closed. */
  push(patch: Partial<T>): void
  /** Apply whatever is pending right now (use before any event that must not be reordered). */
  flush(): void
  /** Drop the pending patch and the timer. */
  dispose(): void
}

export interface StreamBatchOptions<T extends object> {
  intervalMs: number
  apply: (patch: Partial<T>) => void
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

export function createStreamBatch<T extends object>(options: StreamBatchOptions<T>): StreamBatch<T> {
  const { intervalMs, apply } = options
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((id) => window.clearTimeout(id))

  let pending: Partial<T> | null = null
  let timer: number | null = null

  const applyPending = () => {
    timer = null
    if (!pending) return
    const patch = pending
    pending = null
    apply(patch)
    // Another window opens only when the stream pushes again; an idle stream keeps no timer.
  }

  return {
    push(patch) {
      if (timer === null) {
        apply(patch)
        timer = setTimer(applyPending, intervalMs)
        return
      }
      pending = pending ? { ...pending, ...patch } : { ...patch }
    },
    flush() {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      if (!pending) return
      const patch = pending
      pending = null
      apply(patch)
    },
    dispose() {
      if (timer !== null) clearTimer(timer)
      timer = null
      pending = null
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/lib/chat/stream-batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in the chat store**

In `src/stores/use-chat-store.ts`, inside the send action that owns the stream (where `setIfOwner` is defined, around line 483), add below `setIfOwner`:

```ts
    // Text chunks arrive faster than any display refreshes; one write per 50 ms
    // is invisible to the reader and stops the live bubble re-parsing its
    // markdown per chunk. Anything that is not text flushes first, so the order
    // of text, tool events and phase changes is exactly what the server sent.
    const textBatch = createStreamBatch<ChatState>({ intervalMs: 50, apply: (patch) => setIfOwner(patch) })
```

with `import { createStreamBatch } from '@/lib/chat/stream-batch'` at the top (`ChatState` is already the store's state type in this module; if it is not exported there, use the same local type alias the file already has).

Then:
- in the `event.t === 'd'` branch, replace the final `setIfOwner(patch)` with `textBatch.push(patch)`;
- in the `event.t === 'thinking'` branch, keep accumulating into a local string and push it through the batch instead of the functional `setIfOwner((s) => ({ thinkingText: s.thinkingText + … }))`: declare `let thinkingText = ''` next to `let fullText = ''`, then `thinkingText += event.text || ''; textBatch.push({ thinkingText })`. Reset it wherever `fullText` is reset (the `'reset'` branch);
- at the start of every other branch (`tool_call`, `tool_result`, `reset`, `err`, `status`, `done`, and any other event type in the same `if/else` chain), call `textBatch.flush()` before the branch's own `setIfOwner`;
- in the `finally` (or wherever the stream ends, including the error path), call `textBatch.flush()` and then `textBatch.dispose()`.

- [ ] **Step 6: Verify**

Run: `npx tsx --test src/lib/chat/stream-batch.test.ts` and `npx tsc --noEmit -p .`
Expected: PASS / no errors.
Run: `npx eslint src/lib/chat/stream-batch.ts src/lib/chat/stream-batch.test.ts src/stores/use-chat-store.ts`
Expected: no issues.

In `package.json` `test:runtime`, add `src/lib/chat/stream-batch.test.ts` next to the other `src/lib/` test files.

- [ ] **Step 7: Commit**

```bash
git add src/lib/chat/stream-batch.ts src/lib/chat/stream-batch.test.ts src/stores/use-chat-store.ts package.json
git commit -m "Write streamed text to the store at most 20 times a second

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Re-parse only the last markdown block

**Files:**
- Create: `src/lib/chat/markdown-blocks.ts`, `src/lib/chat/markdown-blocks.test.ts`
- Modify: `src/components/shared/markdown-body.tsx`
- Modify: `src/components/chat/message-bubble.tsx` (stable render props)
- Modify: `package.json` (`test:runtime`)

**Interfaces:**
- Produces: `splitMarkdownBlocks(text: string): string[]` — the text split into blocks on blank lines, with fenced code blocks (``` or ~~~) kept whole, including an unterminated fence at the end of a streaming message. Joining the result with `'\n\n'` must reproduce the input's blocks in order.

- [ ] **Step 1: Write the failing test**

Create `src/lib/chat/markdown-blocks.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitMarkdownBlocks } from './markdown-blocks'

describe('splitMarkdownBlocks', () => {
  it('splits on blank lines', () => {
    assert.deepEqual(splitMarkdownBlocks('first para\n\nsecond para'), ['first para', 'second para'])
  })

  it('keeps a fenced code block whole, blank lines included', () => {
    const text = 'before\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter'
    assert.deepEqual(splitMarkdownBlocks(text), ['before', '```ts\nconst a = 1\n\nconst b = 2\n```', 'after'])
  })

  it('keeps an unterminated fence as one trailing block (a half-streamed code block)', () => {
    const text = 'intro\n\n```sh\nnpm run build'
    assert.deepEqual(splitMarkdownBlocks(text), ['intro', '```sh\nnpm run build'])
  })

  it('treats ~~~ fences the same way', () => {
    assert.deepEqual(splitMarkdownBlocks('~~~\na\n\nb\n~~~'), ['~~~\na\n\nb\n~~~'])
  })

  it('is stable while text is appended: every block but the last stays identical', () => {
    const first = splitMarkdownBlocks('one\n\ntwo\n\nthr')
    const later = splitMarkdownBlocks('one\n\ntwo\n\nthree\n\nfour')
    assert.deepEqual(first.slice(0, 2), later.slice(0, 2))
  })

  it('returns no empty blocks, and nothing for empty text', () => {
    assert.deepEqual(splitMarkdownBlocks(''), [])
    assert.deepEqual(splitMarkdownBlocks('\n\n\n'), [])
    assert.deepEqual(splitMarkdownBlocks('a\n\n\n\nb'), ['a', 'b'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/lib/chat/markdown-blocks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/chat/markdown-blocks.ts`**

```ts
/**
 * Splits markdown into the blocks a renderer can memoize.
 *
 * A streamed answer grows at the end, so every block but the last is byte-for-byte
 * what it was on the previous chunk. Rendering one memoized component per block
 * means a chunk re-parses and re-highlights only the block being written, instead
 * of the whole message — which is what made a long answer cost more and more per
 * chunk.
 *
 * Blocks break on blank lines, except inside a fenced code block: a fence that is
 * still open (the model is mid-code-block) keeps everything after it in one block,
 * so the fence is never split across two renderers.
 */
const FENCE = /^\s{0,3}(```|~~~)/

export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null

  const closeBlock = () => {
    const block = current.join('\n').trim()
    if (block.length > 0) blocks.push(block)
    current = []
  }

  for (const line of lines) {
    const fenceMatch = line.match(FENCE)
    if (fence === null && fenceMatch) {
      // A fence starts a block of its own, so the paragraph before it stays separate.
      closeBlock()
      fence = fenceMatch[1]
      current.push(line)
      continue
    }
    if (fence !== null) {
      current.push(line)
      if (fenceMatch && fenceMatch[1] === fence) {
        fence = null
        closeBlock()
      }
      continue
    }
    if (line.trim() === '') {
      closeBlock()
      continue
    }
    current.push(line)
  }
  closeBlock()
  return blocks
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/lib/chat/markdown-blocks.test.ts`
Expected: PASS.

- [ ] **Step 5: Render one memoized block per block**

In `src/components/shared/markdown-body.tsx`:
- keep the whole `<ReactMarkdown …>` element and its `components` map exactly as it is, but move it into a new component that takes the same props and renders one block:

```tsx
const MarkdownBlock = memo(function MarkdownBlock(props: MarkdownBodyProps) {
  // the current body of MarkdownBody, unchanged, rendering props.text
})
```

- and make `MarkdownBody` split and map:

```tsx
/**
 * One memoized renderer per markdown block.
 *
 * While a message streams, only its last block changes; the blocks before it are
 * identical strings, so `memo` skips re-parsing and re-highlighting them. The
 * render props must be stable for that to hold — see `message-bubble.tsx`.
 */
export function MarkdownBody(props: MarkdownBodyProps) {
  const blocks = useMemo(() => splitMarkdownBlocks(props.text), [props.text])
  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} {...props} text={block} />
      ))}
    </>
  )
}
```

with `import { memo, useMemo } from 'react'` and `import { splitMarkdownBlocks } from '@/lib/chat/markdown-blocks'`.

Note for the implementer: `key={index}` is correct here — blocks are positional and a block's content is its identity through `text`.

- [ ] **Step 6: Make the render props stable**

In `src/components/chat/message-bubble.tsx`, look at the `<MarkdownBody …>` call around line 882. Every prop it passes (`renderLink`, `renderInlineCode`, `renderParagraph`, `skipMediaUrls`) must keep the same identity between renders, or the memo above never holds: wrap each function in `useCallback` with the values it closes over as dependencies, and `skipMediaUrls` in `useMemo`. Do not change what they do. Do the same in `src/components/chatrooms/chatroom-message.tsx` if it passes inline functions.

- [ ] **Step 7: Verify**

Run: `npx tsx --test src/lib/chat/markdown-blocks.test.ts src/lib/chat/stream-batch.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p .` and `npx eslint` on every changed file.
Expected: no errors (watch for the `react-hooks/exhaustive-deps` rule on the new `useCallback`s — fix the dependencies, never silence the rule).

In `package.json` `test:runtime`, add `src/lib/chat/markdown-blocks.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/chat/markdown-blocks.ts src/lib/chat/markdown-blocks.test.ts src/components/shared/markdown-body.tsx src/components/chat/message-bubble.tsx src/components/chatrooms/chatroom-message.tsx package.json
git commit -m "Re-parse only the markdown block a stream is still writing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: One scroll write per animation frame

**Files:**
- Modify: `src/components/chat/message-list.tsx` (the `ResizeObserver` effect around line 618)

- [ ] **Step 1: Coalesce the observer's scroll write**

Replace the observer body so it schedules one write per frame instead of writing on every callback:

```tsx
  // Re-snap when content resizes during the snap window (lazy images, streamed
  // text, new tool rows). The callback fires many times a second while a run
  // streams, and reading `scrollHeight` right before writing `scrollTop` forces
  // a synchronous layout each time — so the write is coalesced to one per frame.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const content = el.firstElementChild as HTMLElement | null
    if (!content) return

    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (Date.now() < snapUntilRef.current || wasAtBottomRef.current) {
          el.scrollTop = el.scrollHeight
        }
      })
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [sessionId])
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit -p .` and `npx eslint src/components/chat/message-list.tsx`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/message-list.tsx
git commit -m "Coalesce the transcript's auto-scroll to one write per frame

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Measure and check by hand

**Files:** none (report only).

- [ ] **Step 1: Functional check in the browser (isolated test server on 127.0.0.1:3901, already running — do not start or stop anything)**

With a chat open, verify in this order and record what you saw:
1. A streamed answer appears smoothly, with no visible stutter or delayed first token.
2. Code blocks in a streamed answer end up highlighted, and inline links, images and YouTube embeds still render.
3. A long answer stays scrolled to the bottom while it streams, and scrolling up during the stream still stops the auto-scroll.
4. Tool rows appear in the right order relative to the text around them (the flush-before-other-events rule).
5. Stopping a run mid-stream leaves the partial text on screen, and a reload shows the persisted message.

- [ ] **Step 2: Cost check**

Sample the desktop app (or the browser's renderer) during a real run, the same way the starting numbers were taken:

```bash
top -l 11 -s 2 -o cpu -n 20 -stats pid,command,cpu | awk '/^PID/{n++} n>1 && ($2=="WindowServer" || $2 ~ /SidekickOS/) {sum[$1" "$2]+=$NF; cnt[$1" "$2]++} END {for (k in sum) printf "%-26s avg %.1f%% (%d samples)\n", k, sum[k]/cnt[k], cnt[k]}'
```

Record the averages beside the starting point (GPU 30%, renderer 16%, WindowServer 41%) in the report. If the renderer has not dropped noticeably, say so plainly rather than assuming the change worked: the next suspect is the hidden second tab, which this plan does not touch.
