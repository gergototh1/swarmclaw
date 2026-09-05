import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Runs the tts extension deploy smoke against the BUILT server, from a checkout.
 *
 * `extensions/tts/test/deploy.smoke.mjs` takes a server that is already
 * running and asks it the questions only a loaded extension can answer. What
 * it does not do is start one, because its whole point is to run against the
 * runtime the product ships: the desktop app, the container, or a `next
 * build` output. This script is the checkout's way to provide that runtime.
 * It is the only guard for a class of defect no unit test can see -- webpack
 * rewriting `createRequire(<expr>)` to `undefined` silently disabled every
 * external extension in the production build while `next dev` loaded them
 * fine -- and it can only see it by running the webpack output.
 *
 * What it does, in order:
 *
 *   1. requires `.next/standalone/server.js` to exist (`npm run build:ci`
 *      produces it; this script does not build, so a CI step can build once
 *      and both the type-check and this can use it);
 *   2. builds the extension's page bundle and installs the extension into a
 *      scratch data directory the way `scripts/install.mjs` does for an
 *      operator;
 *   3. starts the standalone server on a free port with DATA_DIR,
 *      WORKSPACE_DIR and SWARMCLAW_HOME pointed at the scratch directory and a
 *      key minted for this run;
 *   4. runs the deploy smoke against it, with DATA_DIR set so its database
 *      steps run rather than being skipped;
 *   5. stops the server's whole process group and removes the scratch
 *      directory, whatever the outcome.
 *
 * The key is minted here, handed to the two children through their
 * environment, and never printed or written anywhere but the environment.
 * Nothing here touches port 3456 or any real data directory.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT_ROOT = path.join(REPO_ROOT, 'extensions', 'tts')
const STANDALONE_SERVER = path.join(REPO_ROOT, '.next', 'standalone', 'server.js')
const HEALTH_TIMEOUT_MS = 120_000

function log(message) {
  console.log(`[tts deploy-local] ${message}`)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(what, probe, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== undefined) return value
    } catch (err) {
      lastError = err
    }
    await wait(intervalMs)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${detail}`)
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(address.port)
        else reject(new Error('could not allocate a free port'))
      })
    })
  })
}

function runNode(label, script, env, cwd = path.dirname(script)) {
  const result = spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  log(`${label}: ok`)
}

function startServer(port, scratch, accessKey) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    ACCESS_KEY: accessKey,
    CREDENTIAL_SECRET: process.env.CREDENTIAL_SECRET || crypto.randomBytes(32).toString('hex'),
    DATA_DIR: scratch.dataDir,
    WORKSPACE_DIR: path.join(scratch.root, 'workspace'),
    SWARMCLAW_HOME: scratch.home,
    BROWSER_PROFILES_DIR: path.join(scratch.root, 'browser-profiles'),
    NEXT_TELEMETRY_DISABLED: '1',
    SWARMCLAW_DAEMON_AUTOSTART: '0',
  }
  // Its own process group, so stopping it takes any child it forks with it.
  const child = spawn(process.execPath, [STANDALONE_SERVER], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const logs = []
  const record = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      logs.push(line)
      if (logs.length > 200) logs.shift()
    }
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  return { child, logs }
}

function signalServer(server, signal) {
  try {
    if (process.platform !== 'win32') process.kill(-server.child.pid, signal)
    else server.child.kill(signal)
  } catch {
    // Already gone.
  }
}

function groupAlive(server) {
  try {
    if (process.platform !== 'win32') process.kill(-server.child.pid, 0)
    else process.kill(server.child.pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopServer(server) {
  if (!server) return
  signalServer(server, 'SIGTERM')
  const gone = await until('the server process group to exit', () => (groupAlive(server) ? undefined : true), 10_000, 100).catch(() => false)
  if (gone === false) {
    signalServer(server, 'SIGKILL')
    await until('the server process group to die', () => (groupAlive(server) ? undefined : true), 5_000, 100)
  }
}

async function waitForHealth(baseUrl, logs) {
  await until(`${baseUrl}/api/healthz`, async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const res = await fetch(`${baseUrl}/api/healthz`, { signal: controller.signal })
      const body = await res.json().catch(() => null)
      return res.ok && body?.ok === true ? true : undefined
    } finally {
      clearTimeout(timer)
    }
  }, HEALTH_TIMEOUT_MS, 1_000).catch((err) => {
    const tail = logs.slice(-40).join('\n')
    throw new Error(`${err.message}${tail ? `\n\nserver log tail:\n${tail}` : ''}`)
  })
}

async function main() {
  if (!fs.existsSync(STANDALONE_SERVER)) {
    throw new Error(`${STANDALONE_SERVER} does not exist; run \`npm run build:ci\` first, this script tests the built server`)
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-tts-deploy-'))
  const scratch = { root, dataDir: path.join(root, 'data'), home: path.join(root, 'home') }
  for (const dir of ['data', 'workspace', 'browser-profiles', 'home']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  const accessKey = crypto.randomBytes(16).toString('hex')
  let server = null

  const cleanup = async () => {
    await stopServer(server)
    fs.rmSync(root, { recursive: true, force: true })
  }
  process.once('SIGINT', () => { void cleanup().then(() => process.exit(130)) })
  process.once('SIGTERM', () => { void cleanup().then(() => process.exit(143)) })

  try {
    runNode('build the extension bundle', path.join(EXT_ROOT, 'scripts', 'build.mjs'), process.env)
    runNode(
      'install the extension into the scratch data directory',
      path.join(EXT_ROOT, 'scripts', 'install.mjs'),
      { ...process.env, DATA_DIR: scratch.dataDir, SWARMCLAW_HOME: scratch.home },
    )

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = startServer(port, scratch, accessKey)
    log(`starting the built server on ${baseUrl}`)
    await waitForHealth(baseUrl, server.logs)
    log('the built server is up')

    const smoke = spawnSync(process.execPath, [path.join(EXT_ROOT, 'test', 'deploy.smoke.mjs')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SWARMCLAW_DEPLOY_BASE_URL: baseUrl,
        SWARMCLAW_DEPLOY_ACCESS_KEY: accessKey,
        DATA_DIR: scratch.dataDir,
      },
      stdio: 'inherit',
    })
    if (smoke.status !== 0) {
      const tail = server.logs.slice(-40).join('\n')
      throw new Error(`the deploy smoke failed (exit ${smoke.status})${tail ? `\n\nserver log tail:\n${tail}` : ''}`)
    }
    log('deploy smoke against the built server: ok')
  } finally {
    await cleanup()
  }
}

main().catch((err) => {
  console.error(`tts deploy smoke FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
