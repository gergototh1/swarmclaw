import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUN_DIR } from '@/lib/server/data-dir'

/**
 * The port file: how a process this server does not control (an extension's
 * stdio MCP shim, spawned by an agent) finds the server's HTTP port, which is
 * not fixed. The desktop app picks whatever port is free at launch, `next dev`
 * moves up when its port is taken, and the container pins 3456; the file
 * makes all three look the same to a reader.
 *
 * Contract, for the writer here and any reader elsewhere:
 *
 * What it contains: one JSON object, `{ port, wsPort, pid, startedAt }`, and a
 * trailing newline. `port` is the HTTP listener, `wsPort` the WebSocket hub,
 * `pid` the process that owns both, `startedAt` the wall-clock millisecond it
 * wrote the file. Nothing in it is secret: a local `ps` and `lsof` show the
 * same numbers.
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
 * nothing. First `readPortFile`, which rejects anything that is not the shape
 * above. Then `isPortFileLive`, which rules out the two cheap cases: the pid
 * names no process, or `startedAt` predates this boot (a reboot restarts pid
 * numbering, so an old pid matching a live process means nothing). Then a
 * request to `GET /api/healthz` on `port` whose body must report
 * `service: "swarmclaw"`; anything else is a reused pid and a stale file.
 * Only a file that passes all three names this server.
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
 * not the shape above with ports in 1..65535 and a positive pid. Extra keys
 * are dropped, not rejected, so a later writer can add fields without
 * breaking an older reader.
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
  const { port, wsPort, pid, startedAt } = parsed as Record<string, unknown>
  if (!isPort(port) || !isPort(wsPort)) return null
  if (!isWholeNumber(pid) || pid < 1) return null
  if (!isWholeNumber(startedAt)) return null
  return { port, wsPort, pid, startedAt }
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
