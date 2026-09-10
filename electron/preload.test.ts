import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * `window.swarmclaw` is already owned by the extension-page API surface built
 * by `getHostRegistry()` in `src/components/layout/extension-host.tsx`, which
 * does `const existing = window.swarmclaw; if (existing) return existing`.
 * If the Electron preload claimed the bare `swarmclaw` global (it used to),
 * it runs before the extension host in the desktop app, so every extension
 * page gets handed the two-method notification bridge instead of the real
 * registry and crashes calling `host.onPageRegistered(...)`.
 *
 * That failure mode is a *string* collision, not something a type checker or
 * a behavioral test of either module in isolation would catch -- both files
 * compile fine and pass their own tests; the bug only exists in the shared
 * name. So the honest regression test here is a string-level assertion
 * against the preload source itself: it must expose `swarmclawDesktop` and
 * must never expose the bare `swarmclaw` name.
 */
test('preload exposes swarmclawDesktop, never the bare swarmclaw global', () => {
  const source = fs.readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')

  assert.match(
    source,
    /exposeInMainWorld\(\s*'swarmclawDesktop'/,
    'preload must exposeInMainWorld("swarmclawDesktop", ...)',
  )
  assert.doesNotMatch(
    source,
    /exposeInMainWorld\(\s*'swarmclaw'\s*,/,
    'preload must not exposeInMainWorld("swarmclaw", ...) -- that name belongs to the extension host',
  )
})
