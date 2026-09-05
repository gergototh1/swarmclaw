import assert from 'node:assert/strict'
import { test } from 'node:test'

import { binaryPath, resolvingExecFile } from '../src/binaries.mjs'

/**
 * The PATH surface: what this module does with `ctx.resolveBinary`.
 *
 * One tool is at stake here, `ffprobe`, and it decides whether a synthesis
 * that already spent provider budget can be measured. A host that answers with
 * a path must be believed, or the packaged app refuses every call with
 * `tts_hossz_meres_sikertelen` on a machine that has ffprobe. A host that
 * answers null, or an older host with no such function, must leave the bare
 * name alone, or a machine where the old behaviour worked stops working.
 */

test('binaryPath answers the host path when the host found one', () => {
  assert.equal(binaryPath({ resolveBinary: (name) => `/opt/homebrew/bin/${name}` }, 'ffprobe'), '/opt/homebrew/bin/ffprobe')
})

test('binaryPath falls back to the bare name when the host found nothing', () => {
  assert.equal(binaryPath({ resolveBinary: () => null }, 'ffprobe'), 'ffprobe')
  assert.equal(binaryPath({ resolveBinary: () => '' }, 'ffprobe'), 'ffprobe')
})

test('binaryPath falls back to the bare name on a host that has no resolver at all', () => {
  assert.equal(binaryPath({ resolveBinary: null }, 'ffprobe'), 'ffprobe')
  assert.equal(binaryPath({}, 'ffprobe'), 'ffprobe')
  assert.equal(binaryPath(null, 'ffprobe'), 'ffprobe')
})

test('binaryPath does not swallow the host refusal of a name that is not a command name', () => {
  const state = { resolveBinary: () => { throw new TypeError('resolveBinary: "x; id" is not a plain command name') } }
  assert.throws(() => binaryPath(state, 'x; id'), /not a plain command name/)
})

test('resolvingExecFile resolves the name and passes the arguments and options through unchanged', async () => {
  const calls = []
  const run = resolvingExecFile(
    { resolveBinary: (name) => `/usr/local/bin/${name}` },
    async (name, args, options) => { calls.push({ name, args, options }); return { stdout: '1.5\n', stderr: '' } },
  )
  const out = await run('ffprobe', ['-v', 'error'], { timeout: 5 })
  assert.deepEqual(out, { stdout: '1.5\n', stderr: '' })
  assert.deepEqual(calls, [{ name: '/usr/local/bin/ffprobe', args: ['-v', 'error'], options: { timeout: 5 } }])
})

test('a test double sees the bare name, because a test leaves resolveBinary null', async () => {
  const seen = []
  const run = resolvingExecFile({ resolveBinary: null }, async (name) => { seen.push(name); return { stdout: '1', stderr: '' } })
  await run('ffprobe', [], {})
  assert.deepEqual(seen, ['ffprobe'])
})
