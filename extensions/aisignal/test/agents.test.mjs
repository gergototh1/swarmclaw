import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  AGENTS,
  KUTATO_SOUL,
  MAIL_PROMPT,
  RESEARCH_PROMPT,
  SCHEDULES,
  SCOUT_SOUL,
} from '../src/agents.mjs'
import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { RESEARCH_ID_SPACE, RESEARCH_SOURCES, createResearchTool } from '../src/research.mjs'
import { createSweepTools } from '../src/sweep.mjs'
import { memStorage } from './helpers.mjs'

/**
 * What a prompt promises, checked against what the tools actually do.
 *
 * A prompt cannot be tested the way a function can, so this file tests the part
 * of it that is a fact rather than a judgement: every name in it. A prompt that
 * tells the agent to call `signalSweep` with `sinceDays` is only correct while
 * a tool of that name declares a parameter of that name, and a prompt that
 * tells it to read `unavailable` off the answer is only correct while a run
 * actually returns that field.
 *
 * So the vocabulary these tests check against is not typed out here. Tool names
 * and parameter names are read off the live tool declarations, return fields
 * are read off real tool calls made in this file against injected doubles, and
 * the handful of prose terms that are neither -- a table name, the deck's ORDER
 * BY, the two truncation reasons -- are each pinned against the source that
 * owns them. Nothing in the allowlist is a claim this file makes on its own.
 *
 * Nothing here reaches the network or a credential: the Gmail client and
 * `fetch` are both injected.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const extensionRoot = path.resolve(here, '..')
const readSource = (relative) => fs.readFileSync(path.join(extensionRoot, relative), 'utf8')

const PROMPTS = Object.freeze({
  SCOUT_SOUL,
  KUTATO_SOUL,
  MAIL_PROMPT,
  RESEARCH_PROMPT,
})

/** A state object in the shape `setup()` fills, with both seams injected. */
function toolState({ gmail, fetchImpl, settings = {} } = {}) {
  const storage = memStorage()
  for (const m of MIGRATIONS) storage.raw.exec(m.sql ?? m.up ?? m)
  return {
    storage,
    settings: () => settings,
    log: { info() {}, warn() {}, error() {} },
    oauth: null,
    repo: createRepo(storage),
    gmailFactory: gmail ? () => gmail : null,
    fetchImpl: fetchImpl || null,
    researchTimeoutMs: 20,
    researchBudgetMs: 500,
  }
}

/** The Gmail client's shape, answering from canned data. */
function fakeGmail({ ids = [], labelFail = null } = {}) {
  return {
    labelId: async () => {
      if (labelFail) throw labelFail
      return 'LBL_AI'
    },
    mailbox: async () => 'owner@example.test',
    listIds: async () => ({ ids, truncated: false, stoppedOn: null }),
    getMessage: async (id) => ({
      id,
      subject: `S ${id}`,
      fromName: 'F',
      fromEmail: 'f@example.test',
      sentAt: null,
      text: 'body',
      textInAttachment: false,
    }),
  }
}

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 })

/**
 * A `fetch` double for the three research hosts. Every host answers an empty
 * but well-formed page unless `fail` is set, in which case nothing is
 * reachable and the run takes its failure path.
 */
function fakeFetch({ fail = false, reddit = { data: { children: [] } }, hn = { hits: [] }, github = { items: [] } } = {}) {
  return async (url) => {
    if (fail) throw new TypeError('fetch failed')
    const target = String(url)
    if (target.includes('reddit.com')) return jsonResponse(reddit)
    if (target.includes('hn.algolia.com')) return jsonResponse(hn)
    return jsonResponse(github)
  }
}

const toolsOf = (state) => [...createSweepTools(state), createResearchTool(state)]
const byName = (state) => new Map(toolsOf(state).map((t) => [t.name, t]))

// ---------------------------------------------------------------------------
// The declarations, against the rules the host applies to them
// ---------------------------------------------------------------------------

