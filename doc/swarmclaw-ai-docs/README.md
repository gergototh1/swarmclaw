# Notes from https://www.swarmclaw.ai/docs — read 2026-09-06

The site header says **"Updated for v1.9.40"**; this fork is on v1.10.0, so the
docs can lag the code. Where they disagree, the code is what runs — but the docs
are what the platform *promises*, so a divergence is a bug report, not licence
to invent a third design.

All 42 `/docs/*` pages were read. The fetch path passes pages through a
summarising model, so **only `/docs/cli` and `/docs/scheduling` came back as
verbatim text**; everything else is a condensed rendering. Do not quote the rest
as though it were the spec. Re-fetch a page before relying on its exact wording.

## Page index

activity, agents, autonomy, chatrooms, cli, config-versions, configuration,
connectors, cost-tracking, daemon, delegation, deployment, dreaming,
extension-tutorial, extensions, failover, getting-started, inbox, knowledge,
launch-playbook, mcp-servers, memory, notifications, observability,
openclaw-setup, projects, providers, release-notes, scheduling, skills,
structured-sessions, swarmdock, swarmfeed, swarmvault, tasks, tools, wallets,
webhooks, workflow-states, workspace-templates, workspaces — plus the index at
`/docs`.

## The three capability layers (`/docs/agents`)

An agent's capabilities come from three separate places, and the docs keep them
separate on purpose:

1. **Built-in tools** — execute, files, web, browser, memory. Selected per agent
   or per chat from the tool picker.
2. **MCP servers** — external Model Context Protocol servers, *assigned to an
   agent*. "MCP tools appear alongside built-in tools during execution"
   (`/docs/mcp-servers`).
3. **Extensions** — external `.js`/`.mjs` add-ons under `data/extensions/`.

`/docs/tools` draws the line: "Tools are built into SwarmClaw" while
"Extensions are external add-ons installed from the Extensions surface."

## The rule that decides the CLI-provider bridge (`/docs/providers`)

> CLI providers, OpenClaw, Goose, and Hermes Agent "manage their own
> runtime/tool loop," so SwarmClaw doesn't expose identical tool toggles for
> these agents.

This is the documented reason a `claude-cli` agent does not see the LangChain
tool array. It is by design, not a gap. Of the three capability layers, **only
the MCP layer crosses into a CLI provider's own tool loop**, because MCP is a
protocol the CLI itself speaks.

The docs describe **no** mechanism by which an extension's `tools` array reaches
a CLI-provider agent, and describe **no** `mcp/server.mjs` convention inside an
extension. An extension that wants to serve a CLI-provider agent has to appear
as an MCP server the agent is assigned.

## MCP servers (`/docs/mcp-servers`)

Transports: `stdio` (command, args, optional cwd), `sse` and `streamable-http`
(url + headers). Workflow: create the server definition, test the connection,
inspect discovered tools, run conformance checks, then **assign the server to
agents**. REST under `/api/mcp-servers`, CLI under `swarmclaw mcp-servers`.

## Extensions (`/docs/extensions`, `/docs/extension-tutorial`)

An extension is an external `.js`/`.mjs` file under `data/extensions/`. It can
add tools, lifecycle hooks, UI panels, providers and connectors. Legacy
`data/plugins/` installs are migrated on first access.

Repeated failures auto-disable an extension and record metadata in
`data/extension-failures.json`; the threshold is
`SWARMCLAW_EXTENSION_FAILURE_THRESHOLD=3` (`/docs/configuration` repeats this).

Settings and dependency workspaces are managed from the Extensions detail
surface and the `/api/extensions/*` routes.

## Verbatim check on the two extension pages

Re-fetched with a literal-artifact extraction. Result:

- `/docs/extensions` has **no code blocks at all** — it is prose only.
- `/docs/extension-tutorial` has exactly **one** code block, the whole worked
  example, reproduced here as the only authoritative statement the docs make
  about an extension's shape:

```js
// data/extensions/release-guard.js
module.exports = {
  name: "release-guard",
  version: "1.0.0",
  description: "Adds a guarded release checklist tool.",
  tools: [
    {
      name: "release_guard",
      description: "Return a compact release checklist.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string" }
        },
        required: ["target"]
      },
      async execute(args) {
        return {
          ok: true,
          target: args.target,
          checklist: [
            "Run focused tests",
            "Confirm the release target",
            "Review rollback steps"
          ]
        }
      }
    }
  ],
  ui: {
    settingsFields: [
      { key: "defaultEnvironment", label: "Default Environment", type: "text" }
    ]
  }
}
```

Tutorial API routes: `GET/POST/DELETE /api/extensions`, and
`GET/PUT /api/extensions/settings?pluginId=<id>` — note the query parameter is
still the legacy `pluginId`, not `extensionId`.

**Both pages are silent on MCP.** On `/docs/extensions` the string "MCP" does
not appear at all; on `/docs/extension-tutorial` it appears only as a
left-navigation link. Neither page mentions `mcp/server.mjs`, mentions CLI
providers, or explains how an extension's tools reach an agent running on a CLI
provider. That silence is the finding: **there is no documented extension→MCP
shim convention.** Anything we build in that shape is our own local pattern and
must be labelled as such, not as "what the platform expects".
