import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import publish, { SCHEDULES } from '../index.mjs'
import { AGENTS, IRO_SOUL, KULDO_SOUL, LEKTOR_SOUL } from '../src/agents.mjs'
import { LEKTOR_KODOK } from '../src/szoveg.mjs'

/**
 * What `src/agents.mjs` declares, checked against what actually exists:
 * the KÖTÖTT NÉV task-4-brief.md demands a test for, the skills each agent
 * names, and the vocabulary each soul uses against the tools each agent
 * actually carries.
 *
 * A smaller version of `extensions/video/test/agents.test.mjs`'s own
 * forward/reverse vocabulary walk -- three agents and five tools do not
 * need that file's full machinery, but the same failure mode it guards
 * against (a soul naming a tool the agent cannot call, or a tool the
 * declaration does not have) is checked here too.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const extensionRoot = path.resolve(here, '..')
const readSource = (relative) => fs.readFileSync(path.join(extensionRoot, relative), 'utf8')
const readSkill = (skill) => readSource(path.join('skills', skill, 'SKILL.md'))
const SOUL_BY_KEY = { 'publish-iro': IRO_SOUL, 'publish-lektor': LEKTOR_SOUL, 'publish-kuldo': KULDO_SOUL }

// --- the KÖTÖTT NÉV ----------------------------------------------------

test('AGENTS declares a publish-kuldo agent, spelled exactly the way SCHEDULES\' agentRef names it -- the néma meghibásodás task-4-brief.md warns about', () => {
  const kuldo = AGENTS.find((a) => a.agentKey === 'publish-kuldo')
  assert.ok(kuldo, 'src/agents.mjs must declare an agent whose agentKey is exactly "publish-kuldo"')
  const dispatch = SCHEDULES.find((s) => s.scheduleKey === 'publish-kikuldes')
  assert.ok(dispatch, 'index.mjs must still declare the publish-kikuldes schedule')
  assert.equal(dispatch.agentRef.resourceKey, kuldo.agentKey, 'a mismatch here is missing_agent_ref on the host side -- a silent, permanent skip')
  assert.ok(kuldo.tools.includes('publishDue'), 'the sender must be able to call the one tool its schedule asks it to')
})

test('the module actually declares three managed agents and one managed schedule together', () => {
  assert.equal(publish.managedResources.agents.length, 3)
  assert.equal(publish.managedResources.schedules.length, 1)
  assert.equal(publish.managedResources.agents, AGENTS)
  assert.equal(publish.managedResources.schedules, SCHEDULES)
})

// --- skills --------------------------------------------------------------

test('every skill a declaration names is a file that is present, and its frontmatter name matches the directory', () => {
  for (const agent of AGENTS) {
    for (const skill of agent.skills) {
      const file = path.join(extensionRoot, 'skills', skill, 'SKILL.md')
      assert.ok(fs.existsSync(file), `${agent.agentKey} names a skill with no SKILL.md: ${skill}`)
      const frontmatterName = readSkill(skill).match(/^---\r?\n[\s\S]*?^name:\s*(\S+)\s*$/m)
      assert.ok(frontmatterName, `${skill}/SKILL.md has no frontmatter name`)
      assert.equal(frontmatterName[1], skill)
    }
  }
})

test('no skill of this extension is marked always-on, because always-on has no owner', () => {
  for (const agent of AGENTS) {
    for (const skill of agent.skills) {
      const frontmatter = readSkill(skill).match(/^---\r?\n([\s\S]*?)^---\r?\n/m)
      assert.ok(frontmatter, `${skill}/SKILL.md has no frontmatter block`)
      assert.doesNotMatch(frontmatter[1], /^always:/m, `${skill} is always-on`)
    }
  }
})

/** The body as the host measures it: `normalizeSkillPayload` drops the frontmatter and trims, and the truncator trims again before measuring. Same helper as `extensions/video/test/agents.test.mjs`'s function of the same name. */
function skillBody(skill) {
  const parsed = readSkill(skill).match(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)
  assert.ok(parsed, `${skill}/SKILL.md has no frontmatter block`)
  return parsed[1].trimStart().trim()
}

