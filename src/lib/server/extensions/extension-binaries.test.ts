import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

/**
 * `ctx.resolveBinary`, the context surface an extension uses instead of
 * trusting the bare PATH.
 *
 * Nothing here imports './extension-binaries' statically. Its import chain
 * reaches `@/lib/providers/cli-utils` and through it `@/lib/server/logger`,
 * whose module body resolves DATA_DIR and whose every call appends to
 * `<DATA_DIR>/app.log` -- and a failed lookup logs. A statically importing test
 * would therefore write into the developer's own data directory on every run,
 * so even the pure cases below go through runWithTempDataDir.
 *
 * Two halves, and both can break independently. The lookup itself has to refuse
 * anything it will not put in front of a login shell, answer a real command
 * with a path that exists, and answer null rather than a guess for one that is
 * not installed. And the host has to actually hand it to an extension: a
 * resolver that works and is never wired up would leave the packaged desktop
 * app exactly as broken as before, which is why the second describe drives the
 * production path -- an extension file on disk, loaded by the manager, capturing
 * `ctx.resolveBinary` in setup() the way an extension author would, probed
 * through its own rpc.
 *
 * No test here asserts that a particular tool is installed: `ffmpeg` on the
 * machine running the suite is a property of that machine, not of this code.
 * `sh` is the one command a POSIX machine is required to have.
 */

const REFUSED = [
  ['a path separator', 'bin/ffmpeg'],
  ['an absolute path', '/usr/bin/ffmpeg'],
  ['a parent traversal', '../ffmpeg'],
  ['a command separator', 'ffmpeg; rm -rf /'],
  ['a pipe', 'ffmpeg|cat'],
  ['a substitution', 'ffmpeg$(whoami)'],
  ['a backtick', 'ffmpeg`id`'],
  ['whitespace', 'ff mpeg'],
  ['a newline', 'ffmpeg\nid'],
  ['a leading dash', '-rf'],
  ['a leading dot', '.ffmpeg'],
  ['a glob', 'ff*'],
  ['a single quote', "ffmpeg'"],
  ['the empty string', ''],
] as const

