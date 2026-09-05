import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * The module's most important structural rule, guarded.
 *
 * The host re-runs `setup()` on any write under `data/extensions`, and it
 * re-executes the module file itself on any edit to it. A handle, a timer or a
 * file read at module scope would therefore be created once per reload and
 * never released. This test is what makes that expensive to break.
 */
test('importing the module opens no handle, reads no file, starts no timer', async () => {
  const readFileSync = fs.readFileSync
  const watch = fs.watch
  const watchFile = fs.watchFile
  const setIntervalOrig = globalThis.setInterval
  const setTimeoutOrig = globalThis.setTimeout

  const reads = []
  let watches = 0
  const timers = []

  fs.readFileSync = (...args) => { reads.push(String(args[0])); return readFileSync(...args) }
  fs.watch = (...args) => { watches += 1; return watch(...args) }
  fs.watchFile = (...args) => { watches += 1; return watchFile(...args) }
  globalThis.setInterval = (...args) => { timers.push('interval'); return setIntervalOrig(...args) }
  globalThis.setTimeout = (...args) => { timers.push('timeout'); return setTimeoutOrig(...args) }

  try {
    await import(`../index.mjs?t=${Date.now()}`)
    // A node_modules alóli olvasás a betöltő dolga, nem a modulé.
    assert.deepEqual(reads.filter((p) => !p.includes('node_modules')), [])
    assert.equal(watches, 0, 'a betöltés figyelőt nyitott')
    assert.deepEqual(timers, [], 'a betöltés időzítőt indított')
  } finally {
    fs.readFileSync = readFileSync
    fs.watch = watch
    fs.watchFile = watchFile
    globalThis.setInterval = setIntervalOrig
    globalThis.setTimeout = setTimeoutOrig
  }
})
