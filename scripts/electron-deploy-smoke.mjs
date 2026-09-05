import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { REPO_ROOT, runExtensionDeploySmoke } from './lib/extension-deploy-smoke.mjs'

/**
 * `npm run test:deploy:electron` -- every extension the product ships, against
 * the desktop app's own server, run by the app's own Electron binary.
 *
 * WHY A SEPARATE RUN EXISTS AT ALL. The desktop app and the Linux container
 * ship the same host code on two different runtimes, and the differences are
 * not cosmetic:
 *
 *   - Electron 33 embeds Node 20.18.3, a server or container runs Node 22.
 *     `require(esm)` arrived in Node 20.19, so a loader that reaches an ESM
 *     extension through `require` loads it on one and raises ERR_REQUIRE_ESM on
 *     the other. That is not hypothetical on this branch: it is how the
 *     aisignal extension turned out never to have loaded in the desktop app,
 *     discovered last, after everything had been built on it.
 *   - `better-sqlite3` is a native module. The app's copy is rebuilt against
 *     Electron's ABI at packaging time (NODE_MODULE_VERSION 130 for Electron
 *     33) and will not load under a plain Node 22, and the reverse. Every
 *     migration an extension declares runs through that module.
 *
 * Neither shows up in a unit suite, and neither shows up in `/api/extensions`
 * either: the host reports an external extension file as `enabled: true`
 * whether or not it ever loaded. Only asking the running host something that
 * requires the module to have been evaluated separates the two, which is what
 * `extensions/<id>/test/deploy.smoke.mjs` does and what this script points at
 * the app.
 *
 * WHAT THIS RUNS, AND WHAT IT DOES NOT. It runs the shipped app's Electron
 * binary in `ELECTRON_RUN_AS_NODE` mode over the app's `server.js`, from the
 * app's own `standalone` directory, so the Node version, the `node_modules`
 * and the native ABI are the deployment's. It does not build an installer and
 * it does not run `@electron/rebuild`: it uses an app someone already
 * packaged. So it proves that the code in this checkout loads and works on the
 * packaged runtime; it does not prove that the *next* package will be built
 * correctly. A release still has to be packaged and this run repeated against
 * the artifact.
 *
 * WHAT IT TOUCHES. Nothing of the operator's. The app is cloned to a scratch
 * directory (APFS `clonefile`, so the copy is near-instant and costs no disk),
 * this checkout's fresh `.next` and `server.js` are laid over the clone, the
 * clone is re-signed ad hoc, and the clone is deleted at the end. The
 * installed app is only ever read. Each extension gets its own scratch data
 * directory and its own key on its own free port; port 3456 and the real data
 * directory are never touched.
 *
 * TWO THINGS TO VERIFY, AND THE FLAG THAT PICKS ONE. By default this checkout's
 * `.next` and `server.js` are laid over the copy, which answers "does the code
 * I am about to ship run on the packaged runtime". Before a release the other
 * question matters more -- "does the artifact I just built work as built" --
 * and `SWARMCLAW_ELECTRON_NO_OVERLAY=1` asks that one instead, leaving the
 * bundle's own server in place. Run both: the first can pass on an artifact
 * whose own build is broken, the second on a stale artifact.
 *
 * Usage:
 *
 *   npm run build:ci
 *   npm run test:deploy:electron            # finds the app in the usual places
 *   SWARMCLAW_ELECTRON_APP=/path/SwarmClaw.app npm run test:deploy:electron
 *   SWARMCLAW_ELECTRON_APP=dist/mac/SwarmClaw.app SWARMCLAW_ELECTRON_NO_OVERLAY=1 \
 *     npm run test:deploy:electron          # the release artifact, as built
 */

