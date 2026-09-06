import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'
import { buildSessionTools } from '@/lib/server/session-tools'
import { resolveActiveProjectContext } from '@/lib/server/project-context'
import { log } from '@/lib/server/logger'
import type { Agent } from '@/types'

/**
 * SwarmClaw's own platform tools, offered over MCP.
 *
 * WHY THIS EXISTS. An agent on a CLI provider runs its own tool loop and never
 * receives the LangChain array `buildSessionTools()` assembles — the platform's
 * docs say so (`/docs/providers`: CLI providers "manage their own runtime/tool
 * loop"). Extensions solved that for themselves by fronting their tools as MCP
 * servers, because MCP is the one layer a CLI speaks. The platform's OWN tools
 * had no such front, so `manage_tasks`, `spawn_subagent` and the rest were
 * unreachable from every CLI-provider agent: the operator ticks them in the UI,
 * the UI confirms, and nothing arrives. That is why an orchestrator could not
 * direct anybody.
 *
 * HOW IT AVOIDS BECOMING A SECOND SET OF RULES. It does not reimplement any
 * gate. `toolsForAgent` calls the same `buildSessionTools()` the chat pipeline
 * calls, with the same context built from the same agent record, and then
 * filters the result by name. So an agent's capability selection, the
 * capability policy, the extension-disabled checks and — the one that matters
 * most here — the `delegationEnabled` gate all apply exactly as they do on an
 * API provider. A tool the agent would not have been given in a normal turn is
 * not in the array to be exposed. Never add a second code path that decides
 * what an agent may call.
 *
 * WHO IS ASKING comes from the caller stamp the host writes into the shim's
 * env (`addAssignedMcpServers`, src/lib/providers/claude-cli.ts), forwarded on
 * every request. It is never taken from a tool's arguments.
 */

/**
 * The families a CLI provider does NOT already have, and only those.
 *
 * This is an allow-list rather than a deny-list on purpose: a deny-list would
 * quietly start exporting the next native tool somebody adds.
 *
 * What is deliberately absent is as important as what is here. `shell`,
 * `execute`, `files`, `edit_file`, the `web*` family and the browsers are left
 * out because a CLI provider already ships its own, usually better, versions —
 * exposing a second `files` next to Claude Code's own file tools gives the
 * model two ways to do one thing and a reason to pick wrong.
 * `extension_creator_tool` is out for the same reason: a coding CLI edits the
 * file directly.
 */
export const PLATFORM_MCP_TOOL_NAMES: readonly string[] = [
  // Coordination — the point of the exercise.
  'spawn_subagent',
  'delegate',
  'manage_tasks',
  'manage_agents',
  'manage_schedules',
  'manage_projects',
  'manage_platform',
  'schedule_wake',
  // Platform surfaces a CLI cannot reach on its own.
  'manage_chatrooms',
  'manage_connectors',
  'manage_webhooks',
  'manage_secrets',
  'manage_skills',
  'use_skill',
  'sessions_tool',
  'monitor_tool',
  'connector_message_tool',
  'send_file',
  // Durable memory. Claude Code has none, and this is where an agent's
  // knowledge of the fleet lives between turns.
  'memory',
  'memory_get',
  'memory_search',
  'memory_store',
  'memory_update',
  'memory_tool',
  // Outbound comms the host owns the credentials for.
  'email',
  'google_workspace',
]

const ALLOWED = new Set(PLATFORM_MCP_TOOL_NAMES)

export interface PlatformMcpCaller {
  agentId?: string | null
  sessionId?: string | null
}

export interface PlatformMcpToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Build the agent's real tool array and keep the allow-listed names.
 *
 * The caller owns `cleanup()`: `buildSessionTools` can open MCP connections and
 * other resources, and skipping it leaks one set per request.
 */