/*
 * These mirror src/lib/server/extension-managed-resources.ts. A declaration
 * that breaks one of them is not rejected loudly: `buildManagedAgent` answers
 * null and `buildManagedSchedule` answers a `{ skipped }` reason, and the
 * agent or schedule simply never appears. That is exactly the failure a test
 * has to catch, because nothing else will.
 */

test('every managed agent declaration has the key and name buildManagedAgent requires', () => {
  assert.equal(AGENTS.length, 2)
  for (const agent of AGENTS) {
    assert.equal(typeof agent.agentKey, 'string')
    assert.notEqual(agent.agentKey.trim(), '', 'a blank agentKey makes buildManagedAgent return null')
    assert.equal(typeof agent.displayName, 'string')
    assert.notEqual(agent.displayName.trim(), '')
    assert.equal(typeof agent.systemPrompt, 'string')
    assert.ok(agent.systemPrompt.trim().length > 0, 'an empty systemPrompt is replaced by the host with a placeholder')
    assert.ok(Array.isArray(agent.skills) && agent.skills.length > 0)
    assert.ok(Array.isArray(agent.tools) && agent.tools.length > 0)
  }
  assert.equal(new Set(AGENTS.map((a) => a.agentKey)).size, AGENTS.length, 'agent keys must be unique')
})

test('neither managed agent runs on a heartbeat', () => {
  // `heartbeatEnabled !== false` is how the host reads this field, so only the
  // literal false turns it off. These two agents open sweeps, and a sweep
  // opened outside a scheduled run is one more that can be left unclosed.
  for (const agent of AGENTS) assert.equal(agent.heartbeatEnabled, false)
})

test('no managed agent pins a provider, a model or a credential', () => {
  for (const agent of AGENTS) {
    for (const key of ['provider', 'model', 'apiEndpoint', 'credentialId', 'gatewayProfileId']) {
      assert.equal(agent[key], undefined, `${agent.agentKey} must leave ${key} to the operator`)
    }
  }
})

test('every managed schedule declaration survives buildManagedSchedule', () => {
  assert.equal(SCHEDULES.length, 2)
  const agentKeys = new Set(AGENTS.map((a) => a.agentKey))
  for (const schedule of SCHEDULES) {
    assert.notEqual((schedule.scheduleKey || '').trim(), '', 'blank key => invalid_schedule_declaration')
    assert.notEqual((schedule.displayName || '').trim(), '')
    // `missing_agent_ref`: the ref has to name kind 'agent' and a key this
    // extension actually declares, or the schedule is skipped entirely.
    assert.equal(schedule.agentRef.resourceKind, 'agent')
    assert.ok(agentKeys.has(schedule.agentRef.resourceKey), `${schedule.scheduleKey} points at an agent that is not declared`)
    // `missing_schedule_timing`: scheduleTiming() needs a cron, an intervalMs
    // or a runAt, and it looks at `cron` first.
    assert.equal(schedule.scheduleType, 'cron')
    assert.notEqual((schedule.cron || '').trim(), '')
    // normalizeScheduleStatus passes these five through and turns anything
    // else into 'paused'.
    assert.ok(['active', 'paused', 'completed', 'failed', 'archived'].includes(schedule.status))
    assert.equal(schedule.taskMode, 'task')
  }
  assert.equal(new Set(SCHEDULES.map((s) => s.scheduleKey)).size, SCHEDULES.length, 'schedule keys must be unique')
})

test('every managed schedule carries a task prompt, which is what arms the overlap guard', () => {
  /*
   * getScheduleSignatureKey answers '' unless the schedule has an agent id, a
   * task prompt AND a cron expression, and the scheduler's in-flight guard is
   * a no-op for an empty key. `taskPrompt` is the only one of the three a
   * declaration can silently lose: the host falls back to the description and
   * then to the title, so a schedule with no prompt still gets a non-empty
   * signature -- but it also runs the title as its prompt, which is not a run
   * at all. Pinning the real prompt covers both.
   */
  const prompts = new Map([
    ['aisignal-ketorankent', MAIL_PROMPT],
    ['aisignal-kutatas-napi', RESEARCH_PROMPT],
  ])
  for (const schedule of SCHEDULES) {
    assert.equal(schedule.taskPrompt, prompts.get(schedule.scheduleKey))
    assert.ok(schedule.taskPrompt.trim().length > 0)
  }
})

