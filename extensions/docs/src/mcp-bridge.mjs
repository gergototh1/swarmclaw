/**
 * The two rpc methods that let this extension's tools be reached over MCP.
 *
 * WHY THIS EXISTS. An agent on a CLI provider -- and every agent in this
 * install is on `claude-cli` -- never receives the extension tool layer. The
 * CLI runs its own tool loop, so the LangChain array the host assembles in
 * `buildSessionTools()` is not something it can see; the platform's own docs
 * say so (`/docs/providers`: CLI providers "manage their own runtime/tool
 * loop"). The only capability layer that crosses into a CLI's loop is MCP,
 * because MCP is a protocol the CLI itself speaks. So a tool-shaped extension
 * that wants to serve those agents has to also appear as an MCP server, and
 * `mcp/server.mjs` is that server. It reaches back here.
 *
 * WHY TWO METHODS AND NOT ONE PER TOOL. The obvious shape -- an rpc method
 * mirroring each tool -- duplicates every name, description and schema into a
 * second place that then drifts. These two reflect over the extension's own
 * `tools` array instead, so the tool definitions stay in exactly one file and
 * a tool added there is reachable over MCP with no further work.
 *
 * WHO IS ASKING. `mcpCall` builds the `ctx.session` its tools read from the
 * `agentId`/`sessionId` in the body. The shim does not invent those: the host
 * stamps them into the shim's process env when it writes the per-turn MCP
 * config (`addAssignedMcpServers` in src/lib/providers/claude-cli.ts), so the
 * agent never sees them and cannot name itself. That is what keeps a gate like
 * the video extension's reviewer check meaningful through a shim, and what
 * gets the docs extension's per-agent folder named correctly.
 *
 * This is identity, not authorisation. Anything that can reach this rpc route
 * already holds the host's access key, and could equally edit the database; the
 * route's own header says extensions are trusted same-process code. Do not
 * build a permission model on the ids in the body.
 */

/** The shape a failure takes, matching what the tools themselves return. */
function hiba(code, message) {
  return { error: { code, message } }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build the two handlers over a `tools` array.
 *
 * `toolsOf` is a function rather than the array itself because `setup()` runs
 * again on every reload and rebuilds the tools; a captured array would be the
 * previous load's.
 */
export function createMcpBridge(toolsOf) {
  return {
    /**
     * The tool table, in MCP's shape. `parameters` is the host's name for the
     * JSON Schema and `inputSchema` is MCP's; nothing else is translated, so a
     * schema the host accepts is the schema the agent is shown.
     *
     * A tool with no schema is advertised as taking an empty object rather than
     * omitted: omitting it would hide a working tool, and MCP has no way to say
     * "arguments unspecified".
     */
    mcpTools() {
      const tools = toolsOf() || []
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.parameters || { type: 'object', properties: {} },
        })),
      }
    },

    /**
     * Run one tool by name.
     *
     * The tool's own thrown errors are left to propagate: the rpc route turns a
     * throw into a 500 carrying the message, and the shim reports that as a
     * tool error. Only the two failures that are this bridge's own -- a
     * malformed body and an unknown name -- are answered as values, because a
     * 500 for "you asked for a tool that does not exist" reads to the agent as
     * "the extension is broken" and it would stop rather than correct itself.
     */
    async mcpCall(body) {
      const name = isPlainObject(body) ? body.tool : undefined
      if (typeof name !== 'string' || name === '') {
        return hiba('mcp_rossz_keres', 'tool: nem üres szöveg kell')
      }
      const args = isPlainObject(body) && isPlainObject(body.args) ? body.args : {}
      const tool = (toolsOf() || []).find((t) => t.name === name)
      if (!tool) {
        const ismert = (toolsOf() || []).map((t) => t.name).join(', ')
        return hiba('mcp_ismeretlen_tool', `nincs "${name}" nevű tool ebben az extensionben; a meglévők: ${ismert}`)
      }
      // The same shape buildSessionTools() passes, so a tool cannot tell which
      // side called it. `agentRecord` carries the name because that is where
      // the docs extension reads it from; an absent name is left absent rather
      // than filled with the id, so the tool's own fallback still runs.
      const agentId = typeof body.agentId === 'string' && body.agentId !== '' ? body.agentId : null
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null
      const agentName = typeof body.agentName === 'string' && body.agentName !== '' ? body.agentName : null
      const ctx = {
        source: 'mcp',
        session: {
          id: sessionId,
          agentId,
          ...(agentName ? { agentName, agentRecord: { id: agentId, name: agentName } } : {}),
        },
      }
      return await tool.execute(args, ctx)
    },
  }
}