async function toolsForAgent(agentId: string): Promise<{ tools: StructuredToolInterface[]; cleanup: () => Promise<void> }> {
  const agent = getAgent(agentId) as Agent | null
  if (!agent) throw new PlatformMcpError('unknown_agent', `no agent with id "${agentId}"`)
  const record = agent as unknown as Record<string, unknown>
  const capabilities = getEnabledCapabilityIds(record as { tools?: string[] | null; extensions?: string[] | null })
  const project = resolveActiveProjectContext(record as { agentId?: string | null; cwd?: string | null; projectId?: string | null })
  const built = await buildSessionTools(process.cwd(), capabilities, {
    agentId,
    sessionId: null,
    // Straight off the record, never widened. An agent whose operator has not
    // enabled delegation must not gain it by being reached over MCP.
    delegationEnabled: record.delegationEnabled === true,
    delegationTargetMode: record.delegationTargetMode === 'selected' ? 'selected' : 'all',
    delegationTargetAgentIds: Array.isArray(record.delegationTargetAgentIds) ? record.delegationTargetAgentIds as string[] : undefined,
    // The agent's own MCP servers are NOT passed on. This bridge is itself one
    // of them, and connecting the set from inside would have a server reach
    // its own siblings — and, on the next hop, itself.
    mcpServerIds: [],
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    projectName: project.project?.name || null,
    projectDescription: project.project?.description || null,
  })
  return { tools: built.tools.filter((t) => ALLOWED.has(t.name)), cleanup: built.cleanup }
}

export class PlatformMcpError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PlatformMcpError'
  }
}

/** A LangChain tool's zod schema as the JSON Schema MCP advertises. */
function inputSchemaOf(tool: StructuredToolInterface): Record<string, unknown> {
  const schema = (tool as unknown as { schema?: unknown }).schema
  if (schema && typeof schema === 'object' && '_zod' in (schema as object)) {
    try {
      return z.toJSONSchema(schema as z.ZodType, { io: 'input' }) as Record<string, unknown>
    } catch (err) {
      // A schema zod cannot render is advertised as open rather than dropped:
      // the tool still works, and hiding it would be a worse answer than a
      // loose schema.
      log.warn('platform-mcp', `could not render schema for ${tool.name}`, { error: String(err) })
    }
  }
  if (schema && typeof schema === 'object') return schema as Record<string, unknown>
  return { type: 'object', properties: {} }
}

export async function listPlatformMcpTools(caller: PlatformMcpCaller): Promise<PlatformMcpToolDescriptor[]> {
  const agentId = requireAgentId(caller)
  const { tools, cleanup } = await toolsForAgent(agentId)
  try {
    return tools.map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: inputSchemaOf(t),
    }))
  } finally {
    await cleanup()
  }
}

export async function callPlatformMcpTool(
  caller: PlatformMcpCaller,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const agentId = requireAgentId(caller)
  if (!ALLOWED.has(toolName)) {
    throw new PlatformMcpError('unknown_tool', `"${toolName}" is not a platform tool offered over MCP`)
  }
  const { tools, cleanup } = await toolsForAgent(agentId)
  try {
    const tool = tools.find((t) => t.name === toolName)
    if (!tool) {
      // The name is allow-listed but this agent did not get it — a capability
      // the operator has not granted, or delegation left off. Say which,
      // because "unknown tool" would send the agent looking for a typo.
      throw new PlatformMcpError(
        'tool_not_granted',
        `"${toolName}" is not enabled for this agent; grant the capability on the agent, and for delegation tools turn on "Can Delegate to Other Agents"`,
      )
    }
    return await tool.invoke(args)
  } finally {
    await cleanup()
  }
}

function requireAgentId(caller: PlatformMcpCaller): string {
  const agentId = typeof caller.agentId === 'string' ? caller.agentId.trim() : ''
  if (!agentId) {
    // Without a caller there is no capability set to honour, and running as
    // "somebody" would mean running as everybody.
    throw new PlatformMcpError('caller_missing', 'no calling agent: the host stamps SWARMCLAW_AGENT_ID into the MCP server env, and it did not arrive')
  }
  return agentId
}
