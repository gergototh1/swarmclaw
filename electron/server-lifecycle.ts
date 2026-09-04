import { ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { RuntimePaths } from './paths'
import { findFreePort } from './free-port'

const DEFAULT_PORT = 3456
const HEALTH_PATH = '/api/healthz'
const READY_TIMEOUT_MS = 300_000
const POLL_INTERVAL_MS = 250
const SHUTDOWN_GRACE_MS = 5_000
const LOG_MAX_BYTES = 1_048_576

export interface ServerHandle {
  url: string
  port: number
  wsPort: number
  process: ChildProcess
  stop: () => Promise<void>
}

export interface StartOptions {
  paths: RuntimePaths
  logFile?: string
  onStderr?: (chunk: string) => void
  onStdout?: (chunk: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

export async function startEmbeddedServer(opts: StartOptions): Promise<ServerHandle> {
  const port = await findFreePort(DEFAULT_PORT)
  const wsPort = await findFreePort(port + 1)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    WS_PORT: String(wsPort),
    HOSTNAME: '127.0.0.1',
    SWARMCLAW_HOME: opts.paths.swarmclawHome,
    DATA_DIR: opts.paths.dataDir,
    WORKSPACE_DIR: opts.paths.workspaceDir,
    BROWSER_PROFILES_DIR: opts.paths.browserProfilesDir,
    // The port above is whatever was free this launch, so no fixed redirect URI
    // exists to register with Google. This tells the OAuth code to use the
    // "Desktop app" client pair, whose loopback redirect URIs match on host
    // alone and ignore the port.
    SWARMCLAW_DEPLOY_MODE: 'desktop',
    ELECTRON_RUN_AS_NODE: '1',
  }
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  const logStream = opts.logFile ? openLogStream(opts.logFile) : null

  const child = spawn(process.execPath, [opts.paths.standaloneEntry], {
    cwd: path.dirname(opts.paths.standaloneEntry),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (c: string) => {
    logStream?.write(c)
    opts.onStdout?.(c)
  })
  child.stderr?.on('data', (c: string) => {
    logStream?.write(c)
    opts.onStderr?.(c)
  })
  child.on('exit', (code, signal) => {
    logStream?.end(`\n[swarmclaw] server exited code=${code ?? 'null'} signal=${signal ?? 'none'}\n`)
    opts.onExit?.(code, signal)
  })

  const url = `http://127.0.0.1:${port}`
  await waitForReady(url, child)

  return {
    url,
    port,
    wsPort,
    process: child,
    stop: () => stopServer(child),
  }
}

function openLogStream(logFile: string): fs.WriteStream {
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  try {
    const stat = fs.statSync(logFile)
    if (stat.size > LOG_MAX_BYTES) fs.truncateSync(logFile, 0)
  } catch {
    // file did not exist — will be created on first write
  }
  const stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' })
  stream.write(`\n[swarmclaw] --- server launch ${new Date().toISOString()} ---\n`)
  return stream
}

export function tailLogFile(logFile: string, bytes = 4096): string {
  try {
    const fd = fs.openSync(logFile, 'r')
    try {
      const stat = fs.fstatSync(fd)
      const toRead = Math.min(bytes, stat.size)
      const buf = Buffer.alloc(toRead)
      fs.readSync(fd, buf, 0, toRead, stat.size - toRead)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

async function waitForReady(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  const healthUrl = `${url}${HEALTH_PATH}`

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`standalone server exited with code ${child.exitCode} before becoming ready`)
    }
    const ok = await probe(healthUrl).catch(() => false)
    if (ok) return
    await wait(POLL_INTERVAL_MS)
  }
  throw new Error(`standalone server did not become ready within ${READY_TIMEOUT_MS}ms`)
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve((res.statusCode ?? 0) < 500)
    })
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve()
      return
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, SHUTDOWN_GRACE_MS)

    child.once('exit', () => {
      clearTimeout(killTimer)
      resolve()
    })

    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(killTimer)
      resolve()
    }
  })
}
