import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUN_DIR } from '@/lib/server/data-dir'

/**
 * The port file: how a process this server does not control (an extension's
 * stdio MCP shim, spawned by an agent) finds the server's HTTP port. The port
 * is fixed per launch but differs between launches, and only the launcher
 * knows it: the desktop app picks whatever port is free at start and passes
 * it as `PORT`, the container pins 3456 in its `Dockerfile`, and `npm run
 * dev` pins 3456 with `-p`. Next moves to another port only when the port
 * came from its own default (`allowRetry = portSource === 'default'` in
 * `next/dist/cli/next-dev.js`); with `-p` or `PORT`, as here, a taken port is
 * an EADDRINUSE exit, not a move. The file hands the launcher's choice to a
 * process the launcher never told.
 *
 * Contract, for the writer here and any reader elsewhere. The reader that
 * matters is a separate process: an extension's shim is a plain `.mjs` that
 * cannot import this module, so it re-implements every check below itself,
 * and one it leaves out is a check nobody makes. A reader that stops after
 * the pid check accepts a reused pid and sends an agent's requests to whatever
 * program listens on the port now.
 *
 * What it contains: one JSON object, `{ port, wsPort, pid, startedAt,
 * instanceId }`, and a trailing newline. `port` is the HTTP listener, `wsPort`
 * the WebSocket hub, `pid` the process that owns both, `startedAt` the
 * wall-clock millisecond it wrote the file, and `instanceId` a random token
 * this process minted at boot (`serverInstanceId`). Nothing in it is secret: a
 * local `ps` and `lsof` show the same numbers, and `/api/healthz` hands the
 * token to anyone who asks, which is what makes it usable as a comparison.
 *
 * When it is written: once per server boot, from the instrumentation hook,
 * after Next has bound the HTTP listener (Next stores the port it actually
 * bound in `process.env.PORT` from the listening callback, and runs the hook
 * after that). The WebSocket hub is created in the same tick as the write and
 * may still be binding when the file lands. A reader that gets ECONNREFUSED
 * on a port from a fresh file should retry for a moment before concluding
 * anything. A worker-only process (`SWARMCLAW_WORKER_ONLY=1`) writes nothing:
 * it is not the server an agent should talk to.
 *
 * When it is removed: on SIGTERM and SIGINT, and from the process `exit` hook
 * for exits that skip the graceful path (an uncaught exception, Next giving
 * up on a listen error). Removal is by the owner only: a process unlinks the
 * file when the pid inside is its own, so a server shutting down after a
 * newer one wrote the file leaves the newer one's file alone. The check and
 * the unlink are two steps; a server that starts in the microseconds between
 * them can lose its file, and rewrites nothing, because nothing tells it.
 * SIGKILL, a crash, and a power cut remove nothing: a stale file stays behind.
 *
 * What a reader must do about a stale file: a file left by a dead server can
 * name a port that a different program now owns, so the file alone proves
 * nothing. Three checks, all three required, in this order:
 *
 *   1. Shape. Parse the file and reject anything that is not the object
 *      above with `port` and `wsPort` in 1..65535 and `pid` a positive
 *      integer; `readPortFile` here is the reference.
 *   2. Boot time and pid. Reject a `startedAt` earlier than this boot
 *      (`Date.now() - os.uptime() * 1000`, less a tolerance for a clock
 *      correction; a reboot restarts pid numbering, so an old pid matching a
 *      live process means nothing), then reject a pid no process has
 *      (`process.kill(pid, 0)`; EPERM means it exists and belongs to another
 *      user, which still counts as alive). `isPortFileLive` here is the
 *      reference. A reader that checks only the pid has skipped half of this.
 *   3. Service. `GET /api/healthz` on `port` must answer with a JSON body
 *      whose `service` is `"swarmclaw"` (src/app/api/healthz/route.ts);
 *      anything else, including a connection refused that persists past the
 *      retry noted above, is a reused pid and a stale file.
 *   4. Identity. That same body's `instanceId` must equal the file's. Check 3
 *      says a SwarmClaw is listening there; it does not say WHICH, and after a
 *      SIGKILL, a pid reused inside one boot and a second instance -- another
 *      home, another database, another provider key -- taking that port, all
 *      of 1, 2 and 3 pass on a file the second instance never wrote. A reader
 *      that stops at 3 then sends its request to the wrong server: for the tts
 *      extension's shim that is a paid synthesis on the wrong key, against the
 *      wrong daily counter, written into the wrong instance's directory. A
 *      body with no `instanceId`, or a different one, is not this server.
 *
 * Only a file that passes all four names this server. Checks 1 and 2 are
 * the cheap ones and exist so a reader rarely reaches the request; they do not
 * replace it, because within one boot a pid can be reused after the server
 * dies.
 *
 * Two servers on one home: the file names whichever wrote it last. Two
 * servers sharing one `SWARMCLAW_HOME` also share one data directory, which
 * nothing here supports; the owner-only removal keeps the newer server's
 * file intact when the older one exits, and that is all it does.
 *
 * Permissions: the run directory is created 0700 and the file 0600 (both
 * subject to umask, both only when created; an existing directory keeps its
 * mode). The reason is not secrecy but authority: whoever can write this
 * file decides which port the shim sends its requests to. A reader should
 * trust a port file only where it trusts the directory it sits in.
 */
