import { hmrSingleton } from '@/lib/shared-utils'

const TAG = 'instrumentation'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { log } = await import('@/lib/server/logger')
    const { ensureOpenTelemetryStarted, shutdownOpenTelemetry } = await import('@/lib/server/observability/otel')
    const isWorkerOnly = process.env.SWARMCLAW_WORKER_ONLY === '1'
    const { initWsServer, closeWsServer } = await import('./lib/server/ws-hub')
    const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
    await ensureOpenTelemetryStarted()

    // Awaited, and not deferred with the work below, because an extension
    // module can only be obtained with `import()`. Every read side of the
    // extension manager is synchronous -- tool lists, provider lists, prompt
    // sections -- so an extension that has not been imported by the time the
    // first request runs is simply absent from that request, with no way for
    // the synchronous caller to wait for it. Loading here is the same work the
    // first request used to do inline; it moves the cost from first request to
    // boot and removes the window in which the host reports no extensions.
    //
    // A broken extension must not stop the server, and there are two ways an
    // extension breaks a load. One that THROWS on import is caught by the
    // manager, recorded against that extension, and the boot continues. One
    // that HANGS on import -- a top-level `await` that never settles -- is
    // not something a catch can see, and because this await sits before the
    // listener binds, a hang here would have been a server that never comes
    // up and cannot be reached to disable the culprit. So the manager bounds
    // every import with a deadline (`SWARMCLAW_EXTENSION_IMPORT_TIMEOUT_MS`,
    // 30 s by default) and records a timeout as a failure the same way it
    // records a throw. What the deadline does not do is stop the module: it
    // keeps evaluating in the background, and nothing is listening if it
    // eventually settles.
    try {
      const { getExtensionManager } = await import('@/lib/server/extensions')
      await getExtensionManager().ensureLoaded()
    } catch (err) {
      log.error(TAG, 'Extension load during boot failed:', err)
    }

    // Defer migrations, WS init, and daemon startup so the HTTP listener can bind
    // and /api/healthz can respond immediately. Heavy per-install work (session
    // migrations on large data dirs, daemon recovery) no longer gates first boot.
    setImmediate(() => {
      void (async () => {
        try {
          const { backfillAllKnownPeerIds, pruneThreadConnectorMirrors } = await import('@/lib/server/connectors/session-consolidation')
          backfillAllKnownPeerIds()
          pruneThreadConnectorMirrors()
        } catch (err) {
          log.error(TAG, 'connector session consolidation failed:', err)
        }

        if (isWorkerOnly) {
          log.info(TAG, 'Booting in WORKER ONLY mode')
          ensureDaemonStarted('worker-boot')
        } else {
          initWsServer()
          ensureDaemonStarted('instrumentation')
        }
      })()
    })

    // Graceful shutdown: stop background services and close WS connections
    const shutdownState = hmrSingleton('__swarmclaw_shutdown_state__', () => ({
      registered: false,
      shuttingDown: false,
    }))

    const shutdown = async (signal: string) => {
      if (shutdownState.shuttingDown) return
      shutdownState.shuttingDown = true
      log.info(TAG, `${signal} received, shutting down gracefully...`)
      try {
        const { stopDaemon } = await import('@/lib/server/runtime/daemon-state')
        await stopDaemon({ source: signal })
      } catch (err) {
        log.error(TAG, 'Failed to stop daemon during shutdown:', err)
      }
      try {
        await shutdownOpenTelemetry()
      } catch (err) {
        log.error(TAG, 'Failed to stop OpenTelemetry during shutdown:', err)
      }
      if (!isWorkerOnly) {
        await closeWsServer()
      }
      process.exit(0)
    }
    if (!shutdownState.registered) {
      process.on('SIGTERM', () => { void shutdown('SIGTERM') })
      process.on('SIGINT', () => { void shutdown('SIGINT') })

      // Gracefully handle EPIPE errors from child processes (e.g. Playwright MCP proxy)
      // that occur during dev server restarts when stdio pipes break
      process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          log.warn(TAG, 'Ignoring EPIPE (expected during dev server restart)')
          return
        }
        log.error(TAG, 'Uncaught exception:', err)
        process.exit(1)
      })

      // LangGraph's streamEvents leaves dangling internal promises when the
      // for-await loop exits early. Suppress expected LangGraph rejections;
      // log all others so they're not silently dropped.
      process.on('unhandledRejection', (err: unknown) => {
        if (
          err && typeof err === 'object'
          && ('pregelTaskId' in err
            || (err instanceof Error && (err.name === 'AbortError' || err.name === 'GraphRecursionError'))
            || (err as Record<string, unknown>).lc_error_code === 'GRAPH_RECURSION_LIMIT')
        ) {
          return
        }
        log.error(TAG, 'Unhandled rejection:', err)
      })

      shutdownState.registered = true
    }
  }
}
