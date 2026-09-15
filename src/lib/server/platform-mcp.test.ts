import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'

import { PLATFORM_MCP_TOOL_NAMES, inputSchemaOf, isPlatformMcpToolName } from './platform-mcp'

/**
 * This bridge is the one place where SwarmClaw's own tools leave the process
 * that owns their gates, so what it may and may not offer is worth pinning.
 * The gate behaviour itself is not re-tested here: the bridge deliberately owns
 * no gate, it hands the whole decision to `buildSessionTools()`. What IS tested
 * is that the list stays an allow-list, and that the families a CLI provider
 * already has never appear on it.
 */
describe('PLATFORM_MCP_TOOL_NAMES', () => {
  it('offers the coordination tools, which are the reason the bridge exists', () => {
    for (const name of ['spawn_subagent', 'manage_tasks', 'manage_agents', 'manage_schedules']) {
      assert.ok(PLATFORM_MCP_TOOL_NAMES.includes(name), `${name} must be reachable or an agent cannot direct another`)
    }
  })

  it('never offers a family the CLI provider already ships', () => {
    // A second `files` next to Claude Code's own file tools gives the model two
    // ways to do one thing and a reason to pick wrong.
    const cliOwns = [
      'shell', 'execute', 'files', 'edit_file',
      'web', 'web_search', 'web_fetch', 'web_extract', 'web_crawl',
      'browser', 'openclaw_browser', 'extension_creator_tool',
    ]
    for (const name of cliOwns) {
      assert.equal(PLATFORM_MCP_TOOL_NAMES.includes(name), false, `${name} duplicates a tool the CLI already has`)
    }
  })

  it('does not offer `delegate`, which would be Claude Code delegating to Claude Code', () => {
    // Every agent reaching this bridge already runs on a coding CLI, so this
    // tool would spend a second subscription to do what the caller was about
    // to do itself. Agent-to-agent delegation is spawn_subagent.
    assert.equal(PLATFORM_MCP_TOOL_NAMES.includes('delegate'), false)
  })

  it('has no duplicates, so a name cannot be advertised twice', () => {
    assert.equal(new Set(PLATFORM_MCP_TOOL_NAMES).size, PLATFORM_MCP_TOOL_NAMES.length)
  })

  it('is a closed list rather than a pattern', () => {
    // An allow-list is the point: a deny-list would quietly start exporting the
    // next native tool somebody adds to the host.
    for (const name of PLATFORM_MCP_TOOL_NAMES) {
      assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} is not a plain tool name`)
    }
  })
})

/*
 * A híd továbbadja, KI kérdez.
 *
 * A `spawn_subagent` ebből írja a gyerek session `parentSessionId`-jét
 * (`subagent-runtime.ts`: `context.sessionId || null`). Amíg a híd
 * bedrótozott `null`-t adott át, minden CLI-provider ügynök szülő nélküli
 * gyereket hagyott maga után -- és mivel MINDEN ilyen ügynök ezen a hídon jár,
 * a tárolt subagent sessionök egyikén sem volt szülő, tehát semmi nem tudta
 * őket a szülő chathez kötni.
 *
 * Ez forrás-szintű őrszem, nem viselkedési teszt: ez a modul `getAgent`-et és
 * `buildSessionTools`-t hív, amiket kimockolni itt aránytalan lenne. Annyit
 * bizonyít, hogy a bedrótozott `null` nem jön vissza észrevétlenül.
 */
describe('the platform MCP bridge passes the caller session on', () => {
  const src = readFileSync(new URL('./platform-mcp.ts', import.meta.url), 'utf8')

  it('does not hand buildSessionTools a hardcoded null session', () => {
    assert.doesNotMatch(src, /^\s*sessionId:\s*null,/m)
  })

  it('reads the session off the caller stamp', () => {
    assert.match(src, /function callerSessionId\(caller: PlatformMcpCaller\)/)
    assert.match(src, /toolsForAgent\(agentId, callerSessionId\(caller\)\)/)
  })
})

/*
 * A híd nem hirdethet paraméter nélküli toolt.
 *
 * MIÉRT. A natív képességek kétszer írják le magukat: egyszer az Extension
 * deszkriptorban (`tools[].parameters`, valódi JSON Schema), egyszer a legacy
 * LangChain hídban (`tool(fn, { schema })`). A legacy híd fele
 * `z.object({}).passthrough()`-t ad meg -- a LangGraph úton ez ártalmatlan,
 * mert az `execute` úgyis lazán olvassa az argumentumokat, MCP-n viszont ez az
 * egyetlen forrás: az `inputSchemaOf` ezt rendereli, és az agent
 * `{"type":"object","properties":{}}`-t lát.
 *
 * Élesben mérve (2026-09-14, `POST /api/platform-mcp`, agentId=default): a 25
 * hirdetett toolból 11-nek nem volt egyetlen property-je sem, köztük MIND a hat
 * memória-toolnak és a `schedule_wake`-nek. Következmény: a 347 memóriából 42
 * tartós, abból 40-en nincs `importance`, 15-nek a címe `Untitled`, a
 * `schedule_wake` egyetlen hívása pedig `delayMinutes: undefined`-dal jött
 * létre (`watch_jobs` 1df02819902d384c2365, "Scheduled wake in undefined
 * minutes", runAt=null, két napja nem tüzelt).
 */
describe('inputSchemaOf falls back to the native descriptor', () => {
  const emptyBridge = (name: string) => ({
    name,
    description: '',
    schema: z.object({}).passthrough(),
  }) as unknown as StructuredToolInterface

  const propsOf = (tool: StructuredToolInterface): Record<string, unknown> => {
    const schema = inputSchemaOf(tool)
    const props = schema.properties
    return props && typeof props === 'object' ? props as Record<string, unknown> : {}
  }

  it('renders schedule_wake with the arguments it actually takes', () => {
    // Enélkül az agent kitalálja a nevüket, a `delayMinutes < 0 ||
    // delayMinutes > 43200` őr pedig `undefined`-ra mindkét ágon hamis.
    const props = propsOf(emptyBridge('schedule_wake'))
    assert.ok('delayMinutes' in props, 'delayMinutes must be advertised')
    assert.ok('message' in props, 'message must be advertised')
  })

  it('renders every memory write tool with importance and abstract', () => {
    // Ez a két mező dönti el, hogy a memória rangsorolható-e egyáltalán:
    // `importance` a salience szorzója (memory-db.ts), `abstract` az, amit a
    // recall-blokk kiír a nyers tartalom helyett.
    for (const name of ['memory', 'memory_tool', 'memory_store', 'memory_update']) {
      const props = propsOf(emptyBridge(name))
      assert.ok('importance' in props, `${name} must advertise importance`)
      assert.ok('abstract' in props, `${name} must advertise abstract`)
    }
  })

  it('renders memory_store with the fields a durable fact needs', () => {
    const props = propsOf(emptyBridge('memory_store'))
    for (const field of ['title', 'value', 'category', 'linkedMemoryIds']) {
      assert.ok(field in props, `memory_store must advertise ${field}`)
    }
  })

  it('keeps a real zod schema instead of overwriting it with the descriptor', () => {
    // A tartalék csak akkor lép be, ha a renderelés üres. Egy toolnak, ami
    // rendes sémát hoz, nem szabad elveszítenie a saját mezőit.
    const real = {
      name: 'schedule_wake',
      description: '',
      schema: z.object({ onlyThis: z.string() }),
    } as unknown as StructuredToolInterface
    const props = propsOf(real)
    assert.deepEqual(Object.keys(props), ['onlyThis'])
  })

  it('leaves an unknown tool alone rather than inventing a schema', () => {
    const schema = inputSchemaOf(emptyBridge('not_a_native_tool'))
    assert.equal(schema.type, 'object')
  })
})