export const PORT_FILE = path.join(RUN_DIR, 'port.json')

export interface PortFile {
  port: number
  wsPort: number
  pid: number
  startedAt: number
  /** This server process's random boot token; `/api/healthz` returns the same value. */
  instanceId: string
}

/**
 * How far before the estimated boot instant `startedAt` may fall and still
 * count as this boot. The estimate is `Date.now() - os.uptime()`, and on
 * Linux uptime is monotonic, so a wall-clock step after boot moves the
 * estimate by the size of the step. Sixty seconds absorbs a clock correction
 * at the cost of missing a server that started within a minute of the reboot
 * that killed it; the healthz check downstream is what catches that.
 */
const BOOT_TOLERANCE_MS = 60_000

/**
 * Writes the file atomically: a reader that opens it mid-write sees either the
 * previous content or the new one, never a truncated JSON. That is what the
 * rename buys; the temp name carries the pid so two processes writing at once
 * do not share it. Durability is not promised: a power cut before the data
 * reaches disk can leave an empty or partial file, which `readPortFile`
 * treats as absent. On Windows the rename fails while another process holds
 * the file open; the caller logs that and the previous content stays.
 */
export function writePortFile(info: PortFile, file: string = PORT_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // The write failure is the one worth reporting; a leftover temp file is not.
    }
    throw err
  }
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPort(value: unknown): value is number {
  return isWholeNumber(value) && value >= 1 && value <= 65535
}

/**
 * The file's content, or null when it is missing, unreadable, not JSON, or
 * not the shape above with ports in 1..65535, a positive pid and a non-empty
 * instance token. Extra keys are dropped, not rejected, so a later writer can
 * add fields without breaking an older reader.
 */
export function readPortFile(file: string = PORT_FILE): PortFile | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { port, wsPort, pid, startedAt, instanceId } = parsed as Record<string, unknown>
  if (!isPort(port) || !isPort(wsPort)) return null
  if (!isWholeNumber(pid) || pid < 1) return null
  if (!isWholeNumber(startedAt)) return null
  // A file with no token cannot be checked against the server on the port, and
  // a reader that accepted it would be back to trusting the pid. It is refused
  // here rather than downgraded to the weaker check.
  if (typeof instanceId !== 'string' || instanceId.length === 0) return null
  return { port, wsPort, pid, startedAt, instanceId }
}

/**
 * False when the file is provably stale; true when these checks cannot tell.
 * Stale for sure: `startedAt` falls before this boot (minus the tolerance
 * above), or no process has the pid. Signal 0 delivers nothing and only asks
 * whether the pid exists; EPERM means it exists and belongs to another user,
 * which still answers yes. A zombie also answers yes.
 *
 * True therefore means "some process has this pid and it started after this
 * boot", not "that process is a SwarmClaw server": within one boot a pid can
 * be reused after the server dies, and a container that restarts keeps the
 * host's uptime while its pids start over. The reader that cares follows up
 * with a request to `/api/healthz`, as the contract above says.
 */
export function isPortFileLive(info: PortFile): boolean {
  if (info.pid < 1) return false
  const bootAt = Date.now() - os.uptime() * 1000
  if (info.startedAt < bootAt - BOOT_TOLERANCE_MS) return false
  try {
    process.kill(info.pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes the file when the pid inside is this process's own; a file that is
 * missing, malformed, or another process's is left as it is. Safe to call
 * more than once and from an `exit` handler: it is synchronous and never
 * throws.
 */
export function removePortFile(file: string = PORT_FILE): void {
  const current = readPortFile(file)
  if (!current || current.pid !== process.pid) return
  try {
    fs.unlinkSync(file)
  } catch {
    // Already gone; nothing to undo.
  }
}
