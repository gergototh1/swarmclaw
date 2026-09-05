import path from 'node:path'

/**
 * Where the external tools this module spawns actually live, and where their
 * interpreters live.
 *
 * THE DEFECT THIS CLOSES. Every call in this module names its tool by the bare
 * word -- `ffprobe`, `ffmpeg`, `npx` -- and lets the operating system search
 * `PATH`. That works from a terminal, where the host inherited the operator's
 * login `PATH`. It does not work in the packaged desktop app: a process
 * launched from the Dock or Finder gets a short system `PATH` with no
 * `/opt/homebrew/bin` and no nvm directory in it, so a Homebrew ffmpeg and an
 * nvm npx are both invisible, the spawn fails with ENOENT, and the module
 * reports as missing three tools the operator can see with their own eyes.
 * Same class as the ESM loader defect: perfect in development, silently broken
 * in the shipped app.
 *
 * The host solves the *name* on `ctx.resolveBinary`, which asks a login shell
 * and then the well-known install directories. This module cannot call the
 * host's own resolver directly -- an extension may not import from the host's
 * `src/` -- so `index.mjs` puts the context function on `state.resolveBinary`
 * and everything here goes through it.
 *
 * WHY A RESOLVED PATH IS NOT YET A RUNNING TOOL. `npx` is not a program; it is
 * a text file beginning `#!/usr/bin/env node`. Handing the kernel its absolute
 * path only moves the search one step: `env` then looks for `node` on the
 * child's `PATH`, which is the same short GUI `PATH` that could not find `npx`
 * in the first place, and the spawn fails with the interpreter's name instead
 * of the tool's. Measured on the operator's machine, where `npx` and the `node`
 * it needs both live in `~/.local/bin`: the host resolved
 * `/Users/.../.local/bin/npx` correctly and the version probe still failed, so
 * `health` reported `npx_hianyzik` and `blokkolt: ['render']` for a tool that
 * was installed and findable.
 *
 * So a resolved name also carries its own directory onto the child's `PATH`,
 * at the front. That directory is where the tool was found, which on every
 * layout this resolver knows about -- Homebrew, nvm, a user-level
 * `~/.local/bin` install -- is also where the `node` that tool was installed
 * beside lives. Nothing is prepended when the host resolved nothing, so a
 * machine that worked before works exactly as it did.
 *
 * WHAT A MISS DOES. When the host has no such surface (an older host than the
 * one this ships with) or the lookup finds nothing, the bare name is used
 * exactly as before, with the environment untouched. That is deliberate:
 * turning "I could not find it" into a refusal of its own would report a tool
 * as missing on the strength of a failed search, when the spawn may well
 * succeed. The operating system's own ENOENT stays the thing that decides, and
 * `render_eszkoz_hianyzik` and the `health` codes keep meaning what they meant.
 *
 * WHAT IT COSTS. Exactly one `state.resolveBinary` call per spawn, the same as
 * before: the path and the environment are computed from a single answer.
 * `ctx.resolveBinary`'s first step is a synchronous login-shell spawn on the
 * host's main thread, so a second lookup per spawn would be a real cost, not a
 * tidiness question.
 *
 * WHAT IT NEVER DOES. Nothing here takes a name from a caller, a setting, a
 * model or a row: the three names are literals in this module's own source.
 * The host refuses anything that is not a plain command name by throwing, and
 * that throw is not caught here, because in this module it could only mean a
 * name typed wrong in this repository.
 */

/** The tool's path when the host found one, and the bare name when it did not. */
export function binaryPath(state, name) {
  const resolve = state?.resolveBinary
  if (typeof resolve !== 'function') return name
  const found = resolve(name)
  return typeof found === 'string' && found.length > 0 ? found : name
}

/**
 * The environment's `PATH` key as it is actually spelled, because Windows
 * spells it `Path` and a second key would be ignored there.
 */
function pathKeyOf(env) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') return key
  return 'PATH'
}

/**
 * The caller's spawn options, with the resolved tool's own directory at the
 * front of the child's `PATH`.
 *
 * Returns the caller's own object untouched when nothing was resolved, so the
 * child keeps inheriting the parent environment rather than a copy of it.
 * Otherwise the base is the caller's `env` when it passed one and the parent's
 * environment when it did not, which is what the child would have inherited
 * anyway.
 */
export function spawnOptionsFor(command, name, options) {
  if (command === name) return options
  const base = options?.env || process.env
  const key = pathKeyOf(base)
  const current = typeof base[key] === 'string' ? base[key] : ''
  const dir = path.dirname(command)
  return { ...options, env: { ...base, [key]: current ? `${dir}${path.delimiter}${current}` : dir } }
}

/**
 * `execFile` with the tool name resolved first, and the resolved tool's
 * directory on the child's `PATH`.
 *
 * Wrapping the runner rather than every call site is what keeps the two
 * surfaces that probe the same tool -- `health`'s version probe and the
 * render's preflight -- asking about the same file and running it under the
 * same environment. A test's double sees the name unchanged and the options
 * unchanged, because a test leaves `state.resolveBinary` null.
 */
export function resolvingExecFile(state, execFileImpl) {
  return (name, args, options) => {
    const command = binaryPath(state, name)
    return execFileImpl(command, args, spawnOptionsFor(command, name, options))
  }
}

/** `spawn` with the tool name resolved first, by the same rule. */
export function resolvingSpawn(state, spawnImpl) {
  return (name, args, options) => {
    const command = binaryPath(state, name)
    return spawnImpl(command, args, spawnOptionsFor(command, name, options))
  }
}