/**
 * Every extension the product ships, in the order an operator installs them.
 *
 * `gmail` and `aisignal` are last because they are the pair this list exists
 * for. The gmail module is the only one holding a credential that can send
 * mail, and aisignal is the module that reaches that credential through the
 * mailbox contract rather than a client of its own; if either loads on a
 * developer's Node and not on the packaged runtime, an operator sees a card
 * that says enabled and a mailbox that never answers. aisignal is also the
 * concrete precedent: it turned out never to have loaded in the desktop app,
 * discovered after everything had been built on it.
 */
const EXTENSIONS = ['tts', 'video', 'gmail', 'aisignal']

/**
 * Extensions that have to be installed next to another one for the run to
 * exercise what an operator's host does.
 *
 * aisignal reaches its mailbox through the `mailbox` CONTRACT gmail provides.
 * Alone in a scratch data directory it answers `provider_missing`, which is
 * true and tests nothing about the wiring between the two modules; the
 * container run installs everything into one data directory, so without this
 * the same module would report `ready` there and `provider_missing` here and
 * the difference would be the harness, not the deployment.
 */
const COMPANIONS = { aisignal: ['gmail'] }

/**
 * Where a packaged SwarmClaw is likely to be. `SWARMCLAW_ELECTRON_APP` wins
 * over both, because a maintainer verifying a release has the artifact
 * somewhere neither of these guesses would find.
 */
const APP_CANDIDATES = [
  path.join(os.homedir(), 'Downloads', 'SwarmClaw.app'),
  '/Applications/SwarmClaw.app',
]

function log(message) {
  console.log(`[electron deploy-local] ${message}`)
}

function findApp() {
  const explicit = process.env.SWARMCLAW_ELECTRON_APP
  if (explicit) {
    if (!fs.existsSync(path.join(explicit, 'Contents', 'MacOS'))) {
      throw new Error(`SWARMCLAW_ELECTRON_APP=${explicit} is not a macOS application bundle`)
    }
    return explicit
  }
  const found = APP_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(
      `no packaged app found in ${APP_CANDIDATES.join(' or ')}; `
      + 'set SWARMCLAW_ELECTRON_APP to the .app bundle to verify',
    )
  }
  return found
}

function run(label, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
}

/**
 * Copies the app bundle, preferring APFS `clonefile` (`/bin/cp -Rc`, the system
 * cp -- a GNU `cp` earlier on PATH has no `-c`) and falling back to `ditto`,
 * which is slower but copies a bundle faithfully on any macOS filesystem.
 */
function cloneApp(source, destination) {
  const cloned = spawnSync('/bin/cp', ['-Rc', source, destination], { encoding: 'utf8' })
  if (cloned.status === 0) return 'clonefile'
  fs.rmSync(destination, { recursive: true, force: true })
  run('copying the app bundle with ditto', '/usr/bin/ditto', [source, destination])
  return 'ditto'
}

/**
 * Lays this checkout's freshly built server over the copy.
 *
 * Only `.next` and `server.js` move: the app's `node_modules` have to stay,
 * because they are what carries the Electron-ABI `better-sqlite3` this run
 * exists to exercise. Replacing them with the checkout's would run the
 * deployment's Node against the developer machine's native build and prove
 * nothing.
 */
function overlayBuild(appCopy, overlay) {
  const standalone = path.join(appCopy, 'Contents', 'Resources', '.next', 'standalone')
  if (!fs.existsSync(path.join(standalone, 'node_modules'))) {
    throw new Error(`${standalone} has no node_modules; this does not look like a packaged SwarmClaw server`)
  }
  if (!overlay) {
    if (!fs.existsSync(path.join(standalone, 'server.js'))) {
      throw new Error(`${standalone} has no server.js, so there is nothing to verify without an overlay`)
    }
    return standalone
  }
  const builtNext = path.join(REPO_ROOT, '.next', 'standalone', '.next')
  const builtServer = path.join(REPO_ROOT, '.next', 'standalone', 'server.js')
  for (const required of [builtNext, builtServer]) {
    if (!fs.existsSync(required)) {
      throw new Error(`${required} does not exist; run \`npm run build:ci\` first`)
    }
  }
  fs.rmSync(path.join(standalone, '.next'), { recursive: true, force: true })
  run('overlaying the built .next', '/bin/cp', ['-Rc', builtNext, path.join(standalone, '.next')])
  fs.copyFileSync(builtServer, path.join(standalone, 'server.js'))
  return standalone
}

