import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { log } from '@/lib/server/logger'
import { PlatformMcpError, callPlatformMcpTool, listPlatformMcpTools } from '@/lib/server/platform-mcp'

export const dynamic = 'force-dynamic'

/**
 * POST /api/platform-mcp
 *
 * The one way the platform MCP shim (`scripts/platform-mcp-server.mjs`) reaches
 * SwarmClaw's own tools. `op: "tools"` returns the table the shim advertises;
 * `op: "call"` runs one.
 *
 * WHICH AGENT IS ASKING is `agentId` in the body, and it is not a claim the
 * agent gets to make: the host stamps it into the shim's process env when it
 * writes the per-turn MCP config (`addAssignedMcpServers`,
 * src/lib/providers/claude-cli.ts), and the shim forwards what it was given. An
 * `agentId` inside `args` is just an argument and reaches the tool as data.
 *
 * It decides CAPABILITY, not permission. Everything reachable here is
 * reachable because `buildSessionTools()` gave that agent the tool in the first
 * place, under the same gates a normal turn uses. Authentication is the
 * app-wide access-key check in `src/proxy.ts`, which covers `/api/:path*`;
 * anyone able to call this route already holds the host's key.
 */
export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const op = typeof body.op === 'string' ? body.op : ''
  const caller = {
    agentId: typeof body.agentId === 'string' ? body.agentId : null,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
  }
  try {
    if (op === 'tools') {
      return NextResponse.json({ tools: await listPlatformMcpTools(caller) })
    }
    if (op === 'call') {
      const tool = typeof body.tool === 'string' ? body.tool : ''
      if (!tool) return failure(400, 'bad_request', 'tool: a non-empty string is required')
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? body.args as Record<string, unknown>
        : {}
      const result = await callPlatformMcpTool(caller, tool, args)
      // `undefined` cannot travel as JSON and an empty body makes the shim
      // throw on parse; `null` is a value a tool can mean and round-trips.
      return NextResponse.json({ result: result === undefined ? null : result })
    }
    return failure(400, 'bad_request', `unknown op "${op}": expected "tools" or "call"`)
  } catch (err) {
    if (err instanceof PlatformMcpError) {
      // A refusal the agent can act on (wrong name, capability not granted, no
      // caller) is a 400, not a 500: a 500 reads as "the platform is broken"
      // and the agent stops instead of correcting itself.
      return failure(400, err.code, err.message)
    }
    const message = err instanceof Error ? err.message : String(err)
    log.warn('platform-mcp', `${op} failed`, { message })
    return failure(500, 'internal', message)
  }
}

/** The shape `api()` and the shim both read: `error.message`, repeated top level. */
function failure(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message }, message }, { status })
}
