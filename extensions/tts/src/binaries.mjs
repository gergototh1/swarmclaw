/**
 * Where the external tool this module spawns actually lives.
 *
 * THE DEFECT THIS CLOSES. The duration probe names its tool by the bare word
 * `ffprobe` and lets the operating system search `PATH`. That works from a
 * terminal, where the host inherited the operator's login `PATH`. It does not
 * work in the packaged desktop app: a process launched from the Dock or Finder
 * gets a short system `PATH` with no `/opt/homebrew/bin` in it, so a Homebrew
 * ffprobe is invisible, the spawn fails with ENOENT, and every synthesis is
 * refused with `tts_hossz_meres_sikertelen` on a machine that has ffprobe
 * installed. Same class as the ESM loader defect: perfect in development,
 * silently broken in the shipped app.
 *
 * The host solves it on `ctx.resolveBinary`, which asks a login shell and then
 * the well-known install directories. This module cannot call the host's own
 * resolver directly -- an extension may not import from the host's `src/` --
 * so `index.mjs` puts the context function on `state.resolveBinary` and the
 * probe goes through it.
 *
 * WHAT A MISS DOES. When the host has no such surface (an older host than the
 * one this ships with) or the lookup finds nothing, the bare name is used
 * exactly as before, and the operating system's own ENOENT stays the thing
 * that decides. `probeFailureReason` keeps meaning what it meant.
 *
 * WHAT IT NEVER DOES. The name is a literal in this module's own source, never
 * a caller's, a setting's or a model's. The host refuses anything that is not
 * a plain command name by throwing, and that throw is not caught here, because
 * in this module it could only mean a name typed wrong in this repository.
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
 * Wrapping the runner rather than the call site keeps the two probe call sites
 * -- the synthesizer's own and the cache import's -- asking about the same
 * file. A test's double sees the name unchanged, because a test leaves
 * `state.resolveBinary` null.
 */
export function resolvingExecFile(state, execFileImpl) {
  return (name, args, options) => execFileImpl(binaryPath(state, name), args, options)
}
