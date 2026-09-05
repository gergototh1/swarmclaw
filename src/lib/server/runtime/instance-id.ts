import crypto from 'node:crypto'

/**
 * A random token identifying THIS running server process, minted once and
 * held for its life.
 *
 * WHY IT EXISTS. The port file hands an out-of-process reader (an extension's
 * stdio MCP shim) a port to send requests to, and the reader has to establish
 * that the server answering on that port is the one that wrote the file. The
 * checks that came before this could not: the shape, the boot time and the pid
 * are all facts about the file, and `/api/healthz` answering `service:
 * "swarmclaw"` says only that SOME SwarmClaw is there. After a SIGKILL leaves a
 * stale file behind, a pid reused within the same boot, and a second SwarmClaw
 * instance -- a different home, a different database, a different key -- now
 * listening on that port, every one of those checks passes and the shim sends
 * the request to the wrong instance. For the tts extension that is a paid
 * synthesis charged to another instance's provider key and counted against
 * another instance's daily cap, with the mp3 written where that instance was
 * told to write it.
 *
 * So the writer puts this token in the port file and `/api/healthz` returns
 * it, and a reader compares the two. The token is random per process rather
 * than derived from the pid or the data directory: a reused pid is exactly the
 * case being told apart, and two instances can be started from one image.
 *
 * It is not a secret and not an authenticator. Anyone who can read the port
 * file can read it, and `/api/healthz` gives it to anyone who asks -- that is
 * the point, since the reader has to be able to compare. It answers "is this
 * the same process?", nothing else.
 *
 * WHY IT HANGS OFF `globalThis`. The instrumentation hook that writes the port
 * file and the route handler that answers `/api/healthz` are one process but
 * not necessarily one module instance: the server bundles them separately, and
 * a module-scope `const` would then mint two different tokens and the server
 * would fail its own check. A key on `globalThis` is the one place both halves
 * agree on. It also survives Next's HMR module reload, which a module-scope
 * value would not, so a dev server does not change identity when a file is
 * saved.
 */

const INSTANCE_ID_KEY = '__swarmclaw_server_instance_id__'

interface InstanceIdHolder {
  [INSTANCE_ID_KEY]?: string
}

/** This process's instance token, minted on first use. */
export function serverInstanceId(): string {
  const holder = globalThis as typeof globalThis & InstanceIdHolder
  const existing = holder[INSTANCE_ID_KEY]
  if (typeof existing === 'string' && existing.length > 0) return existing
  const minted = crypto.randomBytes(16).toString('hex')
  holder[INSTANCE_ID_KEY] = minted
  return minted
}
