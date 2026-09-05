import fs from 'node:fs'

/**
 * Noticing edits that did not come from us.
 *
 * THIS IS THE MODULE'S ONLY LISTENER, AND ITS ONLY REAL HAZARD. The host
 * re-runs `setup()` on any write under `data/extensions`, so a watcher started
 * naively from there would leak one `fs.watch` handle per reload, forever.
 * `ensureWatcher` is therefore idempotent in both directions: asked for a
 * watcher it already runs, it does nothing; asked for a different root, it
 * closes the old one first; asked for none, it closes and opens nothing.
 *
 * The watched root is a different directory from `data/extensions`, so our own
 * writes do not trigger a host reload and there is no loop.
 *
 * A watcher is a safety net here, not the main road: every write we make is
 * indexed by the writer directly, and losing the watcher costs only the
 * Obsidian-and-Finder path. That is why a failure to start is recorded in
 * `status()` and not thrown -- the page draws a bar from it, and the rest of
 * the module keeps working.
 */

const DEBOUNCE_MS = 200

export function createWatcherControl({ watchImpl = fs.watch, now = Date.now } = {}) {
  const state = {
    handle: null,
    root: null,
    indultAt: null,
    hiba: null,
    timers: new Map(),
  }

  function stop() {
    for (const timer of state.timers.values()) clearTimeout(timer)
    state.timers.clear()
    if (state.handle) {
      try {
        state.handle.close()
      } catch {
        // A handle that is already closed is the outcome we wanted anyway.
      }
    }
    state.handle = null
    state.root = null
    state.indultAt = null
  }

  function status() {
    return {
      fut: Boolean(state.handle),
      root: state.root,
      indultAt: state.indultAt,
      hiba: state.hiba,
    }
  }

  /**
   * Whether this event is worth indexing.
   *
   * Our own writes are recognised by the *content* hash and not by the path
   * alone. If somebody really edits the file from outside a moment after we
   * saved it, the content differs, so the hash differs, and the event is
   * processed. A path-only filter would swallow exactly that edit.
   */
  function shouldIndex(writer, vault, relPath) {
    if (!relPath.endsWith('.md')) return false
    if (relPath.startsWith('.swarmdocs/')) return false
    if (!vault.exists(relPath)) return false
    let hash
    try {
      hash = vault.readDoc(relPath).hash
    } catch {
      return false
    }
    return !writer.isSelfWrite(relPath, hash)
  }

  function handleEvent(relPath, { writer, vault, log }) {
    const existing = state.timers.get(relPath)
    if (existing) clearTimeout(existing)
    // Editors emit several events for one save; one index per quiet path.
    state.timers.set(relPath, setTimeout(() => {
      state.timers.delete(relPath)
      try {
        if (shouldIndex(writer, vault, relPath)) writer.indexPath(relPath)
      } catch (err) {
        // One unreadable document must not take the watcher down with it.
        log?.warn?.('docs watcher could not index a file', { relPath, error: err?.message })
      }
    }, DEBOUNCE_MS))
  }

  function ensureWatcher({ root, enabled, writer, vault, log }) {
    if (!enabled) {
      stop()
      state.hiba = null
      return status()
    }
    if (state.handle && state.root === root) return status()
    stop()
    try {
      state.handle = watchImpl(root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        handleEvent(String(filename).split('\\').join('/'), { writer, vault, log })
      })
      state.root = root
      state.indultAt = now()
      state.hiba = null
    } catch (err) {
      state.handle = null
      state.root = null
      state.indultAt = null
      state.hiba = err?.message ?? 'a figyelő nem indult el'
      log?.warn?.('docs watcher failed to start', { root, error: state.hiba })
    }
    return status()
  }

  return { ensureWatcher, status, stop }
}