describe('resolveExtensionBinary', () => {
  it('refuses anything that is not a plain command name, by name, and never rewrites it', () => {
    const out = runWithTempDataDir<Record<string, { threw: boolean; type: string; message: string }>>(`
      const mod = await import('@/lib/server/extensions/extension-binaries')
      const { resolveExtensionBinary } = mod.default || mod
      const cases = ${JSON.stringify(Object.fromEntries(REFUSED.map(([what, value]) => [what, value])))}
      // The three non-string cases are added here rather than in the JSON,
      // which cannot carry them. They matter because the callers are .mjs
      // extensions, where the signature is not enforced.
      cases['a number'] = 42
      cases['null'] = null
      cases['undefined'] = undefined
      const result = {}
      for (const key of Object.keys(cases)) {
        try {
          resolveExtensionBinary(cases[key])
          result[key] = { threw: false, type: '', message: '' }
        } catch (err) {
          result[key] = { threw: true, type: err.constructor.name, message: String(err.message) }
        }
      }
      console.log(JSON.stringify(result))
    `)
    for (const [what] of REFUSED) {
      assert.equal(out[what].threw, true, `${what} was not refused`)
      assert.equal(out[what].type, 'TypeError', `${what} threw a ${out[what].type}`)
      assert.match(out[what].message, /^resolveBinary: /, `${what}: the message does not name the surface`)
    }
    for (const what of ['a number', 'null', 'undefined']) {
      assert.equal(out[what].threw, true, `${what} was not refused`)
      assert.match(out[what].message, /name must be a string/, `${what}: ${out[what].message}`)
    }
  })

  it('refuses a name past the length cap rather than truncating it, and takes one under it', () => {
    const out = runWithTempDataDir<{ overCap: string; atCap: string | null }>(`
      const mod = await import('@/lib/server/extensions/extension-binaries')
      const { resolveExtensionBinary } = mod.default || mod
      let overCap = 'no throw'
      try { resolveExtensionBinary('a'.repeat(65)) } catch (err) { overCap = String(err.message) }
      console.log(JSON.stringify({ overCap, atCap: resolveExtensionBinary('a'.repeat(64)) }))
    `)
    assert.match(out.overCap, /at most 64 characters, got 65/)
    // At the cap it is a name, not a refusal: nothing on the machine is called
    // that, so the answer is a null and not a throw.
    assert.equal(out.atCap, null)
  })

  it('answers an existing absolute path for a real command and null for one that is not installed', { skip: process.platform === 'win32' ? 'POSIX only' : false }, () => {
    const out = runWithTempDataDir<{ sh: string | null; shExists: boolean; invented: string | null; sameFromResolver: boolean }>(`
      const fs = await import('node:fs')
      const mod = await import('@/lib/server/extensions/extension-binaries')
      const { resolveExtensionBinary, createExtensionBinaryResolver } = mod.default || mod
      const sh = resolveExtensionBinary('sh')
      console.log(JSON.stringify({
        sh,
        shExists: typeof sh === 'string' && fs.existsSync(sh),
        invented: resolveExtensionBinary('swarmclaw-no-such-binary-' + process.pid),
        sameFromResolver: createExtensionBinaryResolver()('sh') === sh,
      }))
    `)
    assert.equal(typeof out.sh, 'string', 'sh did not resolve')
    assert.ok(path.isAbsolute(out.sh as string), `not an absolute path: ${out.sh}`)
    assert.equal(out.shExists, true, `resolved to a path that does not exist: ${out.sh}`)
    assert.equal(out.invented, null, 'an uninstalled command answered with a guess instead of null')
    assert.equal(out.sameFromResolver, true, 'the per-extension resolver is not the same lookup')
  })

  it('reaches the fallback directories when the login shell prints a banner in front of its answer', { skip: process.platform === 'win32' ? 'POSIX only' : false }, () => {
    // THE DEFECT THIS CLOSES. The lookup asks a login shell first, and only
    // stderr is suppressed: everything the operator's profile prints to
    // stdout comes back in front of `command -v`'s own output. That string
    // used to be accepted as the answer, so on any machine whose profile
    // echoes anything the lookup returned a banner, `existsSync` said no, and
    // the whole point of this module -- the Homebrew and nvm directories --
    // was never consulted. The shell here stands in for such a profile: it
    // prints a line and finds nothing, which is exactly the machine where the
    // fallbacks have to answer.
    const out = runWithTempDataDir<{ withBanner: string | null; bannerText: string | null }>(`
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-shell-'))
      const shell = path.join(scratch, 'chatty-shell')
      // A shell that greets, ignores what it was asked, and resolves nothing.
      fs.writeFileSync(shell, '#!/bin/sh\\necho "nvm: v20.11.0 is now in use"\\nexit 1\\n', { mode: 0o755 })
      process.env.SHELL = shell
      const mod = await import('@/lib/server/extensions/extension-binaries')
      const { resolveExtensionBinary } = mod.default || mod
      const ctx = await import('@/lib/server/session-tools/context')
      const { findBinaryOnPath } = ctx.default || ctx
      try {
        console.log(JSON.stringify({
          withBanner: resolveExtensionBinary('sh'),
          bannerText: findBinaryOnPath('swarmclaw-no-such-binary-' + process.pid),
        }))
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
      }
    `)
    // /bin and /usr/bin are on the fallback list, and sh is there on every
    // POSIX machine: the lookup answers from the list, not from the shell.
    assert.equal(typeof out.withBanner, 'string', 'the fallback list was never reached')
    assert.ok(path.isAbsolute(out.withBanner as string), `not an absolute path: ${out.withBanner}`)
    // And the banner itself is never handed back as if it were a path.
    assert.equal(out.bannerText, null)
  })

  it('finds a binary in ~/.local/bin, where a user-level install without Homebrew or nvm lands', { skip: process.platform === 'win32' ? 'POSIX only' : false }, () => {
    // THE LOCATION THIS PINS. The fallback list is the whole point of this
    // module on a GUI-launched app, and it used to name Homebrew, /usr/local
    // and nvm only. A Node installed without any of those -- the plain
    // user-level install -- puts `node` and `npx` in ~/.local/bin, which is
    // exactly where the operator's are, so the resolver answered null for a
    // tool sitting in plain sight and the video extension reported
    // `npx_hianyzik` with `blokkolt: ['render']`.
    //
    // HOME is redirected and the login shell is one that answers nothing, so
    // this asserts the directory list and not the machine running the suite,
    // and it never writes into the operator's own home.
    const out = runWithTempDataDir<{ found: string | null; expected: string }>(`
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'swarmclaw-home-'))
      process.env.HOME = home
      // A shell that finds nothing, so only the fallback list can answer.
      const shell = path.join(home, 'silent-shell')
      fs.writeFileSync(shell, '#!/bin/sh\\nexit 1\\n', { mode: 0o755 })
      process.env.SHELL = shell
      const localBin = path.join(home, '.local', 'bin')
      fs.mkdirSync(localBin, { recursive: true })
      const name = 'swarmclaw-local-bin-' + process.pid
      const expected = path.join(localBin, name)
      fs.writeFileSync(expected, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 })
      const mod = await import('@/lib/server/extensions/extension-binaries')
      const { resolveExtensionBinary } = mod.default || mod
      try {
        console.log(JSON.stringify({ found: resolveExtensionBinary(name), expected }))
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    `)
    assert.equal(out.found, out.expected, '~/.local/bin is not on the fallback list')
  })

  it('looks only where it says it looks, so a null is a real absence and not a filesystem walk that gave up', () => {
    const out = runWithTempDataDir<{ found: string | null }>(`
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const mod = await import('@/lib/server/extensions/extension-binaries')
      const { resolveExtensionBinary } = mod.default || mod
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-binaries-'))
      const name = 'swarmclaw-scratch-' + process.pid
      fs.writeFileSync(path.join(scratch, name), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 })
      try {
        console.log(JSON.stringify({ found: resolveExtensionBinary(name) }))
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
      }
    `)
    // The lookup is the login shell plus a fixed list of well-known
    // directories. An executable on neither is not found, and saying so here
    // stops a reader assuming the resolver searches everywhere.
    assert.equal(out.found, null)
  })
})

