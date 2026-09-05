import { hmrSingleton } from '@/lib/shared-utils'

const TAG = 'instrumentation'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { log } = await import('@/lib/server/logger')
    const { ensureOpenTelemetryStarted, shutdownOpenTelemetry } = await import('@/lib/server/observability/otel')
    const isWorkerOnly = process.env.SWARMCLAW_WORKER_ONLY === '1'
    const { initWsServer, closeWsServer, resolveWsPort } = await import('./lib/server/ws-hub')
    const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
    const { writePortFile, removePortFile } = await import('@/lib/server/runtime/port-file')
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
          // The port file is how an extension's out-of-process MCP shim finds
          // this server; see port-file.ts for what a reader may rely on.
          // `PORT` holds the port Next actually bound: it writes it there from
          // the listening callback and runs this hook afterwards, so a bare
          // `next dev` that moved off a busy port reports the moved-to port.
          // Only the worker-only branch above skips this, on purpose.
          try {
            const port = Number(process.env.PORT)
            if (Number.isSafeInteger(port) && port > 0) {
              writePortFile({ port, wsPort: resolveWsPort(), pid: process.pid, startedAt: Date.now() })
            } else {
              log.warn(TAG, 'PORT is not set; run/port.json was not written and an MCP shim cannot find this server')
            }
          } catch (err) {
            log.error(TAG, 'writing run/port.json failed:', err)
          }
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
        removePortFile()
        await closeWsServer()
      }
      process.exit(0)
    }
    if (!shutdownState.registered) {
      process.on('SIGTERM', () => { void shutdown('SIGTERM') })
      process.on('SIGINT', () => { void shutdown('SIGINT') })
      // Exits that bypass `shutdown` (the uncaught-exception handler below,
      // Next's own exit on a listen error) still get the port file removed;
      // it is a no-op when the file is missing or another process's. A
      // SIGKILL or a crash of the runtime itself runs no handler at all, and
      // the file stays for the reader's staleness checks to catch.
      process.on('exit', () => { removePortFile() })

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