test('the two cron expressions fire on the cadence their comment claims, and never in the same minute', () => {
  const mail = SCHEDULES.find((s) => s.scheduleKey === 'aisignal-ketorankent')
  const research = SCHEDULES.find((s) => s.scheduleKey === 'aisignal-kutatas-napi')
  assert.equal(mail.cron, '0 */2 * * *')
  assert.equal(research.cron, '30 6 * * *')
  // Both are five-field expressions, which is what cron-parser is handed.
  for (const schedule of SCHEDULES) assert.equal(schedule.cron.split(' ').length, 5)
  // The mail run fires on minute 0, the research run on minute 30, so the two
  // cannot land in the same scheduler tick even on the hour they share.
  assert.notEqual(mail.cron.split(' ')[0], research.cron.split(' ')[0])
  // Both are read in the operator's timezone, not the server's.
  for (const schedule of SCHEDULES) assert.equal(schedule.timezone, 'Europe/Budapest')
})

// ---------------------------------------------------------------------------
// What a tool actually returns, so the vocabulary below is not a guess
// ---------------------------------------------------------------------------

/**
 * The fields a run answers with, read off real calls rather than transcribed.
 *
 * Both tools are asked twice, on their success path and on their failure path,
 * because the failure path is the one the prompts branch on: it carries the
 * same `sweepId` plus an `error`, and a prompt that treated the presence of a
 * `sweepId` as "the sweep is open" would close a sweep that is already closed.
 */
async function observedReturnFields() {
  const fields = new Set()
  const collect = (o) => { for (const k of Object.keys(o)) fields.add(k) }

  const mailOk = byName(toolState({ gmail: fakeGmail({ ids: ['m1'] }) })).get('signalSweep')
  collect(await mailOk.execute({}))

  const mailFail = byName(toolState({ gmail: fakeGmail({ labelFail: new Error('no such label') }) })).get('signalSweep')
  const failed = await mailFail.execute({})
  collect(failed)
  assert.ok(failed.error, 'the failure path must answer with an error')
  assert.ok(failed.sweepId, 'the failure path must still answer with a sweepId')

  const researchOk = byName(toolState({ fetchImpl: fakeFetch() })).get('researchSweep')
  collect(await researchOk.execute({}))

  const researchFail = byName(toolState({ fetchImpl: fakeFetch({ fail: true }) })).get('researchSweep')
  const researchFailed = await researchFail.execute({})
  collect(researchFailed)
  assert.ok(researchFailed.error)
  assert.ok(researchFailed.sweepId)

  // recordSignal's own answer, which the prompts read `merged` off.
  const state = toolState({ gmail: fakeGmail({ ids: ['m1'] }) })
  const tools = byName(state)
  const { sweepId } = await tools.get('signalSweep').execute({})
  collect(await tools.get('recordSignal').execute({
    sweepId,
    messageId: 'm1',
    headline: 'H',
    summary: 'Egy. Kettő.',
    score: 0.4,
    applyScore: 0.2,
  }))
  return fields
}

/** The fields one research candidate carries, read off a real run. */
async function observedCandidateFields() {
  const nowSec = Math.floor(Date.now() / 1000)
  const state = toolState({
    fetchImpl: fakeFetch({ hn: { hits: [{ objectID: '1', title: 'T', url: 'https://example.test/a', story_text: 'x', points: 3, created_at_i: nowSec }] } }),
  })
  const result = await byName(state).get('researchSweep').execute({})
  assert.ok(result.candidates.length > 0, 'the fixture must produce at least one candidate')
  return new Set(Object.keys(result.candidates[0]))
}

