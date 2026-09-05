import assert from 'node:assert/strict'
import { test } from 'node:test'

import { binaryPath, resolvingExecFile, resolvingSpawn } from '../src/binaries.mjs'

/**
 * The PATH surface: what this module does with `ctx.resolveBinary`.
 *
 * The three properties worth holding are the three ways this can go wrong on
 * the operator's machine. A host that answers with a path must be believed, or
 * the packaged app keeps missing Homebrew. A host that answers null, or an
 * older host with no such function at all, must leave the bare name alone, or
 * every spawn breaks on a machine where the old behaviour worked. And the
 * resolution has to happen on the runner rather than at each call site, so the
 * QA gate and the preflight cannot end up asking about two different files.
 */

test('binaryPath answers the host path when the host found one', () => {
  const asked = []
  const state = { resolveBinary: (name) => { asked.push(name); return `/opt/homebrew/bin/${name}` } }
  assert.equal(binaryPath(state, 'ffmpeg'), '/opt/homebrew/bin/ffmpeg')
  assert.deepEqual(asked, ['ffmpeg'])
})

test('binaryPath falls back to the bare name when the host found nothing', () => {
  assert.equal(binaryPath({ resolveBinary: () => null }, 'ffprobe'), 'ffprobe')
  assert.equal(binaryPath({ resolveBinary: () => '' }, 'ffprobe'), 'ffprobe')
})

test('binaryPath falls back to the bare name on a host that has no resolver at all', () => {
  assert.equal(binaryPath({ resolveBinary: null }, 'npx'), 'npx')
  assert.equal(binaryPath({}, 'npx'), 'npx')
  assert.equal(binaryPath(null, 'npx'), 'npx')
})

test('binaryPath does not swallow the host refusal of a name that is not a command name', () => {
  // The host throws on anything it will not put in front of a login shell. In
  // this module every name is a literal in its own source, so a throw could
  // only mean a name typed wrong here, and hiding it would hide the bug.
  const state = { resolveBinary: () => { throw new TypeError('resolveBinary: "x; id" is not a plain command name') } }
  assert.throws(() => binaryPath(state, 'x; id'), /not a plain command name/)
})

test('resolvingExecFile resolves the name and passes the arguments and options through unchanged', async () => {
  const calls = []
  const run = resolvingExecFile(
    { resolveBinary: (name) => `/usr/local/bin/${name}` },
    async (name, args, options) => { calls.push({ name, args, options }); return { stdout: 'ok', stderr: '' } },
  )
  const out = await run('ffprobe', ['-version'], { timeout: 5 })
  assert.deepEqual(out, { stdout: 'ok', stderr: '' })
  assert.deepEqual(calls, [{ name: '/usr/local/bin/ffprobe', args: ['-version'], options: { timeout: 5 } }])
})

test('resolvingSpawn resolves the name and passes the arguments and options through unchanged', () => {
  const calls = []
  const run = resolvingSpawn(
    { resolveBinary: (name) => `/usr/local/bin/${name}` },
    (name, args, options) => { calls.push({ name, args, options }); return { pid: 7 } },
  )
  const child = run('npx', ['remotion', 'render'], { cwd: '/tmp', detached: true })
  assert.deepEqual(child, { pid: 7 })
  assert.deepEqual(calls, [{ name: '/usr/local/bin/npx', args: ['remotion', 'render'], options: { cwd: '/tmp', detached: true } }])
})

test('a test double sees the bare name, because a test leaves resolveBinary null', async () => {
  const seen = []
  const run = resolvingExecFile({ resolveBinary: null }, async (name) => { seen.push(name); return { stdout: '', stderr: '' } })
  await run('ffmpeg', ['-version'], {})
  assert.deepEqual(seen, ['ffmpeg'])
})
