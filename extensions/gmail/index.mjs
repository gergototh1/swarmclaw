import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAILBOX_CONTRACT, createMailboxContract } from './src/contract.mjs'
import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createRpc } from './src/rpc.mjs'

/**
 * Everything the host hands over in setup(), plus the two seams a test injects.
 *
 * Repopulated on every load and every reload -- setup() is called again on any
 * write under data/extensions -- which is why nothing here is a timer, a
 * listener or a subscription: a reload would leak one per load. Plain
 * assignment is idempotent, so re-running setup() is free.
 *
 * `clientFactory` and `fetchImpl` are the two keys the host never fills. They
 * are declared here, beside setup()'s own, so the seams are visible where every
 * other key on the shared state is: the Gmail client is built through
 * `clientFactory` and issues its requests through `fetchImpl`, falling back to
 * the module's own constructor and the global `fetch` when they are null. A
 * test sets both to doubles, so no request leaves the machine and no mailbox is
 * needed to run the suite. This file declares them and reads neither: the layer
 * that does is src/client.mjs, and both seams are on the shared state rather
 * than inside it so the reading surface, the outbound surface and the release
 * all reach one client instead of inventing three.
 */
export const state = {
  storage: null,
  settings: () => ({}),
  log: console,
  oauth: null,
  repo: null,
  clientFactory: null,
  fetchImpl: null,
}

/**
 * The workspace this file runs from. The MCP shim lives beside it under
 * `mcp/`, and the rpc's `mcpConfig` reports that path for the operator's
 * Settings > MCP Servers entry.
 */
const workspaceDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Where the host writes `run/port.json`, by the host's own rule in
 * `src/lib/server/data-dir.ts` (`resolveRunDir`), repeated here because an
 * extension may not import that file: when SWARMCLAW_HOME is set, `run/` sits
 * beside `data/` under that home, not inside it; otherwise it is `run/` under
 * DATA_DIR, which is the DATA_DIR variable when set and `<cwd>/data` when not.
 * The host's build-time branch is left out because the port file is written
 * only by a running server.
 *
 * A SECOND COPY OF ONE RULE, read from the same environment, and nothing on
 * this side can check that the host wrote where this says. That is why the
 * page shows the path -- so the operator can compare it with what is on disk --
 * and why `health` reports whether a file is there rather than assuming one is.
 * The shim reports a missing file by name and never guesses a port.
 */
function resolvePortFile() {
  const home = process.env.SWARMCLAW_HOME?.trim()
  if (home) return path.join(path.resolve(home), 'run', 'port.json')
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dataDir, 'run', 'port.json')
}

const gmail = {
  name: 'Gmail',
  version: '0.1.0',
  description: 'Egy Gmail-postafiók egy hitelesítés mögött: szerződés a kódnak valódi lapkurzorral, MCP-szerver az ügynököknek. Küldeni nem tud: a kiadás az operátoré, a lapról.',
  migrations: MIGRATIONS,
  /**
   * Synchronous and idempotent: it fills `state` and does nothing else. No
   * timer, no listener, no subscription and no file read, because the host
   * calls this again on every reload and the entry module has 30 seconds to
   * import before the host gives up on it.
   */
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = ctx.settings
    state.log = ctx.log
    state.oauth = ctx.oauth
    state.repo = createRepo(ctx.storage)
  },
  /**
   * No tools, on purpose (design spec 2.4).
   *
   * An agent running in this host reaches the mailbox through the same MCP
   * server as an agent running anywhere else, and that is the intent: the
   * difference between the two routes should be registration, not capability. A
   * tool set beside the MCP server would be one more surface over one
   * implementation, with a refusal translation of its own to keep in step.
   *
   * It has a price and the spec names it rather than hiding it: a tool would
   * receive `ctx.session.agentId` and an MCP call does not. That is why the
   * outbound rows record which DOOR a request came through and not who made it,
   * and why releasing a letter is a person's click rather than a caller's
   * permission.
   */
  tools: [],
  /**
   * What this extension's own page and its MCP shim may call, over
   * `POST /api/extensions/gmail.mjs/call/<method>` -- the host keys that route
   * on the extension's file id, which is `gmail.mjs`, not `gmail`.
   *
   * The wider of the two doors, and the one that carries `releaseDraft`, the
   * only method in this module that sends. See rpc.mjs for which methods are on
   * it, what that placement actually buys and what it does not.
   */
  rpc: createRpc(state, { workspaceDir, portFile: resolvePortFile() }),
  /**
   * What *another* extension may call, once it has named this contract and this
   * version in its own `consumes` and an operator has left it installed.
   *
   * Strictly smaller than `rpc` and separately declared, with its answers cut to
   * its own field lists: no release, no discard, no labelling, no writing to the
   * address book, and an outbound projection that carries neither the body nor
   * the resolved addresses. See contract.mjs for each absence and its reason.
   */
  provides: { [MAILBOX_CONTRACT]: createMailboxContract(state) },
  ui: {
    // NO PAGE. Both this module's surfaces are reachable without one: agents
    // call it over the MCP shim in `mcp/`, registered under Settings > MCP
    // Servers, and other extensions call the contract above. The page existed
    // mainly to hand the operator that MCP entry to copy, and once the entry is
    // registered it had nothing left to do, so the rail entry was dropped
    // rather than kept as a menu item nobody opens.
    //
    // `ui/` and its build script are still here. Restoring the page is putting
    // the `pages` declaration back and running `npm run build`.
    settingsFields: [
      // The two budgets of design spec 5.5, and they guard two different
      // risks rather than one in two sizes. A runaway consumer fills the
      // Drafts folder and stops; a runaway sequence of clicks, or a bundle on
      // an already logged-in page of this same app, sends. Enforcing them is
      // the outbound layer's, not this file's: nothing here reads these.
      { key: 'napiPiszkozat', label: 'Napi piszkozat-keret', type: 'number', placeholder: '20', defaultValue: 20, help: 'Ennyi piszkozat készülhet naponta. A keret betelte után a draft gmail_piszkozat_keret_kimerult-tal utasít el, névvel, nem csendben.' },
      { key: 'napiKiadas', label: 'Napi kiadási keret', type: 'number', placeholder: '10', defaultValue: 10, help: 'Ennyi levél adható ki naponta a lapról. A kiadás az egyetlen művelet, ami ténylegesen küld, és csak innen érhető el.' },
    ],
  },
}

export default gmail
