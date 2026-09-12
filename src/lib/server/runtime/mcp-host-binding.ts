import { PORT_FILE } from './port-file'
import { serverInstanceId } from './instance-id'

/**
 * Where a SwarmClaw extension's stdio MCP shim should send its requests, and
 * with what key, as of RIGHT NOW.
 *
 * WHY THIS EXISTS. An extension's MCP entry is registered once, by
 * `scripts/install.mjs`, which prints the entry JSON with the host's access key
 * and port-file path baked into its `env`. Those two values then sit frozen in
 * storage while the things they name move: `ACCESS_KEY` is regenerated whenever
 * a host starts without one (storage-auth.ts), and a second SwarmClaw sharing
 * the same `SWARMCLAW_HOME` rewrites `run/port.json` to its own port.
 *
 * What a stale pair costs is invisible, which is the reason this is worth code.
 * The shim answers `tools/list` with an EMPTY LIST when the host refuses it --
 * deliberately, so a briefly-unreachable host does not cost the agent its
 * server for the whole session -- so a wrong key produces a 401, an empty list,
 * and an agent that simply has no docs tools. Nothing fails, nothing is
 * reported, and from the outside it is indistinguishable from the CLI dropping
 * the server. This was diagnosed only after a long hunt for a phantom
 * "peer server evicts ours" bug that never existed.
 *
 * So the per-turn config writer refreshes them: the host knows its own key,
 * port file and instance token when it spawns the shim, and a value it stamps
 * at that moment cannot be stale.
 *
 * ONLY WHAT THE ENTRY ALREADY DECLARES. A refresh must never ADD
 * `SWARMCLAW_ACCESS_KEY` to a server that did not have one: an operator's
 * third-party stdio MCP server is a local program like any other, and handing
 * it the host's access key because it happened to be assigned to an agent would
 * be a credential leak dressed up as a bug fix. An entry that declares neither
 * SwarmClaw variable is left exactly as stored.
 */
export interface McpHostBinding {
  accessKey: string
  portFile: string
  instanceId: string
}

/** The running host's own binding. Read fresh; `ACCESS_KEY` can be replaced at boot. */
export function currentHostBinding(): McpHostBinding {
  return {
    accessKey: (process.env.ACCESS_KEY || '').trim(),
    portFile: PORT_FILE,
    instanceId: serverInstanceId(),
  }
}

/** True when this stdio entry's env marks it as a SwarmClaw extension shim. */
function isSwarmclawShimEnv(env: Record<string, string>): boolean {
  return typeof env.SWARMCLAW_ACCESS_KEY === 'string' || typeof env.SWARMCLAW_PORT_FILE === 'string'
}

/**
 * The env a SwarmClaw shim should be spawned with: the stored one, with the
 * host-bound values replaced by the live ones. Returns the input unchanged for
 * anything that is not one of our shims.
 *
 * `SWARMCLAW_INSTANCE_ID` is added rather than refreshed, because no installer
 * ever wrote it: it is what lets the shim check it reached the instance that
 * spawned it, instead of trusting whichever instance last wrote the port file.
 * An empty access key is not written -- a host started without one accepts
 * every request, and a blank value would defeat the shim's own "is a key set"
 * test.
 */
export function refreshShimEnv(env: Record<string, string>, binding: McpHostBinding): Record<string, string> {
  if (!isSwarmclawShimEnv(env)) return env
  const out = { ...env }
  if (binding.accessKey !== '') out.SWARMCLAW_ACCESS_KEY = binding.accessKey
  if (binding.portFile !== '') out.SWARMCLAW_PORT_FILE = binding.portFile
  if (binding.instanceId !== '') out.SWARMCLAW_INSTANCE_ID = binding.instanceId
  return out
}

/**
 * Which host-bound variables this shim's STORED env got wrong, by name.
 *
 * `refreshShimEnv` silently corrects them, which is right for the turn and
 * wrong for the operator: the registration on the MCP servers page still holds
 * the stale values, every other consumer of it is still broken, and re-running
 * the extension's installer is the actual fix. So the caller logs this once per
 * turn. Empty for anything that is not one of our shims.
 */
export function staleShimVars(env: Record<string, string>, binding: McpHostBinding): string[] {
  if (!isSwarmclawShimEnv(env)) return []
  const stale: string[] = []
  if (binding.accessKey !== '' && typeof env.SWARMCLAW_ACCESS_KEY === 'string' && env.SWARMCLAW_ACCESS_KEY !== binding.accessKey) {
    stale.push('SWARMCLAW_ACCESS_KEY')
  }
  if (binding.portFile !== '' && typeof env.SWARMCLAW_PORT_FILE === 'string' && env.SWARMCLAW_PORT_FILE !== binding.portFile) {
    stale.push('SWARMCLAW_PORT_FILE')
  }
  return stale
}
