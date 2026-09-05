import { runExtensionDeploySmoke, standaloneNodeRuntime } from './lib/extension-deploy-smoke.mjs'

/**
 * `npm run test:deploy:video` -- the video extension's deploy smoke against the
 * standalone build under this Node.
 *
 * Everything this does lives in `lib/extension-deploy-smoke.mjs`, which the
 * Electron run reuses with a different runtime descriptor. Keeping the shared
 * part shared is not tidiness: if the two harnesses drifted, a difference
 * between them would be indistinguishable from a difference between the two
 * deployments, which is the only thing either run is for.
 */
runExtensionDeploySmoke({ extension: 'video', runtime: standaloneNodeRuntime() }).catch((err) => {
  console.error(`video deploy smoke FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