test('a failed sweep answers with a sweepId and is already closed, which is what the prompts branch on', async () => {
  const state = toolState({ gmail: fakeGmail({ labelFail: new Error('no such label') }) })
  const tools = byName(state)
  const failed = await tools.get('signalSweep').execute({})
  assert.ok(failed.sweepId)
  assert.ok(failed.error)
  // This is the sentence both prompts are written against: closing it again
  // throws, so "always close what you open" needs its one exception.
  await assert.rejects(
    () => tools.get('finishSweep').execute({ sweepId: failed.sweepId }),
    /already closed/,
  )
})

test('recordSignal refuses a missing or out-of-range score instead of storing an unranked row', async () => {
  const state = toolState({ gmail: fakeGmail({ ids: ['m1'] }) })
  const tools = byName(state)
  const { sweepId } = await tools.get('signalSweep').execute({})
  const base = { sweepId, messageId: 'm1', headline: 'H', summary: 'Egy. Kettő.', score: 0.4 }

  // The Hermes text this prompt came from said an omitted applyScore lands the
  // row at the end of the deck unranked. It does not: the call throws and
  // nothing is stored. Both prompts and both skills say so, and this is why.
  await assert.rejects(() => tools.get('recordSignal').execute({ ...base }), /applyScore must be a number between 0 and 1/)
  await assert.rejects(() => tools.get('recordSignal').execute({ ...base, applyScore: 5 }), /applyScore must be a number between 0 and 1/)
  assert.equal(state.repo.items({}).total, 0, 'a refused score must leave no row behind')
})

test('recordSignal answers merged rather than a rejection when the same key comes back', async () => {
  const state = toolState({ gmail: fakeGmail({ ids: ['m1'] }) })
  const tools = byName(state)
  const { sweepId } = await tools.get('signalSweep').execute({})
  const row = { sweepId, messageId: 'm1', headline: 'H', summary: 'Egy. Kettő.', url: 'https://example.test/a', score: 0.4, applyScore: 0.2 }
  const first = await tools.get('recordSignal').execute(row)
  const second = await tools.get('recordSignal').execute(row)
  assert.equal(first.merged, false)
  assert.equal(second.merged, true)
  // There is no `kept` field anywhere on this answer, which is why no prompt
  // may tell the agent to look for one.
  assert.equal('kept' in second, false)
})

// ---------------------------------------------------------------------------
// Every name a prompt uses
// ---------------------------------------------------------------------------

/**
 * The prose terms that are neither a tool name, a parameter nor a return field.
 *
 * Each is pinned below against the source that owns it, so none of them is a
 * claim this file makes alone. The last group is ordinary prose -- a display
 * name, an example URL, a JavaScript literal -- and is the only part of the
 * vocabulary that is simply written down.
 */
const PINNED_PROSE = Object.freeze({
  'apply_score DESC, score DESC': { file: 'src/db.mjs', why: "the deck's ORDER BY, which is what makes applyScore the axis" },
  cap: { file: 'src/gmail.mjs', why: 'one of the two listStoppedOn values' },
  page_ceiling: { file: 'src/gmail.mjs', why: 'the other listStoppedOn value' },
  seen: { file: 'src/db.mjs', why: 'the ext_aisignal_seen table the close marks' },
  'research_topics.json': { file: 'research_topics.json', why: 'the operator-owned topics file' },
})

const PLAIN_PROSE = Object.freeze([
  'Reddit', 'Hacker News', 'GitHub', // what a sourceName looks like on a card
  'link.mail.beehiiv.com/ss/c/<opaque>', // the worked example of a per-recipient tracking link
  'false', // the JavaScript literal, spoken about on its own
])

