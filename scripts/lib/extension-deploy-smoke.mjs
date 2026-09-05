import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Runs one extension's deploy smoke against a server this module starts.
 *
 * `extensions/<id>/test/deploy.smoke.mjs` takes a server that is already
 * running and asks it the questions only a *loaded* extension can answer. What
 * it deliberately does not do is start one, because its whole point is to run
 * against the runtime the product ships. This module is the checkout's way to
 * provide that runtime, and the runtime is a parameter rather than a constant:
 * the same checks have to run against the standalone build under a modern
 * Node, against the desktop app's server under Electron's embedded Node, and
 * against the container image's Node, or "it works" means only "it works on a
 * developer's machine".
 *
 * That parameter is the whole reason this file exists. The `node` runtime and
 * the `electron` runtime differ in exactly four ways -- which binary runs
 * `server.js`, which directory it runs from (and therefore which
 * `node_modules`, and therefore which `better-sqlite3` ABI), and two
 * environment variables -- and everything else has to be identical, or a
 * difference in the harness gets mistaken for a difference in the deployment.
 *
 * The second of those variables is `SWARMCLAW_DEPLOY_MODE`, and it is worth
 * saying why a harness carries it at all. The desktop app sets it to `desktop`
 * in `electron/server-lifecycle.ts` and the container image bakes `vps` into
 * the `Dockerfile`; it decides which OAuth client pair the host reads
 * (`GOOGLE_OAUTH_CLIENT_DESKTOP_*` against `GOOGLE_OAUTH_CLIENT_WEB_*`) and
 * therefore what a page tells an operator to set. A harness that started the
 * app's own binary but left the variable unset would run the app's runtime
 * down the VPS branch and report it as the desktop deployment, which is a
 * harness that quietly does not test the thing it is named after. So a runtime
 * declares its mode, the server is started in it, and `deployMode` is handed
 * to the smoke as `SWARMCLAW_DEPLOY_EXPECT_MODE` so the smoke can require the
 * module to report the same one back.
 *
 * What a run does, in order:
 *
 *   1. requires the runtime's `server.js` to exist (nothing here builds; a
 *      caller builds once and every runtime reuses it);
 *   2. builds the extension's page bundle and installs the extension into a
 *      scratch data directory the way `scripts/install.mjs` does for an
 *      operator -- both under the host's own Node, because they are build
 *      steps, not the deployment under test -- preceded by any `companions`
 *      the caller named;
 *   3. starts the server on a free port with DATA_DIR, WORKSPACE_DIR and
 *      SWARMCLAW_HOME pointed at the scratch directory and a key minted for
 *      this run;
 *   4. runs the deploy smoke against it, with DATA_DIR set so its database
 *      steps run rather than being skipped;
 *   5. stops the server's whole process group and removes the scratch
 *      directory, whatever the outcome.
 *
 * The smoke itself runs under the host's Node, not the deployment's: it reads
 * the database with `node:sqlite`, which Electron 33's embedded Node 20.18 does
 * not have. That is sound because the file it opens was written by the
 * deployment's own SQLite build through the deployment's own driver, which is
 * the thing under test; the reader only has to be able to read it.
 *
 * The key is minted here, handed to the children through their environment,
 * and never printed or written anywhere but the environment. Nothing here
 * touches port 3456 or any real data directory.
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** How long to wait for a server to answer `/api/healthz` before giving up. */
const HEALTH_TIMEOUT_MS = 120_000

/**
 * The runtime a checkout can start with no preparation: the standalone build
 * `npm run build:ci` leaves in `.next/standalone`, run by the Node running
 * this script, from the repository root so it resolves the repository's
 * `node_modules`.
 */
