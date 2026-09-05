import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { binaryPath, resolvingExecFile, resolvingSpawn, spawnOptionsFor } from '../src/binaries.mjs'

const execFileAsync = promisify(execFile)

/**
 * The PATH surface: what this module does with `ctx.resolveBinary`.
 *
 * The properties worth holding are the ways this can go wrong on the
 * operator's machine. A host that answers with a path must be believed, or the
 * packaged app keeps missing Homebrew. A resolved path must also bring its own
 * directory onto the child's PATH, or a script tool such as `npx` resolves
 * perfectly and still fails on the interpreter its shebang names. A host that
 * answers null, or an older host with no such function at all, must leave both
 * the bare name and the environment alone, or every spawn breaks on a machine
 * where the old behaviour worked. And the resolution has to happen on the
 * runner rather than at each call site, so the QA gate and the preflight
 * cannot end up asking about two different files under two different
 * environments.
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

test('resolvingExecFile resolves the name, passes the arguments through unchanged, and keeps the caller options', async () => {
  const calls = []
  const run = resolvingExecFile(
    { resolveBinary: (name) => `/usr/local/bin/${name}` },
    async (name, args, options) => { calls.push({ name, args, options }); return { stdout: 'ok', stderr: '' } },
  )
  const out = await run('ffprobe', ['-version'], { timeout: 5, env: { PATH: '/bin' } })
  assert.deepEqual(out, { stdout: 'ok', stderr: '' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, '/usr/local/bin/ffprobe')
  assert.deepEqual(calls[0].args, ['-version'])
  assert.equal(calls[0].options.timeout, 5, 'the caller option was dropped')
  assert.equal(calls[0].options.env.PATH, `/usr/local/bin${path.delimiter}/bin`)
})

test('resolvingSpawn resolves the name, passes the arguments through unchanged, and keeps the caller options', () => {
  const calls = []
  const run = resolvingSpawn(
    { resolveBinary: (name) => `/usr/local/bin/${name}` },
    (name, args, options) => { calls.push({ name, args, options }); return { pid: 7 } },
  )
  const child = run('npx', ['remotion', 'render'], { cwd: '/tmp', detached: true, env: { PATH: '/bin' } })
  assert.deepEqual(child, { pid: 7 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, '/usr/local/bin/npx')
  assert.deepEqual(calls[0].args, ['remotion', 'render'])
  assert.equal(calls[0].options.cwd, '/tmp')
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.env.PATH, `/usr/local/bin${path.delimiter}/bin`)
})

test('a resolved tool brings its own directory to the front of the child PATH', () => {
  // WHY THE FRONT. The directory the tool was found in is the directory the
  // interpreter it was installed beside lives in. A node further back on PATH
  // is some other node, and for `npx` the two are not interchangeable.
  const opts = spawnOptionsFor('/opt/homebrew/bin/npx', 'npx', { env: { PATH: `/usr/bin${path.delimiter}/bin` } })
  assert.equal(opts.env.PATH, `/opt/homebrew/bin${path.delimiter}/usr/bin${path.delimiter}/bin`)
})

test('a resolved tool inherits the parent environment when the caller passed none', () => {
  // The child would have inherited process.env anyway; copying it is what lets
  // one key be prepended to, and every other key has to survive that copy.
  const opts = spawnOptionsFor('/opt/homebrew/bin/npx', 'npx', undefined)
  assert.equal(opts.env.PATH.split(path.delimiter)[0], '/opt/homebrew/bin')
  assert.equal(opts.env.HOME, process.env.HOME, 'the parent environment was not carried over')
})

test('an unresolved name leaves the caller options object untouched, environment included', () => {
  // A host with no resolver, or one that found nothing, must leave a machine
  // that worked before working exactly as it did -- which means the child goes
  // on inheriting the parent environment rather than a copy of it.
  const options = { cwd: '/tmp' }
  assert.equal(spawnOptionsFor('npx', 'npx', options), options)
  assert.equal(spawnOptionsFor('npx', 'npx', undefined), undefined)
})

test('a test double sees the bare name and the untouched options, because a test leaves resolveBinary null', async () => {
  const seen = []
  const options = {}
  const run = resolvingExecFile({ resolveBinary: null }, async (name, _args, opts) => { seen.push({ name, opts }); return { stdout: '', stderr: '' } })
  await run('ffmpeg', ['-version'], options)
  assert.deepEqual(seen.map((s) => s.name), ['ffmpeg'])
  assert.equal(seen[0].opts, options)
})

test('a resolved script tool runs when its shebang interpreter is only in its own directory', async (t) => {
  // THE DEFECT THIS CLOSES, END TO END AND WITH REAL PROCESSES.
  //
  // `npx` is not a program, it is a file beginning `#!/usr/bin/env node`.
  // Resolving it to an absolute path moves the search one step: `env` then
  // hunts for `node` on the child's PATH, which in the packaged desktop app is
  // the same short GUI PATH that could not find `npx`. Measured on the
  // operator's machine, where both live in ~/.local/bin, the host resolved npx
  // correctly and the probe still failed, so `health` answered
  // `npx_hianyzik` and `blokkolt: ['render']` for an installed tool.
  //
  // The fixture is that machine in miniature: a tool and its interpreter
  // together in one directory, and a PATH that does not mention it. Nothing
  // here depends on what is installed on the machine running the suite -- the
  // environment is passed in whole.
  if (process.platform === 'win32') return t.skip('POSIX shebangs')
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-binaries-'))
  try {
    fs.writeFileSync(path.join(scratch, 'faux-node'), '#!/bin/sh\necho FAUX-RAN\n', { mode: 0o755 })
    fs.writeFileSync(path.join(scratch, 'faux-npx'), '#!/usr/bin/env faux-node\n', { mode: 0o755 })
    const state = { resolveBinary: (name) => path.join(scratch, `faux-${name}`) }
    const run = resolvingExecFile(state, execFileAsync)
    const out = await run('npx', ['--version'], { env: { PATH: `/usr/bin${path.delimiter}/bin` } })
    assert.match(out.stdout, /FAUX-RAN/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
