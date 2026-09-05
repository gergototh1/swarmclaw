import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveCliBinary } from '@/lib/providers/cli-utils'

/**
 * `ctx.resolveBinary` — how an extension finds an external command it shells
 * out to, on the runtime the product actually ships.
 *
 * WHY THIS EXISTS. An extension that spawns `ffprobe` by its bare name gets
 * whatever `PATH` the host process inherited. From a terminal that is the
 * operator's login `PATH` and everything works; from a packaged desktop app
 * launched by Finder or the Dock it is a short system `PATH` with no
 * `/opt/homebrew/bin` in it, so the spawn fails with ENOENT and the extension
 * reports a tool the operator can see with their own eyes as missing. The host
 * already solved this for CLI providers with `resolveCliBinary`
 * (`src/lib/providers/cli-utils.ts`), which asks a login shell first and falls
 * back to the well-known install directories; extensions cannot call it,
 * because they may not import from the host's `src/`. So the host hands the
 * capability over on the context instead.
 *
 * WHAT IT PROMISES. A non-null answer is a path that existed when the lookup
 * ran — nothing more. It is not a promise that the file is executable by this
 * process, that it is the version the caller wants, or that it will still be
 * there when the caller spawns it. A null answer means the lookup found
 * nothing; callers should still fall back to the bare name so the operating
 * system's own ENOENT is what surfaces, rather than turning "I could not find
 * it" into "it does not exist".
 *
 * WHAT IT COSTS, AND WHY AN EXTENSION MUST NOT CALL IT PER TOOL CALL. The
 * first step is a synchronous `spawnSync` of the operator's login shell
 * (`$SHELL -lc`, which sources their profile) for up to 2 seconds, on the
 * thread that calls it. In the server that is the thread running the HTTP
 * handlers, the WebSocket hub and the scheduler tick: a lookup that takes two
 * seconds stalls all three for two seconds. A negative answer is cached for
 * 30 seconds and a positive one for the same, so a binary that is not
 * installed is paid for again every half minute. There is no gate on this: it
 * is handed to every loaded extension, third-party ones included, and nothing
 * counts or throttles the calls. Resolve once per operation and hold the
 * answer for that operation; never once per item, and never in a loop.
 *
 * WHEN THE FALLBACK LIST IS REACHED. `resolveCliBinary` asks the login shell
 * first and uses the answer only when the shell gave an absolute path or the
 * name itself. A profile that prints anything to stdout makes that answer
 * unreadable, and `findBinaryOnPath` reports it as no answer, so the
 * directories below are what decide — which is the case this whole module exists for, since the
 * machine that has a short GUI PATH is the same machine whose profile is
 * where the operator's real PATH is set.
 *
 * WHAT IT REFUSES. The lookup's first step runs `command -v <name>` inside a
 * login shell, so the name reaches a shell string. Anything but a plain
 * command name is therefore refused by name and never quietly rewritten: no
 * path separators, no whitespace, no shell metacharacters, nothing over
 * `MAX_BINARY_NAME_LENGTH`. An extension that wants to run a binary at a known
 * absolute path does not need this function and can spawn the path directly.
 */

/** Long enough for any real command name; short enough that nothing large reaches the shell. */
const MAX_BINARY_NAME_LENGTH = 64

/**
 * A plain command name: starts alphanumeric, then alphanumerics and the four
 * punctuation characters real binaries use (`ffmpeg`, `python3.12`,
 * `cursor-agent`, `g++`). Every shell metacharacter, the path separators and
 * every whitespace character are outside it, which is the property that makes
 * passing the name to a login shell safe.
 */
const BINARY_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/**
 * Where a POSIX machine keeps binaries a GUI-launched process's `PATH` misses:
 * the two Homebrew prefixes, the two `/usr/local` ones, the system pair, and
 * the two a user-level install writes to without root -- `~/.local/bin`, where
 * a Node installed without Homebrew or nvm lands, and `~/.npm-global/bin`.
 * `resolveCliBinary` adds every nvm Node version on top of these, which is what
 * finds `npx` when Node came from nvm.
 *
 * A path from this list is where the file is, which is not the same as a tool
 * that runs: `npx` is a `#!/usr/bin/env node` script, so its interpreter has to
 * be findable too. That is the caller's business and not this list's -- see
 * WHAT IT PROMISES above, and `extensions/video/src/binaries.mjs` for a caller
 * that puts the resolved directory on the child's `PATH` for exactly this
 * reason.
 *
 * Empty on Windows: these are POSIX paths, and `resolveCliBinary` probes
 * `where` there, which reads the process `PATH` the same way a shell would.
 */
function commonBinaryDirectories(): string[] {
  if (process.platform === 'win32') return []
  const home = os.homedir()
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
  ]
}

/** The message a refused name gets, naming the name and the rule it broke. */
function refusalMessage(name: unknown): string | null {
  if (typeof name !== 'string') return `resolveBinary: name must be a string, got ${typeof name}`
  if (name.length === 0) return 'resolveBinary: name must not be empty'
  if (name.length > MAX_BINARY_NAME_LENGTH) return `resolveBinary: name must be at most ${MAX_BINARY_NAME_LENGTH} characters, got ${name.length}`
  if (!BINARY_NAME.test(name)) return `resolveBinary: "${name}" is not a plain command name (letters, digits, and . _ + - only; no path separators and no shell characters)`
  return null
}

/**
 * The resolver handed to one extension. It carries no extension state — the id
 * is not used for the lookup — but it is built per extension so a later change
 * that does scope lookups (to a manifest's declared commands, say) has a place
 * to put it without changing the shape extensions call.
 */
export function createExtensionBinaryResolver(): (name: string) => string | null {
  return (name: string) => resolveExtensionBinary(name)
}

/**
 * The lookup itself, exported so the host's own tests can drive it without a
 * loaded extension.
 *
 * Throws on a name it will not put in front of a shell; returns null when the
 * lookup simply found nothing.
 */
export function resolveExtensionBinary(name: string): string | null {
  const refusal = refusalMessage(name)
  if (refusal) throw new TypeError(refusal)

  const fallbacks = commonBinaryDirectories().map((dir) => path.join(dir, name))
  const found = resolveCliBinary(name, fallbacks)
  if (!found) return null
  // `command -v` answers with a path it just found; a fallback entry was
  // checked with existsSync before being returned. Neither is a promise the
  // file is still there, so the last look is here rather than in the caller.
  return fs.existsSync(found) ? found : null
}
