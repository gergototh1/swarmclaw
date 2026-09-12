import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpBridge } from '../src/mcp-bridge.mjs'
import crm from '../index.mjs'
import { AGENTS } from '../src/agents.mjs'

/**
 * A híd az, amit egy CLI-provideres ügynök ér el a tool-réteg helyett, mert
 * azt egy ilyen provider soha nem kapja meg. Az itt szereplő esetek mind
 * olyan módok, ahogyan az MCP-n átmenő hívás csendben megváltoztathatná azt,
 * amit a tool lát.
 *
 * A src/mcp-bridge.mjs byte-azonos minden extension-ben, és ezt az
 * extensions/mcp-shim-parity.test.mjs őrzi -- ez a fájl a generikus
 * hídlogikát a testvér-extensionök (aisignal, docs, video) mintáját követve
 * fixture-ökkel fedi, plusz a CRM-specifikus varratot: hogy a `crm.tools`
 * tényleg elérhető a hídon, és minden meghirdetett eszköz sémája használható.
 */

const tools = () => [
  {
    name: 'echo',
    description: 'gives back what it got',
    parameters: { type: 'object', properties: { a: { type: 'string' } } },
    execute: (args, ctx) => ({ args, ctx }),
  },
  { name: 'bare', execute: () => ({ ok: true }) },
]

test('mcpTools renames parameters to inputSchema and changes nothing else', () => {
  const { mcpTools } = createMcpBridge(tools)
  const listed = mcpTools().tools
  assert.deepEqual(listed[0], {
    name: 'echo',
    description: 'gives back what it got',
    inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
  })
})

test('a tool with no schema is advertised as taking an empty object, not dropped', () => {
  // Omitting it would hide a working tool, and MCP has no way to say
  // "arguments unspecified".
  const { mcpTools } = createMcpBridge(tools)
  const bare = mcpTools().tools.find((t) => t.name === 'bare')
  assert.deepEqual(bare, { name: 'bare', description: '', inputSchema: { type: 'object', properties: {} } })
})

test('mcpTools reads the tools on every call rather than capturing them', () => {
  let current = [{ name: 'first', execute: () => ({}) }]
  const { mcpTools } = createMcpBridge(() => current)
  assert.deepEqual(mcpTools().tools.map((t) => t.name), ['first'])
  current = [{ name: 'second', execute: () => ({}) }]
  assert.deepEqual(mcpTools().tools.map((t) => t.name), ['second'])
})

test('mcpCall runs the named tool and forwards its arguments unchanged', async () => {
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'echo', args: { a: 'x' } })
  assert.deepEqual(out.args, { a: 'x' })
})

test('mcpCall builds the session shape a tool expects from the stamped caller', async () => {
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'echo', args: {}, agentId: 'a1', agentName: 'Signal Scout', sessionId: 's1' })
  assert.equal(out.ctx.session.agentId, 'a1')
  assert.equal(out.ctx.session.id, 's1')
  // A CRM-3 az idővonalra ebből tölti a `generated_by_agent_id`-t; enélkül
  // az emberi és a gépi bejegyzés nem válna el egymástól.
  assert.deepEqual(out.ctx.session.agentRecord, { id: 'a1', name: 'Signal Scout' })
})

test('a missing caller leaves the session blank rather than inventing one', async () => {
  // Egy olyan tool, ami a hívóra kapuz, "senkit" kell hogy lásson, nem egy
  // hihetőnek tűnő álnevet, ami átengedné a hívást.
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'echo', args: {} })
  assert.equal(out.ctx.session.agentId, null)
  assert.equal(out.ctx.session.id, null)
  assert.equal('agentRecord' in out.ctx.session, false)
})

test('an empty-string caller is treated as absent', async () => {
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'echo', args: {}, agentId: '', agentName: '' })
  assert.equal(out.ctx.session.agentId, null)
  assert.equal('agentRecord' in out.ctx.session, false)
})

test('mcpCall refuses an unknown tool as a value and names the ones that exist', async () => {
  // Egy 500 itt az ügynöknek úgy nézne ki, mintha az extension lenne törött,
  // és leállna, ahelyett hogy a nevet javítaná.
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'nincs_ilyen', args: {} })
  assert.equal(out.error.code, 'mcp_unknown_tool')
  assert.match(out.error.message, /echo/)
})

test('mcpCall refuses a body with no tool name', async () => {
  const { mcpCall } = createMcpBridge(tools)
  assert.equal((await mcpCall({})).error.code, 'mcp_bad_request')
  assert.equal((await mcpCall({ tool: '' })).error.code, 'mcp_bad_request')
})

test('a non-object args becomes an empty object rather than reaching the tool', async () => {
  const { mcpCall } = createMcpBridge(tools)
  assert.deepEqual((await mcpCall({ tool: 'echo', args: 'nem objektum' })).args, {})
})

test("a tool's own throw is left to propagate, so the host reports it", async () => {
  const { mcpCall } = createMcpBridge(() => [{ name: 'dobo', execute: () => { throw new Error('belso hiba') } }])
  await assert.rejects(() => mcpCall({ tool: 'dobo', args: {} }), /belso hiba/)
})