/**
 * `github:…` -> `github`, `ok: true` -> `ok`, anything else unchanged.
 *
 * The lookahead keeps a URL scheme whole: `http://` is one prose term, not a
 * field called `http` carrying `//`.
 */
function baseToken(token) {
  const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?!\/)\S+$/)
  return m ? m[1] : token
}

/** One line, so a match is not defeated by where the prose happens to wrap. */
const flat = (text) => text.replace(/\s+/g, ' ')

function backtickedTokens(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
}

/**
 * The deck query itself, not just the phrase.
 *
 * Pinning `apply_score DESC, score DESC` on its own is too weak: `items()`
 * carries the same phrase for its optional score ordering, so `board()` could
 * be reordered while the phrase still appeared in the file. Every prompt and
 * both skills tell the agent that the DECK sorts on applyScore, so the deck's
 * own statement is what has to hold.
 */
const DECK_QUERY = "SELECT * FROM ext_aisignal_items WHERE status = 'new' ORDER BY apply_score DESC, score DESC, created_at DESC, rowid DESC LIMIT ?"

test('every prose term that is not a tool name is pinned against the source that owns it', () => {
  for (const [term, { file }] of Object.entries(PINNED_PROSE)) {
    if (file === 'research_topics.json') {
      assert.ok(fs.existsSync(path.join(extensionRoot, file)), `${file} must exist`)
      continue
    }
    assert.ok(readSource(file).includes(term), `${file} no longer contains "${term}"; the prompts that name it are now wrong`)
  }
  // 'seen' is spoken about as a table, so the table is what gets pinned.
  assert.ok(readSource('src/db.mjs').includes('ext_aisignal_seen'))
  // And the deck really is ordered the way every prompt says it is.
  assert.ok(readSource('src/db.mjs').includes(DECK_QUERY), 'the deck is no longer ordered by applyScore; every prompt that says so is now wrong')
})

test('every backticked name in every prompt resolves to something that exists', async () => {
  const state = toolState({ gmail: fakeGmail(), fetchImpl: fakeFetch() })
  const tools = toolsOf(state)

  const vocabulary = new Set()
  for (const tool of tools) {
    vocabulary.add(tool.name)
    for (const parameter of Object.keys(tool.parameters?.properties || {})) vocabulary.add(parameter)
  }
  for (const field of await observedReturnFields()) vocabulary.add(field)
  for (const field of await observedCandidateFields()) vocabulary.add(field)
  for (const source of RESEARCH_SOURCES) vocabulary.add(source)
  vocabulary.add(RESEARCH_ID_SPACE)
  for (const agent of AGENTS) for (const skill of agent.skills) vocabulary.add(skill)
  // The one host tool both prompts name. It is not an extension tool, so it
  // cannot be read off the tool list; it is checked against the host's own
  // definition in the next test.
  vocabulary.add('web_fetch')
  for (const term of Object.keys(PINNED_PROSE)) vocabulary.add(term)
  for (const term of PLAIN_PROSE) vocabulary.add(term)

  const unknown = []
  for (const [label, text] of Object.entries(PROMPTS)) {
    for (const token of backtickedTokens(text)) {
      if (!vocabulary.has(baseToken(token))) unknown.push(`${label}: \`${token}\``)
    }
  }
  assert.deepEqual(unknown, [], 'a prompt names something that does not exist')
})