/**
 * Re-signs the copy ad hoc. Changing files inside a signed bundle invalidates
 * its signature, and macOS refuses to run a bundle whose signature does not
 * match its contents; an ad-hoc signature is enough for a local run and asserts
 * nothing about provenance.
 */
function resign(appCopy) {
  run('ad-hoc signing the app copy', '/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appCopy])
}

/** What the runtime probe below has to answer for the run to mean anything. */
function probeRuntime(appCopy) {
  const binary = path.join(appCopy, 'Contents', 'MacOS', 'SwarmClaw')
  const result = spawnSync(binary, ['-e', 'console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,modules:process.versions.modules}))'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`the app copy would not run as Node (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  const line = result.stdout.trim().split(/\r?\n/).pop() || ''
  const versions = JSON.parse(line)
  if (!versions.electron) {
    throw new Error(`${binary} is not an Electron binary; it reported no electron version`)
  }
  return { binary, versions }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('this verifies the macOS desktop package; run it on macOS')
  }
  const app = findApp()
  log(`packaged app: ${app}`)

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-electron-deploy-'))
  const appCopy = path.join(scratch, 'SwarmClaw.app')
  const cleanup = () => fs.rmSync(scratch, { recursive: true, force: true })
  process.once('SIGINT', () => { cleanup(); process.exit(130) })
  process.once('SIGTERM', () => { cleanup(); process.exit(143) })

  try {
    log(`copying it to ${appCopy} (the installed app is only read)`)
    log(`copied with ${cloneApp(app, appCopy)}`)
    const overlay = !process.env.SWARMCLAW_ELECTRON_NO_OVERLAY
    log(overlay ? 'laying this checkout\'s built .next and server.js over the copy' : 'verifying the bundle\'s own server, with no overlay')
    const standalone = overlayBuild(appCopy, overlay)
    if (overlay) resign(appCopy)
    const { binary, versions } = probeRuntime(appCopy)
    log(`runtime: Electron ${versions.electron}, Node ${versions.node}, NODE_MODULE_VERSION ${versions.modules}`)

    const runtime = {
      label: `the desktop app's server under Electron ${versions.electron} (Node ${versions.node})`,
      command: binary,
      args: [path.join(standalone, 'server.js')],
      cwd: standalone,
      // Both variables are what `electron/server-lifecycle.ts` puts in the
      // child's environment when the real app spawns this same server.js.
      // ELECTRON_RUN_AS_NODE is what makes the app binary a Node; the deploy
      // mode is what sends the host down the Desktop-app OAuth client branch
      // (`GOOGLE_OAUTH_CLIENT_DESKTOP_*`, a loopback redirect on whatever port
      // the app got) instead of the Web-client branch a VPS uses. Without it
      // this run would start the app's own binary and then exercise the VPS
      // branch, and report the result as the desktop deployment.
      env: { ELECTRON_RUN_AS_NODE: '1', SWARMCLAW_DEPLOY_MODE: 'desktop' },
      deployMode: 'desktop',
    }

    for (const extension of EXTENSIONS) {
      log(`--- ${extension} ---`)
      await runExtensionDeploySmoke({ extension, runtime, companions: COMPANIONS[extension] || [] })
    }
    log(`all ${EXTENSIONS.length} extensions pass on the packaged runtime (Electron ${versions.electron} / Node ${versions.node}): ${EXTENSIONS.join(', ')}`)
  } finally {
    cleanup()
  }
}

main().catch((err) => {
  console.error(`electron deploy smoke FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
