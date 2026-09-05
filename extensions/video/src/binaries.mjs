/**
 * Where the external tools this module spawns actually live.
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
 * The host solves it on `ctx.resolveBinary`, which asks a login shell and then
 * the well-known install directories. This module cannot call the host's own
 * resolver directly -- an extension may not import from the host's `src/` --
 * so `index.mjs` puts the context function on `state.resolveBinary` and
 * everything here goes through it.
 *
 * WHAT A MISS DOES. When the host has no such surface (an older host than the
 * one this ships with) or the lookup finds nothing, the bare name is used
 * exactly as before. That is deliberate: turning "I could not find it" into a
 * refusal of its own would report a tool as missing on the strength of a
 * failed search, when the spawn may well succeed. The operating system's own
 * ENOENT stays the thing that decides, and `render_eszkoz_hianyzik` and the
 * `health` codes keep meaning what they meant.
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
 * `execFile` with the tool name resolved first.
 *
 * Wrapping the runner rather than every call site is what keeps the two
 * surfaces that probe the same tool -- `health`'s version probe and the
 * render's preflight -- asking about the same file. A test's double sees the
 * name unchanged, because a test leaves `state.resolveBinary` null.
 */
export function resolvingExecFile(state, execFileImpl) {
  return (name, args, options) => execFileImpl(binaryPath(state, name), args, options)
}

/** `spawn` with the tool name resolved first, by the same rule. */
export function resolvingSpawn(state, spawnImpl) {
  return (name, args, options) => spawnImpl(binaryPath(state, name), args, options)
}
