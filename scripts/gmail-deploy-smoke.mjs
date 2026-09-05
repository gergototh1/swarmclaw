import { runExtensionDeploySmoke, standaloneNodeRuntime } from './lib/extension-deploy-smoke.mjs'

/**
 * `npm run test:deploy:gmail` -- the gmail extension's deploy smoke against the
 * standalone build under this Node.
 *
 * Everything this does lives in `lib/extension-deploy-smoke.mjs`, which the
 * Electron run reuses with a different runtime descriptor. Keeping the shared
 * part shared is not tidiness: if the two harnesses drifted, a difference
 * between them would be indistinguishable from a difference between the two
 * deployments, which is the only thing either run is for.
 *
 * The harness builds the page bundle, installs the extension into a scratch
 * data directory, starts the built server on a free port with DATA_DIR,
 * WORKSPACE_DIR and SWARMCLAW_HOME pointed there and a key minted for the run,
 * and removes the whole scratch directory afterwards whatever the outcome.
 * NOTHING HERE TOUCHES PORT 3456 OR ANY REAL DATA DIRECTORY, and nothing in
 * this module's smoke reaches Google: every method it calls answers from that
 * scratch database.
 */
runExtensionDeploySmoke({ extension: 'gmail', runtime: standaloneNodeRuntime() }).catch((err) => {
  console.error(`gmail deploy smoke FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