export function standaloneNodeRuntime() {
  return {
    label: 'the built standalone server under this Node',
    command: process.execPath,
    args: [path.join(REPO_ROOT, '.next', 'standalone', 'server.js')],
    cwd: REPO_ROOT,
    // Deliberately no SWARMCLAW_DEPLOY_MODE: a bare server is the deployment
    // that sets nothing, and the host's rule is that `desktop` is chosen only
    // when asked for explicitly (`resolveGoogleDeployMode`). Leaving it unset
    // is what proves the default rather than restating it.
    env: {},
    deployMode: 'vps',
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function until(what, probe, timeoutMs, intervalMs = 500) {
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

export async function freePort() {
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

function startServer(runtime, port, scratch, accessKey) {
  const env = {
    ...process.env,
    ...runtime.env,
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
  // The harness owns SWARMCLAW_DEPLOY_MODE outright rather than letting the
  // shell it was launched from decide it. A runtime that names it in `env`
  // keeps that value; one that does not runs with the variable ABSENT, which
  // is a different claim from running with it set to `vps` -- the host resolves
  // `vps` from an unset variable, and it is that resolution the bare-server run
  // is there to exercise. An inherited value would make which branch was
  // exercised depend on the developer's shell.
  if (!runtime.env?.SWARMCLAW_DEPLOY_MODE) delete env.SWARMCLAW_DEPLOY_MODE

  // Its own process group, so stopping it takes any child it forks with it.
  const child = spawn(runtime.command, runtime.args, {
    cwd: runtime.cwd,
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

/**
 * Builds, installs and smoke-tests one extension against `runtime`.
 *
 * `extension` is the directory name under `extensions/`. `runtime` is a
 * descriptor from `standaloneNodeRuntime()` or from a caller that prepared a
 * different one; `label` is what the log calls it, and it is worth being exact
 * there, because the only thing separating a passing Electron run from a
 * passing Node run in a transcript is that sentence.
 *
 * `companions` are other extensions installed into the same scratch data
 * directory before this one, and they exist for exactly one situation: an
 * extension that reaches another through a CONTRACT. aisignal asks the host
 * for the `mailbox` contract gmail provides, and on a host where gmail is not
 * installed its health says `provider_missing` -- a true answer, and one that
 * exercises none of the wiring between the two modules. The container run
 * installs every extension into one data directory because that is what an
 * operator's host looks like, so without companions the same module would
 * report `ready` there and `provider_missing` here, and a reader comparing the
 * two deployments would be looking at a difference in the harness.
 */
export async function runExtensionDeploySmoke({ extension, runtime, companions = [] }) {
  const extRoot = path.join(REPO_ROOT, 'extensions', extension)
  const log = (message) => console.log(`[${extension} deploy-local] ${message}`)

  const serverEntry = runtime.args[runtime.args.length - 1]
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`${serverEntry} does not exist; run \`npm run build:ci\` first, this script tests a built server`)
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), `swarmclaw-${extension}-deploy-`))
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

  const runNode = (label, script, env) => {
    const result = spawnSync(process.execPath, [script], { cwd: path.dirname(script), env, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`${label} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
    }
    log(`${label}: ok`)
  }

  // NOTHING BELOW MAY RUN install.mjs WITHOUT DATA_DIR AND SWARMCLAW_HOME. An
  // install script with neither falls back to the operator's live desktop home
  // and migrates their database.
  const installEnv = { ...process.env, DATA_DIR: scratch.dataDir, SWARMCLAW_HOME: scratch.home }

  try {
    for (const companion of companions) {
      const companionRoot = path.join(REPO_ROOT, 'extensions', companion)
      runNode(`build the ${companion} bundle (companion)`, path.join(companionRoot, 'scripts', 'build.mjs'), process.env)
      runNode(`install ${companion} into the same scratch data directory (companion)`, path.join(companionRoot, 'scripts', 'install.mjs'), installEnv)
    }
    runNode('build the extension bundle', path.join(extRoot, 'scripts', 'build.mjs'), process.env)
    runNode(
      'install the extension into the scratch data directory',
      path.join(extRoot, 'scripts', 'install.mjs'),
      installEnv,
    )

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = startServer(runtime, port, scratch, accessKey)
    log(`starting ${runtime.label} on ${baseUrl}`)
    await waitForHealth(baseUrl, server.logs)
    log(`${runtime.label} is up`)

    const smoke = spawnSync(process.execPath, [path.join(extRoot, 'test', 'deploy.smoke.mjs')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SWARMCLAW_DEPLOY_BASE_URL: baseUrl,
        SWARMCLAW_DEPLOY_ACCESS_KEY: accessKey,
        DATA_DIR: scratch.dataDir,
        // What the runtime says it is, so the smoke can require the running
        // module to report the same thing rather than the harness assuming it.
        SWARMCLAW_DEPLOY_EXPECT_MODE: runtime.deployMode || '',
      },
      stdio: 'inherit',
    })
    if (smoke.status !== 0) {
      const tail = server.logs.slice(-40).join('\n')
      throw new Error(`the deploy smoke failed (exit ${smoke.status})${tail ? `\n\nserver log tail:\n${tail}` : ''}`)
    }
    log(`deploy smoke against ${runtime.label}: ok`)
  } finally {
    await cleanup()
  }
}