test('every backticked name in every managed skill resolves to something that exists', async () => {
  const state = toolState({ gmail: fakeGmail(), fetchImpl: fakeFetch() })
  const vocabulary = new Set()
  for (const tool of toolsOf(state)) {
    vocabulary.add(tool.name)
    for (const parameter of Object.keys(tool.parameters?.properties || {})) vocabulary.add(parameter)
  }
  for (const field of await observedReturnFields()) vocabulary.add(field)
  for (const field of await observedCandidateFields()) vocabulary.add(field)
  for (const source of RESEARCH_SOURCES) vocabulary.add(source)
  vocabulary.add(RESEARCH_ID_SPACE)
  for (const agent of AGENTS) {
    vocabulary.add(agent.agentKey)
    for (const skill of agent.skills) vocabulary.add(skill)
  }
  vocabulary.add('web_fetch')
  for (const term of Object.keys(PINNED_PROSE)) vocabulary.add(term)
  for (const term of PLAIN_PROSE) vocabulary.add(term)
  // Prose that only the skills use.
  for (const term of ['http://', 'https://', 'README']) vocabulary.add(term)

  const unknown = []
  for (const agent of AGENTS) {
    for (const skill of agent.skills) {
      const text = readSource(path.join('skills', skill, 'SKILL.md'))
      for (const token of backtickedTokens(text)) {
        if (!vocabulary.has(baseToken(token))) unknown.push(`${skill}: \`${token}\``)
      }
    }
  }
  assert.deepEqual(unknown, [], 'a skill names something that does not exist')
})

test('the vocabulary check would catch a tool name that does not exist', async () => {
  // The guard above is only worth having if breaking it is visible, so this is
  // the same walk over a prompt with one invented name spliced in.
  const state = toolState({ gmail: fakeGmail(), fetchImpl: fakeFetch() })
  const vocabulary = new Set(toolsOf(state).map((t) => t.name))
  const tampered = `${MAIL_PROMPT}\nHívd a \`signalSweepAll\`-t.`
  const unknown = backtickedTokens(tampered).filter((t) => !vocabulary.has(baseToken(t)))
  assert.ok(unknown.includes('signalSweepAll'))
})

test('every argument the prompts tell the agent to pass is declared by the tool it names', () => {
  const state = toolState()
  const tools = byName(state)
  const declared = (name) => new Set(Object.keys(tools.get(name).parameters.properties))
  const required = (name) => new Set(tools.get(name).parameters.required || [])

  for (const key of ['label', 'sinceDays', 'maxMessages']) {
    assert.ok(declared('signalSweep').has(key), `signalSweep must declare ${key}`)
  }
  for (const key of ['sweepId', 'messageId', 'headline', 'summary', 'url', 'sourceName', 'sourceEmail', 'sentAt', 'score', 'applyScore', 'why', 'linkRead']) {
    assert.ok(declared('recordSignal').has(key), `recordSignal must declare ${key}`)
  }
  // The prompts and both skills say these two are mandatory. They are only
  // mandatory while the tool says so.
  assert.ok(required('recordSignal').has('score'))
  assert.ok(required('recordSignal').has('applyScore'))
  for (const key of ['sweepId', 'ok', 'note']) {
    assert.ok(declared('finishSweep').has(key), `finishSweep must declare ${key}`)
  }
  for (const key of ['topics', 'days']) {
    assert.ok(declared('researchSweep').has(key), `researchSweep must declare ${key}`)
  }
})

test('the tools each agent is declared with, and the tools its prompt names, are the same set', () => {
  const state = toolState()
  const extensionToolNames = new Set(toolsOf(state).map((t) => t.name))
  for (const agent of AGENTS) {
    const declaredExtensionTools = agent.tools.filter((t) => extensionToolNames.has(t))
    const prompt = agent.agentKey === 'signal-scout' ? SCOUT_SOUL : KUTATO_SOUL
    for (const tool of declaredExtensionTools) {
      assert.ok(prompt.includes(`\`${tool}\``), `${agent.agentKey} is given ${tool} but never told about it`)
    }
    for (const tool of extensionToolNames) {
      if (prompt.includes(`\`${tool}\``)) {
        assert.ok(declaredExtensionTools.includes(tool), `${agent.agentKey}'s prompt uses ${tool} but the declaration does not list it`)
      }
    }
  }
})