/*
 * A névre generált delegálási toolok is átjutnak a hídon.
 *
 * A `PLATFORM_MCP_TOOL_NAMES` fix névlista, a `delegate_to_<név>` toolokat
 * viszont a flotta határozza meg futásidőben. Ha az allow-list csak a fix
 * neveket engedné, a `buildSubagentTools` legyártaná őket, a híd pedig némán
 * kiszűrné mindet -- pontosan az a hibaosztály, amit ez a terv javít.
 *
 * Az allow-list ettől nem lesz minta-alapú: a delegálási előtag CSAK akkor
 * járható, ha a `spawn_subagent` maga is engedélyezett, és a toolokat ugyanaz a
 * `delegationEnabled`-re kötött builder gyártja.
 */
describe('isPlatformMcpToolName', () => {
  it('accepts every fixed name', () => {
    for (const name of PLATFORM_MCP_TOOL_NAMES) {
      assert.ok(isPlatformMcpToolName(name), `${name} must stay reachable`)
    }
  })

  it('accepts a generated per-teammate delegation tool', () => {
    assert.ok(isPlatformMcpToolName('delegate_to_fejleszto'))
    assert.ok(isPlatformMcpToolName('delegate_to_video_lektor'))
  })

  it('still refuses a tool the CLI already ships', () => {
    for (const name of ['shell', 'files', 'web_search', 'delegate', 'browser']) {
      assert.equal(isPlatformMcpToolName(name), false, `${name} must stay off the bridge`)
    }
  })

  it('refuses a name that merely looks delegation-ish', () => {
    for (const name of ['delegate_to', 'delegate_to_', 'delegateto_x', 'DELEGATE_TO_X', 'delegate_to_x-y']) {
      assert.equal(isPlatformMcpToolName(name), false, `${name} is not a generated delegation tool`)
    }
  })
})