/**
 * An extension that captures `ctx.resolveBinary` in setup() and answers three
 * questions through its own rpc: is it a function at all, what does it say
 * about a command that exists, and what does it do with a name that is not a
 * command name. Written the way an extension author would write it.
 */
const PROBE_SOURCE = `
export const state = { resolveBinary: null }
export default {
  name: 'Binary Probe',
  setup(ctx) { state.resolveBinary = ctx.resolveBinary },
  rpc: {
    probe: async () => {
      if (typeof state.resolveBinary !== 'function') return { wired: false }
      let refusal = 'no throw'
      try { state.resolveBinary('sh; id') } catch (err) { refusal = String(err.message) }
      return {
        wired: true,
        sh: state.resolveBinary('sh'),
        missing: state.resolveBinary('swarmclaw-no-such-binary-' + process.pid),
        refusal,
      }
    },
  },
}
`

describe('the host hands resolveBinary to a loaded extension', () => {
  it('reaches an extension through setup(), resolves a real command and refuses a shell string', { skip: process.platform === 'win32' ? 'POSIX only' : false }, () => {
    const out = runWithTempDataDir<{ wired: boolean; sh: string | null; shExists: boolean; missing: string | null; refusal: string }>(`
      const fs = await import('node:fs')
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()
      await m.saveExtensionSource('probe.mjs', ${JSON.stringify(PROBE_SOURCE)})
      await m.reload()
      const answer = await m.getRpcHandler('probe.mjs', 'probe')({})
      console.log(JSON.stringify({ ...answer, shExists: typeof answer.sh === 'string' && fs.existsSync(answer.sh) }))
    `)
    // Wiring is the half a unit test of the resolver cannot see: a resolver
    // that works and is never put on the context leaves the packaged app
    // exactly as broken as it was.
    assert.equal(out.wired, true, 'ctx.resolveBinary did not reach the extension at all')
    assert.equal(typeof out.sh, 'string', 'sh did not resolve through the context')
    assert.equal(out.shExists, true, `resolved to a path that does not exist: ${out.sh}`)
    assert.equal(out.missing, null, 'an uninstalled command answered with a guess instead of null')
    assert.match(out.refusal, /^resolveBinary: /, `a shell string was not refused: ${out.refusal}`)
    assert.match(out.refusal, /not a plain command name/)
  })
})