/**
 * A host ezt a huzalozást olvassa (`index.mjs`): `{ ...createRpc(state),
 * ...createMcpBridge(() => crm.tools) }`. Ha valaki elrontja a spread
 * sorrendjét, vagy átnevezi a `crm.tools`-t, ez a teszt bukik -- máskülönben
 * semmi nem buknék addig, amíg egy élő ügynök nem hívna egy CRM-tool-t az
 * MCP-n, és csendben nem kapna vissza semmit.
 */
test('every tool the extension declares is reachable over the bridge', () => {
  const listed = crm.rpc.mcpTools().tools.map((t) => t.name)
  const declared = crm.tools.map((t) => t.name)
  assert.deepEqual(listed, declared)
  assert.deepEqual(declared.sort(), listed.slice().sort(), 'mindkét irányban egyeznie kell a névhalmaznak')
  assert.ok(listed.includes('crm_search'), 'a keresés a legalapvetőbb eszköz, aminek mindenképp működnie kell')
})

/**
 * A `mcpTools()` a `state.repo`-t nem olvassa: a `createTools(state)` a
 * `repo()` hívást az `execute`-on belülre teszi, tehát a séma-tükrözés
 * setup() nélkül, adatbázis nélkül is helyes. Ezért ez a teszt nem hív
 * `memStorage()`-t -- a valós huzalozást (`crm.rpc`, `crm.tools`) vizsgálja,
 * setup() lefuttatása nélkül, ahogy a leírás is kéri.
 */
test('every advertised tool carries a usable inputSchema', () => {
  const listed = crm.rpc.mcpTools().tools
  assert.equal(listed.length, crm.tools.length)
  for (const tool of listed) {
    assert.equal(typeof tool.inputSchema, 'object')
    assert.notEqual(tool.inputSchema, null)
    assert.equal(tool.inputSchema.type, 'object')
  }
})

test('a tool with required arguments still declares them after translation', () => {
  const listed = crm.rpc.mcpTools().tools
  const search = listed.find((t) => t.name === 'crm_search')
  assert.deepEqual(search.inputSchema.required, ['query'])
  const account = listed.find((t) => t.name === 'crm_account')
  assert.deepEqual(account.inputSchema.required, ['accountId'])
})

/**
 * A CRM-2 egyetlen író eszköze, `crm_sweep`, névvel is átmegy a hídon: a
 * séma-tükrözés generikus (a fenti két teszt bármelyik eszközre igaz lenne),
 * de ez nevesítve őrzi, hogy a `max` paraméter -- ami nem kötelező -- tényleg
 * `inputSchema.properties.max`-ként landol, `required` nélkül.
 */
/**
 * I2: a hid a TELJES tool-tablat hirdeti, es nem nezi meg az ugynok
 * deklaraciojat. Ebben a telepitesben minden ugynok `claude-cli`-n fut, tehat
 * a CRM-et KIZAROLAG ezen a hidon eri el -- vagyis az `AGENTS[*].tools` nem
 * korlatozza, mit hivhat meg. Egy eszkoz "visszatartasa" azzal, hogy nem
 * soroljuk fel a grantok kozott, semmit nem tart vissza; ki kell venni a
 * `tools` tablabol (lasd `crm_commitment_link`).
 */
test('a hid a TELJES tool-tablat hirdeti -- az AGENTS[*].tools nem szukiti', () => {
  const listed = crm.rpc.mcpTools().tools.map((t) => t.name)
  assert.deepEqual(listed.slice().sort(), crm.tools.map((t) => t.name).sort())
  // A grantok kozott egyetlen tool-nev sincs (host capability azonositok
  // allnak ott), megis minden tool atmegy a hidon:
  assert.equal(AGENTS[0].tools.some((grant) => listed.includes(grant)), false,
    'a grantok nem tool-nevek, tehat a hid nem is tudna beloluk szurni')
  for (const nev of ['crm_sweep', 'crm_note', 'crm_attention']) {
    assert.ok(listed.includes(nev), `${nev} atmegy a hidon, fuggetlenul a grantoktol`)
  }
})

/**
 * A `crm_commitment_link` az egyetlen eszkoz volt, ami egy figyelem-sort
 * VEGLEGESEN el tudott tuntetni (`linkCommitmentTask`: csupasz UPDATE, a
 * feladat letezesenek ellenorzese nelkul). A hidon at elerheto volt, barmit is
 * mond a deklaracio -- ezert nem "visszatartva", hanem torolve lett.
 */
test('a crm_commitment_link a hidon sem erheto el', () => {
  const listed = crm.rpc.mcpTools().tools.map((t) => t.name)
  assert.equal(listed.includes('crm_commitment_link'), false)
})

test('a crm_sweep is elerheto a hidon, opcionalis max parameterrel', () => {
  const listed = crm.rpc.mcpTools().tools
  const sweep = listed.find((t) => t.name === 'crm_sweep')
  assert.ok(sweep, 'a crm_sweep-nek meg kell jelennie a hidon')
  assert.equal(sweep.inputSchema.type, 'object')
  assert.equal(sweep.inputSchema.properties.max.type, 'number')
  assert.equal('required' in sweep.inputSchema, false, 'a max opcionalis, nincs required tomb')
})