test('web_fetch is the host tool both prompts name, and the agents carry the tool id that gates it', () => {
  // `web` is the built-in tool id; `web_fetch` is the tool name inside it, and
  // both prompts tell the agent to read a link with it. An agent whose
  // declaration lost `web` would be told to use a tool it does not have.
  for (const agent of AGENTS) assert.ok(agent.tools.includes('web'))
  assert.ok(SCOUT_SOUL.includes('`web_fetch`'))
  assert.ok(KUTATO_SOUL.includes('`web_fetch`'))
  const hostWebTool = fs.readFileSync(path.resolve(extensionRoot, '../../src/lib/server/session-tools/web.ts'), 'utf8')
  assert.ok(hostWebTool.includes("name: 'web_fetch'"), 'the host no longer defines web_fetch under that name')
  const hostToolIds = fs.readFileSync(path.resolve(extensionRoot, '../../src/lib/tool-definitions.ts'), 'utf8')
  assert.ok(hostToolIds.includes("id: 'web'"), 'the host no longer defines the web tool id')
})

// ---------------------------------------------------------------------------
// The skills the declarations name
// ---------------------------------------------------------------------------

test('every skill a declaration names is a skill file that is present and named the same', () => {
  for (const agent of AGENTS) {
    for (const skill of agent.skills) {
      const file = path.join(extensionRoot, 'skills', skill, 'SKILL.md')
      assert.ok(fs.existsSync(file), `${agent.agentKey} names a skill with no SKILL.md: ${skill}`)
      const content = fs.readFileSync(file, 'utf8')
      // The host's discovery reads the frontmatter `name` and falls back to the
      // directory only when there is none, so the declaration matches the
      // frontmatter. A directory and a frontmatter that disagree produce a
      // skill nothing can attach.
      const frontmatterName = content.match(/^---\r?\n[\s\S]*?^name:\s*(\S+)\s*$/m)
      assert.ok(frontmatterName, `${skill}/SKILL.md has no frontmatter name`)
      assert.equal(frontmatterName[1], skill)
    }
  }
})

test('the installer copies the skills into the layer the host discovers', () => {
  // discoverSkills() scans <swarmclaw-home>/skills, never an extension's own
  // tree, so a skill that install.mjs does not copy is a skill the agent that
  // names it never sees.
  const installer = readSource('scripts/install.mjs')
  assert.ok(installer.includes("path.join(root, 'skills')"))
  assert.ok(installer.includes("path.join(home, 'skills', skill)"))
})

// ---------------------------------------------------------------------------
// The five statements the prompts had to correct, and the one rule they share
// ---------------------------------------------------------------------------

const EVERY_TEXT = () => [
  ...Object.entries(PROMPTS),
  ...AGENTS.flatMap((a) => a.skills.map((s) => [s, readSource(path.join('skills', s, 'SKILL.md'))])),
]

test('no prompt or skill reintroduces a tool behaviour that does not exist', () => {
  /*
   * Each of these was in the Hermes text and describes something this
   * extension's tools do not do. They are searched for rather than argued
   * about, because the failure mode is an edit that pastes the old paragraph
   * back in.
   */
  const gone = [
    'kept: false', // recordSignal answers { id, merged }; nothing counts rows
    'unreachable', // researchSweep answers `unavailable` and `notAsked`
    'candidateCap', // there is no budget object
    'applyMin',
    'deckMinScore',
    'mcp__aisignal__', // the Hermes tool prefix
    'WebFetch', // Hermes's link reader; here it is web_fetch
  ]
  for (const [label, text] of EVERY_TEXT()) {
    for (const term of gone) {
      assert.ok(!text.includes(term), `${label} still says "${term}", which no tool here does`)
    }
  }
})

test('both prompts tell the agent not to close a sweep that failed', () => {
  for (const [label, text] of [['MAIL_PROMPT', MAIL_PROMPT], ['RESEARCH_PROMPT', RESEARCH_PROMPT], ['SCOUT_SOUL', SCOUT_SOUL], ['KUTATO_SOUL', KUTATO_SOUL]]) {
    assert.ok(text.includes('`error`'), `${label} must name the error field a failed sweep carries`)
    assert.ok(/[Nn]e hívd a `finishSweep`|nem hívom a `finishSweep`/.test(flat(text)), `${label} must say not to close an already-closed sweep`)
  }
})