test('both skills are under the per-skill cap the turn actually inlines them at', () => {
  // See `extensions/video/test/agents.test.mjs`'s test of the same name for
  // the full "two limits, the small one binds" reasoning. This copy pins the
  // same host constant, read from the host source rather than hardcoded, so
  // a host that moves it moves this test with it -- and does the same
  // "the host no longer has X" fallback check that file uses, rather than
  // silently passing on a regex that stopped matching.
  const resolver = fs.readFileSync(path.resolve(extensionRoot, '../../src/lib/server/skills/runtime-skill-resolver.ts'), 'utf8')
  const cap = resolver.match(/^const INLINED_SKILL_CHAR_CAP = (\d+)$/m)
  assert.ok(cap, 'the host no longer caps inlined skill content under that name; find what replaced it before trusting this test')
  const inlineCap = Number(cap[1])
  assert.ok(resolver.includes('truncateInlinedSkillContent(skill.content, skill.name)'), 'the cap is no longer applied where the pinned block is built')
  for (const skill of AGENTS.flatMap((a) => a.skills)) {
    const body = skillBody(skill)
    assert.ok(body.length <= inlineCap, `${skill} is ${body.length} characters; past ${inlineCap} the host cuts it`)
  }
  assert.ok(resolver.includes('MAX_SKILLS_PROMPT_CHARS'), 'the host no longer has a selection budget under that name')
})

test('the installer copies the skills into the layer the host discovers', () => {
  const installer = readSource('scripts/install.mjs')
  assert.ok(installer.includes("path.join(root, 'skills')"))
  assert.ok(installer.includes("path.join(home, 'skills', skill)"))
  assert.deepEqual(fs.readdirSync(path.join(extensionRoot, 'skills')).sort(), [...new Set(AGENTS.flatMap((a) => a.skills))].sort())
})

// --- tools: role separation and vocabulary --------------------------------

/** Host-provided capability ids a declaration may name that this extension never declares -- same reasoning as `extensions/video/test/agents.test.mjs`'s constant of the same name: `memory` covers several host tool names arriving over the platform MCP bridge, matched by id rather than by name. */
const HOST_TOOL_IDS = new Set(['memory'])

test('every tool a declaration names is a tool the extension declares (or a host id), and the roles are kept apart where they must be', () => {
  const declared = new Set(publish.tools.map((t) => t.name))
  assert.equal(declared.size, publish.tools.length, 'a tool name is declared twice')
  for (const agent of AGENTS) {
    for (const tool of agent.tools) {
      if (HOST_TOOL_IDS.has(tool)) continue
      assert.ok(declared.has(tool), `${agent.agentKey} is given ${tool}, which this extension does not declare`)
    }
  }
  const iro = new Set(AGENTS.find((a) => a.agentKey === 'publish-iro').tools)
  const lektor = new Set(AGENTS.find((a) => a.agentKey === 'publish-lektor').tools)
  const kuldo = new Set(AGENTS.find((a) => a.agentKey === 'publish-kuldo').tools)
  for (const writerOnly of ['publishOpen', 'publishDraft']) {
    assert.ok(iro.has(writerOnly))
    assert.equal(lektor.has(writerOnly), false, `the reviewer must not carry ${writerOnly}`)
    assert.equal(kuldo.has(writerOnly), false, `the sender must not carry ${writerOnly}`)
  }
  assert.ok(lektor.has('publishVerdict'))
  assert.equal(iro.has('publishVerdict'), false, 'the writer must not be able to review its own draft')
  assert.equal(kuldo.has('publishVerdict'), false)
  assert.ok(kuldo.has('publishDue'))
  assert.equal(iro.has('publishDue'), false)
  assert.equal(lektor.has('publishDue'), false)
  assert.ok(iro.has('publishQueue') && lektor.has('publishQueue'), 'both roles read the same work queue')
  // Every tool the extension declares is reachable by at least one managed agent.
  for (const name of declared) assert.ok(iro.has(name) || lektor.has(name) || kuldo.has(name), `${name} is declared but no managed agent can call it`)
})

/** Every backticked `name` and `` `name({...})` `` token in a soul -- the same shape `extensions/video/test/agents.test.mjs`'s `partsOf` reads. */
function backtickedNames(text) {
  const out = new Set()
  for (const m of text.matchAll(/`([a-zA-Z][a-zA-Z0-9_]*)/g)) out.add(m[1])
  return out
}

test('every tool name a soul uses in backticks is a tool that agent is actually declared with', () => {
  const toolNames = new Set(publish.tools.map((t) => t.name))
  for (const agent of AGENTS) {
    const named = backtickedNames(SOUL_BY_KEY[agent.agentKey])
    for (const tool of [...named].filter((n) => toolNames.has(n))) {
      assert.ok(agent.tools.includes(tool), `${agent.agentKey}'s soul names ${tool} but the declaration does not list it`)
    }
    for (const tool of agent.tools) {
      if (HOST_TOOL_IDS.has(tool)) continue
      assert.ok(named.has(tool), `${agent.agentKey} is given ${tool} but its soul never mentions it`)
    }
  }
})

