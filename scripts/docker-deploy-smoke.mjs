import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'

import { REPO_ROOT, freePort, until } from './lib/extension-deploy-smoke.mjs'

/**
 * `npm run test:deploy:docker` -- both extensions inside the Linux container
 * image, which is the other deployment the product ships.
 *
 * WHY THIS IS NOT THE SAME RUN AS THE OTHER TWO. The node and Electron runs
 * both start a server from this checkout and point the smoke at it from
 * outside. A container cannot be checked that way end to end, for one concrete
 * reason: step 6 of each smoke opens the server's SQLite database, and SQLite's
 * WAL locking does not survive a bind mount shared with a process on the host.
 * So the smoke runs *inside* the container, over `docker exec`, against
 * `127.0.0.1:3456` there -- the image carries Node 22, the extension sources and
 * their built `dist`, which is everything the script needs. The host still
 * waits on the published port, so the published port is proven too.
 *
 * WHAT THIS PROVES THAT THE OTHERS DO NOT. The image's `better-sqlite3` is
 * compiled during `docker build` against the image's own Node and glibc, not
 * rebuilt for Electron and not the developer machine's darwin build. The
 * extensions are installed by the same `scripts/install.mjs` an operator runs,
 * from the copy the `Dockerfile` puts in the image, into the container's
 * `/app/data` -- so the data directory's location and permissions are the
 * container's, not a developer's home.
 *
 * WHAT IT TOUCHES. It does not use `docker-compose.yml`: that file publishes
 * host port 3456 and bind-mounts `./data`, both of which would collide with a
 * running server and a real data directory. This builds its own tagged image,
 * runs one container on a free host port with no mounts, and removes both at
 * the end. Set SWARMCLAW_KEEP_IMAGE=1 to keep the image for a second run.
 *
 * Usage:
 *
 *   npm run test:deploy:docker
 */

const EXTENSIONS = ['tts', 'video']
const IMAGE = 'swarmclaw-deploy-smoke:local'
const CONTAINER = 'swarmclaw-deploy-smoke'
const CONTAINER_PORT = 3456
const CONTAINER_DATA_DIR = '/app/data'
const CONTAINER_HOME = '/app/data/home'
const HEALTH_TIMEOUT_MS = 180_000

function log(message) {
  console.log(`[docker deploy-local] ${message}`)
}

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options })
}

function dockerOrThrow(label, args, options = {}) {
  const result = docker(args, options)
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

/** Streams a long command's output rather than holding it, so a build is watchable. */
function dockerStreaming(label, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`))))
  })
}

function requireDaemon() {
  const result = docker(['info', '--format', '{{.ServerVersion}}'])
  if (result.status !== 0) {
    throw new Error(
      'no reachable Docker daemon; start Docker Desktop or OrbStack and re-run. '
      + `docker info said: ${result.stderr.trim() || result.stdout.trim()}`,
    )
  }
  return result.stdout.trim()
}

function removeContainer() {
  docker(['rm', '-f', CONTAINER])
}

async function waitForHealth(baseUrl) {
  await until(`${baseUrl}/api/healthz`, async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const res = await fetch(`${baseUrl}/api/healthz`, { signal: controller.signal })
      const body = await res.json().catch(() => null)
      return res.ok && body?.ok === true ? true : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }, HEALTH_TIMEOUT_MS, 1_000).catch((err) => {
    const logs = docker(['logs', '--tail', '40', CONTAINER])
    const tail = `${logs.stdout || ''}${logs.stderr || ''}`.trim()
    throw new Error(`${err.message}${tail ? `\n\ncontainer log tail:\n${tail}` : ''}`)
  })
}

async function main() {
  log(`Docker daemon: ${requireDaemon()}`)

  const accessKey = crypto.randomBytes(16).toString('hex')
  const credentialSecret = crypto.randomBytes(32).toString('hex')
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`

  const cleanup = () => {
    removeContainer()
    if (!process.env.SWARMCLAW_KEEP_IMAGE) docker(['image', 'rm', '-f', IMAGE])
  }
  process.once('SIGINT', () => { cleanup(); process.exit(130) })
  process.once('SIGTERM', () => { cleanup(); process.exit(143) })

  try {
    removeContainer()
    log(`building ${IMAGE} from ${REPO_ROOT}`)
    await dockerStreaming('docker build', ['build', '-t', IMAGE, '-f', path.join(REPO_ROOT, 'Dockerfile'), REPO_ROOT])

    // The extensions are installed before the server starts, exactly as the
    // node and Electron runs do it, so what the host reports is what it found
    // on boot rather than the result of a reload.
    const install = EXTENSIONS.map((extension) => `node extensions/${extension}/scripts/install.mjs`).join(' && ')
    log(`starting ${CONTAINER} on ${baseUrl} -> ${CONTAINER_PORT}`)
    dockerOrThrow('docker run', [
      'run', '-d', '--name', CONTAINER,
      '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`,
      '-e', `ACCESS_KEY=${accessKey}`,
      '-e', `CREDENTIAL_SECRET=${credentialSecret}`,
      '-e', `DATA_DIR=${CONTAINER_DATA_DIR}`,
      '-e', `SWARMCLAW_HOME=${CONTAINER_HOME}`,
      '-e', 'NEXT_TELEMETRY_DISABLED=1',
      '-e', 'SWARMCLAW_DAEMON_AUTOSTART=0',
      IMAGE,
      'sh', '-c', `${install} && node server.js`,
    ])

    await waitForHealth(baseUrl)
    log('the container is up and answering on the published port')

    for (const extension of EXTENSIONS) {
      log(`--- ${extension} ---`)
      const smoke = spawn('docker', [
        'exec',
        '-e', `SWARMCLAW_DEPLOY_BASE_URL=http://127.0.0.1:${CONTAINER_PORT}`,
        '-e', `SWARMCLAW_DEPLOY_ACCESS_KEY=${accessKey}`,
        '-e', `DATA_DIR=${CONTAINER_DATA_DIR}`,
        CONTAINER,
        'node', `extensions/${extension}/test/deploy.smoke.mjs`,
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      const code = await new Promise((resolve, reject) => {
        smoke.on('error', reject)
        smoke.on('exit', resolve)
      })
      if (code !== 0) {
        const logs = docker(['logs', '--tail', '40', CONTAINER])
        const tail = `${logs.stdout || ''}${logs.stderr || ''}`.trim()
        throw new Error(`the ${extension} deploy smoke failed inside the container (exit ${code})${tail ? `\n\ncontainer log tail:\n${tail}` : ''}`)
      }
      log(`deploy smoke against the container: ok (${extension})`)
    }
    log('both extensions pass inside the container image')
  } finally {
    cleanup()
  }
}

main().catch((err) => {
  console.error(`docker deploy smoke FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