test('both prompts say the two scores are mandatory and are refused rather than clamped', () => {
  for (const [label, text] of EVERY_TEXT()) {
    assert.ok(text.includes('applyScore'), `${label} must name applyScore`)
    assert.ok(/KÖTELEZŐ|kötelező/.test(text), `${label} must say both scores are mandatory`)
  }
  for (const [label, text] of [['MAIL_PROMPT', MAIL_PROMPT], ['RESEARCH_PROMPT', RESEARCH_PROMPT]]) {
    assert.ok(/NEM ÍRÓDIK BE/.test(text), `${label} must say the row is not written when a score is refused`)
  }
})

test('the mail prompt says sinceDays can only widen the window', () => {
  assert.ok(MAIL_PROMPT.includes('`sinceDays`'))
  assert.ok(/csak tágítani tud/.test(MAIL_PROMPT))
  assert.ok(/csak tágítani tud/.test(SCOUT_SOUL))
})

test('the research prompt keeps unavailable and notAsked apart', () => {
  for (const [label, text] of [['RESEARCH_PROMPT', RESEARCH_PROMPT], ['KUTATO_SOUL', KUTATO_SOUL], ['kkv-kutatas', readSource('skills/kkv-kutatas/SKILL.md')]]) {
    assert.ok(text.includes('`unavailable`'), `${label} must name unavailable`)
    assert.ok(text.includes('`notAsked`'), `${label} must name notAsked`)
    assert.ok(/nincs a `notAsked`-ben/.test(text), `${label} must say what unavailable-but-asked means`)
  }
})

test('the research prompt says a research run advances no watermark', () => {
  assert.ok(/nincs vízjel/.test(KUTATO_SOUL))
  assert.ok(KUTATO_SOUL.includes('`public-web`'))
})

test('both agents are told the note is diagnostic prose that nothing parses', () => {
  for (const [label, text] of [['MAIL_PROMPT', MAIL_PROMPT], ['RESEARCH_PROMPT', RESEARCH_PROMPT], ['SCOUT_SOUL', SCOUT_SOUL], ['KUTATO_SOUL', KUTATO_SOUL]]) {
    assert.ok(/olvassa vissza gépileg/.test(text), `${label} must say nothing parses the note back`)
  }
})

test('every prompt says fetched content is data and says what to do with an injection attempt', () => {
  for (const [label, text] of EVERY_TEXT()) {
    assert.ok(/ADAT|adat, nem utasítás|adatként/.test(text), `${label} must say fetched content is data, not instruction`)
  }
  // The counterexample the rule has to survive, and the three-step answer to
  // it. A rule that only says "do not obey" leaves an agent that meets one
  // deciding between obeying and halting, and halting loses the run.
  for (const [label, text] of [['MAIL_PROMPT', MAIL_PROMPT], ['RESEARCH_PROMPT', RESEARCH_PROMPT], ['SCOUT_SOUL', SCOUT_SOUL], ['KUTATO_SOUL', KUTATO_SOUL]]) {
    assert.ok(flat(text).includes('Ignore your previous instructions'), `${label} must name the counterexample`)
    assert.ok(/menj tovább|Továbbmegyek/.test(flat(text)), `${label} must tell the agent to carry on`)
    assert.ok(/félbehagyni|nem ok a futás megszakítására/.test(flat(text)), `${label} must say an injection is not a reason to stop`)
  }
})

test('neither soul tells the agent it may take orders from a source', () => {
  for (const [label, text] of [['SCOUT_SOUL', SCOUT_SOUL], ['KUTATO_SOUL', KUTATO_SOUL]]) {
    assert.ok(/Az egyetlen hely, ahonnan feladatot kapok/.test(text), `${label} must name the only source of its instructions`)
  }
})