/**
 * Every `` `toolName({ a, b })` `` call site a soul actually writes, as
 * `[tool, [keys]]`.
 *
 * READ OUT OF THE PROSE, not restated beside it. An earlier version of the
 * test below walked a hardcoded key list, which meant it asserted the tools'
 * schemas against themselves and passed unchanged when a soul was edited to
 * tell its agent to pass an argument no tool declares -- the one failure this
 * test exists to catch. The argument list may wrap across lines in a soul, so
 * the brace body is matched greedily-free rather than line by line.
 */
function soulCallSites(text) {
  const out = []
  for (const m of text.matchAll(/`([a-zA-Z][a-zA-Z0-9_]*)\(\{([^}]*)\}\)/g)) {
    out.push([m[1], m[2].split(',').map((k) => k.trim()).filter((k) => k !== '')])
  }
  return out
}

test('every argument a soul tells an agent to pass is declared by the tool it names', () => {
  const byName = new Map(publish.tools.map((t) => [t.name, t]))
  const latott = new Set()
  for (const agent of AGENTS) {
    for (const [tool, keys] of soulCallSites(SOUL_BY_KEY[agent.agentKey])) {
      assert.ok(byName.has(tool), `${agent.agentKey}'s soul shows a call to ${tool}({...}), which this extension does not declare`)
      assert.ok(agent.tools.includes(tool), `${agent.agentKey}'s soul shows a call to ${tool} but the declaration does not list it`)
      assert.ok(keys.length > 0, `${agent.agentKey}'s soul writes ${tool}({}) with no argument named -- either it takes none, and the braces should go, or name them`)
      const declared = new Set(Object.keys(byName.get(tool).parameters.properties || {}))
      for (const key of keys) {
        assert.ok(declared.has(key), `${agent.agentKey}'s soul tells the agent to pass ${tool}({ ${key} }), which ${tool} does not declare -- the run would send an argument the tool drops`)
      }
      latott.add(`${agent.agentKey}:${tool}`)
    }
  }
  // ...and the walk above is not vacuous: every argument-taking tool an agent
  // carries must have a call site in that agent's own soul, so deleting the
  // call sites cannot make this test pass by finding nothing to check.
  for (const agent of AGENTS) {
    for (const tool of agent.tools) {
      if (HOST_TOOL_IDS.has(tool)) continue
      if (Object.keys(byName.get(tool).parameters.properties || {}).length === 0) continue
      assert.ok(latott.has(`${agent.agentKey}:${tool}`), `${agent.agentKey} carries ${tool}, which takes arguments, but its soul never shows how to call it`)
    }
  }
  // publishQueue and publishDue take no arguments, and neither soul calls them with a parenthesised argument list.
  for (const name of ['publishQueue', 'publishDue']) {
    assert.deepEqual(Object.keys(byName.get(name).parameters.properties || {}), [])
  }
  assert.equal(/publishQueue\(\{/.test(IRO_SOUL), false)
  assert.equal(/publishDue\(\{/.test(KULDO_SOUL), false)
})

test('the four review codes the lektor soul lists are exactly LEKTOR_KODOK, and its count is stated correctly', () => {
  assert.equal(LEKTOR_KODOK.length, 4)
  for (const kod of LEKTOR_KODOK) assert.ok(LEKTOR_SOUL.includes(`\`${kod}\``), `LEKTOR_SOUL does not name ${kod}`)
  assert.ok(LEKTOR_SOUL.includes(`A ${LEKTOR_KODOK.length} kód`), 'the soul\'s own count of the review codes must track LEKTOR_KODOK.length')
})

test('the reviewer skill names every review code, and never contradicts its own count of them', () => {
  // Agent-facing prose: the skill's heading said "A NÉGY kód" and its closing
  // paragraph "nem fér a fenti HÁROMBA", so an agent reading it top to bottom
  // was told two different numbers for the same closed list. There is no
  // fallback for a reviewer that picks the wrong one -- it just files fewer
  // codes than exist.
  const body = skillBody('publikalas-lektoralas')
  for (const kod of LEKTOR_KODOK) assert.ok(body.includes(`\`${kod}\``), `the reviewer skill does not name ${kod}`)
  assert.ok(body.includes('A négy kód'), 'the skill states the code count in its heading')
  assert.equal(/fenti\s+(?:kettőbe|háromba|ötbe)/.test(body), false, 'the skill contradicts its own heading about how many codes there are')
  assert.ok(body.includes('fenti négybe'), 'the closing paragraph must name the same count as the heading')
})
