import { dedup } from '@/lib/shared-utils'

/**
 * Finding the platform bridge among the registered MCP servers.
 *
 * WHY THE BRIDGE IS NOT A PER-AGENT CHOICE. It fronts SwarmClaw's OWN tools,
 * and what an agent may call through it is already decided by that agent's
 * capability list and its `delegationEnabled` flag (`toolsForAgent` in
 * platform-mcp.ts). The `mcpServerIds` assignment only ever decided whether the
 * bridge starts at all — a second, weaker gate in front of the real one, and
 * one an operator has to remember on every new agent.
 *
 * In this install three agents were missing it, the coding agent among them, so
 * durable memory, `schedule_wake` and delegation reached none of them. Worse,
 * those agents still received the recall preamble telling them to write with a
 * `memory` tool they did not have.
 *
 * Attaching it everywhere is not a widening: an agent that has not been granted
 * `memory` still gets no memory tools over the bridge.
 *
 * HOW IT IS RECOGNISED. By the shim it runs, not by its name — a name is
 * whatever the operator typed. `scripts/platform-mcp/server.mjs` is where the
 * shim lives in the repo, and installs copy it under `data/mcp/` with a
 * platform-ish file name. A url transport is never the bridge: that is a server
 * someone else runs, and this one is always local.
 */

/** The shim's own file, in the repo layout and as installers copy it. */
const PLATFORM_SHIM_PATH_RE = /(?:^|[\\/])(?:platform[-_]?(?:mcp[-_]?)?server\.mjs|platform-mcp[\\/]server\.mjs)$/i

function argsOf(server: Record<string, unknown> | null | undefined): string[] {
  const args = server?.args
  if (!Array.isArray(args)) return []
  return args.filter((value): value is string => typeof value === 'string')
}

function isPlatformBridge(server: Record<string, unknown> | null | undefined): boolean {
  if (!server) return false
  // A remote server is somebody else's process; the bridge talks to this host.
  const transport = typeof server.transport === 'string' ? server.transport.trim().toLowerCase() : 'stdio'
  if (transport !== 'stdio') return false
  return argsOf(server).some((arg) => PLATFORM_SHIM_PATH_RE.test(arg.trim()))
}

/** Ids of every registered server that is this host's platform bridge. */
export function findPlatformBridgeServerIds(
  allServers: Record<string, Record<string, unknown>> | null | undefined,
): string[] {
  if (!allServers || typeof allServers !== 'object') return []
  return Object.entries(allServers)
    .filter(([id, server]) => typeof id === 'string' && id.trim() && isPlatformBridge(server))
    .map(([id]) => id)
}

/**
 * The agent's assigned servers, with the platform bridge added.
 *
 * The agent's own ids stay first: `addAssignedMcpServers` renames a later
 * server whose name collides rather than overwriting, so an operator's own
 * server keeps the plain name it was given.
 */
export function withPlatformBridge(
  assignedServerIds: string[] | null | undefined,
  allServers: Record<string, Record<string, unknown>> | null | undefined,
): string[] {
  const assigned = Array.isArray(assignedServerIds)
    ? assignedServerIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []
  return dedup([...assigned, ...findPlatformBridgeServerIds(allServers)])
}
