import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/*
 * THIS FILE GETS ITS OWN DATA DIRECTORY
 * =====================================
 * Every test here saves agents, schedules and settings, and one of them DELETES
 * the instance's `default` agent to reach the state the route fallback exists
 * for. Against the real DATA_DIR -- the developer's own database -- the
 * `afterEach` restore is not a safety net: `ensureDefaultAgent` re-seeds a
 * default only when the agents table is EMPTY, which it is not here, so a
 * Ctrl-C, a CI timeout or a throw between the delete and the restore leaves the
 * instance permanently without a `default` agent, which is exactly the state
 * under test and one nothing in the product recreates. This file also runs as
 * one of many parallel processes under `test:runtime`, several of which write
 * the same SQLite file.
 *
 * The import below is what moves it, and it must stay FIRST: `data-dir.ts`
 * reads DATA_DIR once, at import time, and ES modules evaluate their
 * dependencies in import order.
 */
import { assertIsolatedDataDir } from '@/lib/server/test-support/isolated-data-dir'

import { getExtensionManager } from './extensions'
import {
  inspectExtensionLocalFolder,
  listExtensionLocalFolderEntries,
  listExtensionManagedResources,
  reconcileExtensionManagedResources,
  setExtensionLocalFolderConfig,
} from './extension-managed-resources'
import { DATA_DIR, WORKSPACE_DIR } from './data-dir'
import { buildRuntimeSkillPromptBlocks, resolveRuntimeSkills } from './skills/runtime-skill-resolver'
import { loadAgents, loadSchedules, loadSettings, saveAgents, saveSchedules, saveSettings } from './storage'
import { DEFAULT_AGENT_ROUTE } from '@/lib/setup-defaults'
import { AGENTS as AISIGNAL_AGENTS } from '../../../extensions/aisignal/src/agents.mjs'

// Outside any test() on purpose: a test that only detects the wrong directory
// runs after the tests before it have already written there. A throw here
// aborts the file before its first test.
assertIsolatedDataDir({ DATA_DIR, WORKSPACE_DIR })

const originalAgents = loadAgents()
const originalSchedules = loadSchedules()
const originalSettings = loadSettings()

let seq = 0

function extensionId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now()}_${seq}`
}

afterEach(() => {
  saveAgents(originalAgents)
  saveSchedules(originalSchedules)
  saveSettings(originalSettings)
})

test('this file writes to a throwaway data directory and never the instance own one', () => {
  // The regression this catches is the import at the top of the file going
  // away, or moving below one that reads DATA_DIR. Asserted on the resolved
  // constants rather than on the environment, because those are what storage
  // actually opened, and asserted first because every other test here writes.
  const temp = os.tmpdir()
  assert.ok(DATA_DIR.startsWith(temp), `DATA_DIR is the instance's own: ${DATA_DIR}`)
  assert.ok(WORKSPACE_DIR.startsWith(temp), `WORKSPACE_DIR is the instance's own: ${WORKSPACE_DIR}`)
})

test('managed resources summary and reconcile create extension-owned agents and schedules', () => {
  const id = extensionId('managed_resources')
  getExtensionManager().registerBuiltin(id, {
    name: 'Managed Resource Fixture',
    description: 'Declares resources for tests.',
    managedResources: {
      agents: [
        {
          agentKey: 'researcher',
          displayName: 'Managed Researcher',
          description: 'Research managed by an extension.',
          systemPrompt: 'Research carefully.',
          provider: 'openai',
          model: 'gpt-4o-mini',
          capabilities: ['research'],
          extensions: ['web'],
        },
      ],
      routines: [
        {
          routineKey: 'daily-digest',
          title: 'Daily Digest',
          assigneeRef: { resourceKind: 'agent', resourceKey: 'researcher' },
          taskPrompt: 'Prepare a digest.',
          triggers: [{ kind: 'schedule', cronExpression: '0 9 * * *', timezone: 'UTC' }],
        },
      ],
      gatewayPlatforms: [
        {
          platformKey: 'openai-api',
          displayName: 'OpenAI-compatible API',
          transport: 'http',
          endpoint: 'http://127.0.0.1:8642/v1',
        },
      ],
      setupChecks: [
        { checkKey: 'api-key', displayName: 'API key configured', kind: 'env', target: 'OPENAI_API_KEY' },
      ],
    },
  })

  const before = listExtensionManagedResources().extensions.find((entry) => entry.extensionId === id)
  assert.ok(before)
  assert.equal(before.agents[0].status, 'missing')
  assert.equal(before.schedules[0].status, 'missing_ref')

  const result = reconcileExtensionManagedResources(id)
  assert.equal(result.createdAgents.length, 1)
  assert.equal(result.createdSchedules.length, 1)
  assert.deepEqual(result.skipped, [])

  const agents = loadAgents()
  const agent = agents[result.createdAgents[0]]
  assert.equal(agent.name, 'Managed Researcher')
  assert.equal(agent.managedByExtension?.extensionId, id)
  assert.equal(agent.managedByExtension?.resourceKey, 'researcher')
  assert.ok(agent.extensions?.includes(id))
  assert.ok(agent.extensions?.includes('web'))

  const schedules = loadSchedules()
  const schedule = schedules[result.createdSchedules[0]]
  assert.equal(schedule.name, 'Daily Digest')
  assert.equal(schedule.agentId, agent.id)
  assert.equal(schedule.scheduleType, 'cron')
  assert.equal(schedule.cron, '0 9 * * *')
  assert.equal(schedule.status, 'paused')
  assert.equal(schedule.managedByExtension?.resourceKey, 'daily-digest')

  const after = listExtensionManagedResources().extensions.find((entry) => entry.extensionId === id)
  assert.equal(after?.agents[0].status, 'resolved')
  assert.equal(after?.schedules[0].status, 'resolved')
  assert.equal(after?.gatewayPlatforms.length, 1)
  assert.equal(after?.setupChecks.length, 1)
})

test('local folder inspection and listing stay inside configured roots', async () => {
  const id = extensionId('managed_folder')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-managed-folder-'))
  fs.mkdirSync(path.join(tempDir, 'inputs'))
  fs.mkdirSync(path.join(tempDir, 'outputs'))
  fs.writeFileSync(path.join(tempDir, 'inputs', 'brief.txt'), 'hello\n')

  getExtensionManager().registerBuiltin(id, {
    name: 'Managed Folder Fixture',
    managedResources: {
      localFolders: [
        {
          folderKey: 'workspace',
          displayName: 'Workspace Folder',
          access: 'readWrite',
          requiredDirectories: ['inputs', 'outputs'],
          requiredFiles: ['inputs/brief.txt'],
        },
      ],
    },
  })

  setExtensionLocalFolderConfig({
    extensionId: id,
    folderKey: 'workspace',
    path: tempDir,
  })

  const status = await inspectExtensionLocalFolder({ extensionId: id, folderKey: 'workspace' })
  assert.equal(status.healthy, true)
  assert.equal(status.readable, true)
  assert.equal(status.writable, true)

  const listing = await listExtensionLocalFolderEntries({
    extensionId: id,
    folderKey: 'workspace',
    recursive: true,
  })
  assert.ok(listing.entries.some((entry) => entry.path === 'inputs/brief.txt' && entry.kind === 'file'))

  await assert.rejects(
    () => listExtensionLocalFolderEntries({
      extensionId: id,
      folderKey: 'workspace',
      relativePath: '../outside',
    }),
    /inside the configured root|traversal/,
  )

  fs.rmSync(tempDir, { recursive: true, force: true })
})

/**
 * A managed agent declaration that names no route at all, which is what an
 * extension that must not pin a model looks like.
 */
function routelessAgentFixture(id: string): void {
  getExtensionManager().registerBuiltin(id, {
    name: 'Routeless Agent Fixture',
    description: 'Declares an agent with no provider or model.',
    managedResources: {
      agents: [
        {
          agentKey: 'scout',
          displayName: 'Managed Scout',
          systemPrompt: 'Sweep carefully.',
        },
      ],
    },
  })
}

test('an agent declaration with no route is created on the instance default agent route', () => {
  /*
   * `buildManagedAgent` used to fill an absent provider with the literal
   * 'openai' and an absent model with 'gpt-4o-mini'. An extension is right not
   * to declare either -- pinning a model pins it on installs where that
   * credential does not exist -- so every extension-managed agent was created
   * pointing at an OpenAI credential the install may never have had, and the
   * first scheduled run failed on a credential error or succeeded badly.
   */
  const agents = loadAgents()
  agents.default = { ...agents.default, id: 'default', provider: 'anthropic', model: 'claude-sonnet-4-6' } as typeof agents.default
  saveAgents(agents)
  saveSettings({ ...loadSettings(), defaultAgentId: null })

  const id = extensionId('managed_route_default')
  routelessAgentFixture(id)
  const result = reconcileExtensionManagedResources(id)
  const created = loadAgents()[result.createdAgents[0]]

  assert.equal(created.provider, 'anthropic')
  assert.equal(created.model, 'claude-sonnet-4-6')
})

test('settings.defaultAgentId wins over the seeded default agent as the route to copy', () => {
  const agents = loadAgents()
  agents.default = { ...agents.default, id: 'default', provider: 'anthropic', model: 'claude-sonnet-4-6' } as typeof agents.default
  agents.picked = { ...agents.default, id: 'picked', name: 'Picked', provider: 'claude-cli', model: '' } as typeof agents.default
  saveAgents(agents)
  saveSettings({ ...loadSettings(), defaultAgentId: 'picked' })

  const id = extensionId('managed_route_setting')
  routelessAgentFixture(id)
  const result = reconcileExtensionManagedResources(id)
  const created = loadAgents()[result.createdAgents[0]]

  assert.equal(created.provider, 'claude-cli')
  // An empty model is what a CLI provider legitimately carries, and it survives
  // as an empty model rather than being read as "unset" and replaced.
  assert.equal(created.model, '')
})

test('with no default agent to copy, the route falls back to the one the seed itself uses', () => {
  // The only way to reach this: an operator who deleted their own default agent,
  // since the seed creates one whenever the agents table is empty. The answer is
  // DEFAULT_AGENT_ROUTE, the same route the seed would have written, and it is a
  // route that needs no API credential.
  const agents = loadAgents()
  delete agents.default
  saveAgents(agents)
  saveSettings({ ...loadSettings(), defaultAgentId: null })

  const id = extensionId('managed_route_none')
  routelessAgentFixture(id)
  const result = reconcileExtensionManagedResources(id)
  const created = loadAgents()[result.createdAgents[0]]

  assert.equal(created.provider, DEFAULT_AGENT_ROUTE.provider)
  assert.equal(created.model, DEFAULT_AGENT_ROUTE.model)
  assert.notEqual(created.provider, 'openai')
})

test('a reconcile does not move an agent the operator has since re-routed', () => {
  // The route is a default for a CREATE, not an assertion on every reconcile:
  // the declaration stays silent, so the operator owns the choice once it exists.
  const agents = loadAgents()
  agents.default = { ...agents.default, id: 'default', provider: 'anthropic', model: 'claude-sonnet-4-6' } as typeof agents.default
  saveAgents(agents)
  saveSettings({ ...loadSettings(), defaultAgentId: null })

  const id = extensionId('managed_route_keep')
  routelessAgentFixture(id)
  const agentId = reconcileExtensionManagedResources(id).createdAgents[0]

  const rerouted = loadAgents()
  rerouted[agentId] = { ...rerouted[agentId], provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }
  saveAgents(rerouted)

  reconcileExtensionManagedResources(id)
  const after = loadAgents()[agentId]
  assert.equal(after.provider, 'openrouter')
  assert.equal(after.model, 'anthropic/claude-sonnet-4.6')
})

test('a reconcile keeps the empty model an operator paired with a CLI provider', () => {
  /*
   * The falsy-empty hole in the same resolution. `''` is what a CLI provider
   * legitimately carries -- it is DEFAULT_AGENT_ROUTE's own model, and the
   * reason the instance-default lookup keeps an empty model as an empty model
   * -- so `existing?.model || fallbackRoute.model` read the operator's
   * deliberate empty as "unset" and filled it from a route they never chose.
   * Driven: created on anthropic/claude-sonnet-4-6, re-routed by the operator
   * to claude-cli with no model, and the next reconcile handed back claude-cli
   * paired with claude-sonnet-4-6 -- a provider from one place and a model from
   * another, which is the pairing this resolution exists to prevent.
   */
  const agents = loadAgents()
  agents.default = { ...agents.default, id: 'default', provider: 'anthropic', model: 'claude-sonnet-4-6' } as typeof agents.default
  saveAgents(agents)
  saveSettings({ ...loadSettings(), defaultAgentId: null })

  const id = extensionId('managed_route_cli')
  routelessAgentFixture(id)
  const agentId = reconcileExtensionManagedResources(id).createdAgents[0]
  assert.equal(loadAgents()[agentId].model, 'claude-sonnet-4-6')

  const rerouted = loadAgents()
  rerouted[agentId] = { ...rerouted[agentId], provider: 'claude-cli', model: '' }
  saveAgents(rerouted)

  reconcileExtensionManagedResources(id)
  const after = loadAgents()[agentId]
  assert.equal(after.provider, 'claude-cli')
  assert.equal(after.model, '', 'the operator chose a route, not just a provider')
})

test('a declared skill name is pinned to the agent that declares it', () => {
  /*
   * `skills: [...]` used to be a label on the agent card and nothing more: the
   * turn hands `agent.skillIds` to resolveRuntimeSkills, so a declaration that
   * named only `skills` attached nothing, and the skill an extension shipped
   * for one agent reached no agent at all. The instrument reached for instead
   * was `always: true` in the SKILL.md, which has no agent scoping and put the
   * file into every agent's prompt on the instance.
   *
   * A skill an extension ships is discovered off disk and has no storage id, so
   * its name is the only handle a declaration has. The name therefore lands in
   * `skillIds` as well, and the resolver matches a pin on a name as well as on
   * a storage id -- see runtime-skill-resolver.test.ts for the other half.
   */
  const id = extensionId('managed_skills')
  getExtensionManager().registerBuiltin(id, {
    name: 'Skill Declaring Fixture',
    managedResources: {
      agents: [
        {
          agentKey: 'scout',
          displayName: 'Managed Scout',
          systemPrompt: 'Sweep carefully.',
          skills: ['ai-hirlevel-kinyeres'],
        },
      ],
    },
  })

  // Two statements, not one: `loadAgents()[reconcile(...)...]` evaluates the
  // object before the property, so the read would happen before the write.
  const result = reconcileExtensionManagedResources(id)
  const created = loadAgents()[result.createdAgents[0]]
  assert.deepEqual(created.skills, ['ai-hirlevel-kinyeres'], 'the card still reads the name')
  assert.deepEqual(created.skillIds, ['ai-hirlevel-kinyeres'], 'and the turn is handed it too')
})

test('declared skill ids and declared skill names are pinned together, without duplicates', () => {
  // A declaration may reasonably name a stored skill by id and a file it ships
  // by name in one breath, so the pin list is their union rather than one or
  // the other.
  const id = extensionId('managed_skills_union')
  getExtensionManager().registerBuiltin(id, {
    name: 'Skill Union Fixture',
    managedResources: {
      agents: [
        {
          agentKey: 'scout',
          displayName: 'Managed Scout',
          systemPrompt: 'Sweep carefully.',
          skills: ['shipped-skill', 'stored_skill_id'],
          skillIds: ['stored_skill_id'],
        },
      ],
    },
  })

  const result = reconcileExtensionManagedResources(id)
  const created = loadAgents()[result.createdAgents[0]]
  assert.deepEqual(created.skillIds, ['stored_skill_id', 'shipped-skill'])
})

test('a reconcile keeps the skill an operator pinned by hand beside the declared one', () => {
  /*
   * The pin list on an agent is shared: the agent sheet, `manage_skills`
   * attach, the agents API and a reconcile from Extensions > Managed Resources
   * all write `skillIds`. Before this, a declaration with `skills` filled the
   * list and won every time, so reconcile #1 gave the declared pin, the
   * operator added one by hand, and reconcile #2 -- which runs on install,
   * enable and upgrade -- gave the declared pin alone again. The declaration
   * has to reach its agent without deleting what the operator added, so the
   * list is the union.
   */
  const id = extensionId('managed_skills_operator_pin')
  getExtensionManager().registerBuiltin(id, {
    name: 'Skill Pin Survival Fixture',
    managedResources: {
      agents: [
        {
          agentKey: 'scout',
          displayName: 'Managed Scout',
          systemPrompt: 'Sweep carefully.',
          skills: ['ai-hirlevel-kinyeres'],
        },
      ],
    },
  })

  const first = reconcileExtensionManagedResources(id)
  const agentId = first.createdAgents[0]
  assert.deepEqual(loadAgents()[agentId].skillIds, ['ai-hirlevel-kinyeres'])

  const agents = loadAgents()
  agents[agentId] = { ...agents[agentId], skillIds: [...(agents[agentId].skillIds || []), 'skill_operator_pinned_by_hand'] }
  saveAgents(agents)

  reconcileExtensionManagedResources(id)
  assert.deepEqual(
    loadAgents()[agentId].skillIds,
    ['ai-hirlevel-kinyeres', 'skill_operator_pinned_by_hand'],
    'the second reconcile dropped the pin the operator added',
  )
})

test('a reconcile puts a declared pin back that the operator removed, and adds nothing twice', () => {
  // The other edge of the union: the declaration has to reach its agent, so
  // removing the declared pin by hand is undone by the next reconcile, and a
  // pin that is already there is not duplicated.
  const id = extensionId('managed_skills_redeclare')
  getExtensionManager().registerBuiltin(id, {
    name: 'Skill Redeclare Fixture',
    managedResources: {
      agents: [
        {
          agentKey: 'scout',
          displayName: 'Managed Scout',
          systemPrompt: 'Sweep carefully.',
          skills: ['ai-hirlevel-kinyeres'],
        },
      ],
    },
  })

  const agentId = reconcileExtensionManagedResources(id).createdAgents[0]
  const agents = loadAgents()
  agents[agentId] = { ...agents[agentId], skillIds: ['skill_operator_pinned_by_hand'] }
  saveAgents(agents)

  reconcileExtensionManagedResources(id)
  assert.deepEqual(loadAgents()[agentId].skillIds, ['skill_operator_pinned_by_hand', 'ai-hirlevel-kinyeres'])
  reconcileExtensionManagedResources(id)
  assert.deepEqual(loadAgents()[agentId].skillIds, ['skill_operator_pinned_by_hand', 'ai-hirlevel-kinyeres'])
})

/** A SKILL.md under `<cwd>/skills/<dir>`, which is the project layer discoverSkills scans. */
function stageSkill(cwd: string, dir: string, content: string): void {
  const skillDir = path.join(cwd, 'skills', dir)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content)
}

const OLD_SKILL_PROSE = 'A RÉGI SZABÁLY, AMIT AZ ÚJ FÁJL MÁR NEM MOND'

const pinnedKutatas = (names: string[]): string[] => names.filter((name) => name.startsWith('kkv-kutatas')).sort()

/** What an upgrade leaves on disk: the renamed skill's old file, and the new one beside it. */
function stageRenamedSkillPair(cwd: string): void {
  stageSkill(cwd, 'kkv-kutatas-old', `---\nname: kkv-kutatas-old\ndescription: The superseded file.\n---\n# Régi\n\n${'Egy régi sor szabály.\n'.repeat(160)}\n${OLD_SKILL_PROSE}\n`)
  stageSkill(cwd, 'kkv-kutatas-v2', '---\nname: kkv-kutatas-v2\ndescription: The replacement.\n---\n# Új\n\nAz új szabály, röviden.\n')
}

function registerSkillRenameFixture(id: string, skill: string): void {
  getExtensionManager().registerBuiltin(id, {
    name: 'Skill Rename Fixture',
    managedResources: {
      agents: [
        {
          agentKey: 'kutato',
          displayName: 'Managed Kutato',
          systemPrompt: 'Research carefully.',
          skills: [skill],
        },
      ],
    },
  })
}

test('the resolver attaches a stale pin that still matches a file, which is why a reconcile has to drop it', () => {
  /*
   * The premise of the two tests below, shown rather than assumed. The round 3
   * comment said a pin an older declaration named "is inert in the resolver".
   * It is inert only when it matches nothing: the installer copies an
   * extension's skill files into the workspace layer and never removes one, so
   * after a rename the old pin matches the old file, and both attach.
   */
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-stale-pin-'))
  try {
    stageRenamedSkillPair(cwd)
    const snapshot = resolveRuntimeSkills({
      cwd,
      enabledExtensions: [],
      storedSkills: {},
      learnedSkills: {},
      agentSkillIds: ['kkv-kutatas-old', 'kkv-kutatas-v2'],
    })
    // Filtered to the pair under test: the bundled always-on skill is in every prompt on every instance.
    assert.deepEqual(pinnedKutatas(snapshot.promptSkills.map((entry) => entry.name)), ['kkv-kutatas-old', 'kkv-kutatas-v2'])
    const block = buildRuntimeSkillPromptBlocks(snapshot).join('\n')
    assert.match(block, /\[Skill content truncated/, 'the superseded file is long enough to be cut, and it is in the prompt')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('a reconcile after a rename drops the old declared pin, so one skill is in the prompt once', () => {
  /*
   * Reconcile #1 declares `kkv-kutatas-old`; the operator pins a skill of
   * their own by hand; the upgrade re-declares `kkv-kutatas-v2`. Before this
   * the union kept the old pin -- nothing told a stale declared pin from an
   * operator's -- and with the old file still on disk the agent's prompt
   * carried both copies. The marker now records what each reconcile declared,
   * and the next one subtracts what the previous declared and this one does
   * not. The operator's own pin on another name is untouched.
   *
   * The second half drives the stored pin list through the real resolver and
   * the real prompt builder, with both files staged the way the installer
   * leaves them, and looks at the rendered block: one skill, no marker, none
   * of the superseded prose.
   */
  const id = extensionId('managed_skills_rename')
  registerSkillRenameFixture(id, 'kkv-kutatas-old')
  const agentId = reconcileExtensionManagedResources(id).createdAgents[0]
  assert.deepEqual(loadAgents()[agentId].skillIds, ['kkv-kutatas-old'])
  assert.deepEqual(loadAgents()[agentId].managedByExtension?.declaredSkillIds, ['kkv-kutatas-old'])

  const agents = loadAgents()
  agents[agentId] = { ...agents[agentId], skillIds: [...(agents[agentId].skillIds || []), 'skill_operator_pinned_by_hand'] }
  saveAgents(agents)

  registerSkillRenameFixture(id, 'kkv-kutatas-v2')
  reconcileExtensionManagedResources(id)
  const stored = loadAgents()[agentId]
  assert.deepEqual(stored.skillIds, ['skill_operator_pinned_by_hand', 'kkv-kutatas-v2'], 'the old declared pin stayed, or the operator pin went')
  assert.deepEqual(stored.managedByExtension?.declaredSkillIds, ['kkv-kutatas-v2'])

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-renamed-pin-'))
  try {
    stageRenamedSkillPair(cwd)
    const snapshot = resolveRuntimeSkills({
      cwd,
      enabledExtensions: [],
      storedSkills: {},
      learnedSkills: {},
      agentSkillIds: stored.skillIds || [],
    })
    assert.deepEqual(pinnedKutatas(snapshot.promptSkills.map((entry) => entry.name)), ['kkv-kutatas-v2'])
    const block = buildRuntimeSkillPromptBlocks(snapshot).join('\n')
    assert.doesNotMatch(block, /\[Skill content truncated/)
    assert.ok(!block.includes(OLD_SKILL_PROSE), 'the superseded skill is in the prompt beside its replacement')
    assert.ok(block.includes('Az új szabály, röviden.'), 'the replacement is not in the prompt')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('an agent reconciled before the marker recorded its pins keeps an old pin, as the comment says', () => {
  // The documented limit of the subtraction: with no recorded set there is
  // nothing to subtract from. The first reconcile after records the set, so
  // the rename after THAT is cleaned. Pinned so the comment cannot drift
  // from what happens.
  const id = extensionId('managed_skills_rename_legacy')
  registerSkillRenameFixture(id, 'kkv-kutatas-old')
  const agentId = reconcileExtensionManagedResources(id).createdAgents[0]
  const agents = loadAgents()
  const marker = agents[agentId].managedByExtension
  assert.ok(marker)
  const legacyMarker = { ...marker }
  delete legacyMarker.declaredSkillIds
  agents[agentId] = { ...agents[agentId], managedByExtension: legacyMarker }
  saveAgents(agents)

  registerSkillRenameFixture(id, 'kkv-kutatas-v2')
  reconcileExtensionManagedResources(id)
  assert.deepEqual(loadAgents()[agentId].skillIds, ['kkv-kutatas-old', 'kkv-kutatas-v2'])

  registerSkillRenameFixture(id, 'kkv-kutatas-v3')
  reconcileExtensionManagedResources(id)
  assert.deepEqual(loadAgents()[agentId].skillIds, ['kkv-kutatas-old', 'kkv-kutatas-v3'], 'v2 was recorded, so it goes; the pre-record pin stays')
})

test('the rule that a stranger claim is not a fact reaches both aisignal agents in the field the turn reads whole', () => {
  /*
   * The old kkv-kutatas skill file carried the only rule about writing the
   * `summary` truthfully -- a quote is marked as a quote with its source, and
   * a Reddit comment with 19 upvotes is an opinion, not a fact -- at offset
   * 4179, past the 3 000-character inline cut, so it reached no turn. The
   * skill rewrite dropped it. It is now in both souls, and this test asserts
   * on where a turn reads it from, not on the file: the extension's real
   * declarations go through the real reconcile, and the assertion is on the
   * stored agent's `systemPrompt`, the field `buildAgentSystemPrompt` in
   * chat-turn-preparation.ts pushes into the turn without a cap. That builder
   * is not exported, so this stops one hop short of it.
   */
  const id = extensionId('aisignal_declared_agents')
  getExtensionManager().registerBuiltin(id, {
    name: 'AI Signal',
    managedResources: { agents: [...AISIGNAL_AGENTS] },
  })
  const result = reconcileExtensionManagedResources(id)
  assert.equal(result.createdAgents.length, 2)
  const agents = loadAgents()
  for (const agentId of result.createdAgents) {
    const agent = agents[agentId]
    const prompt = String(agent.systemPrompt || '').replace(/\s+/g, ' ')
    assert.match(prompt, /Ha idézek, jelölöm, hogy idézet, és megmondom, honnan/, `${agent.name}: a quote is not marked as a quote in the prompt`)
    assert.match(prompt, /nem tény/, `${agent.name}: the prompt does not say a stranger's claim is not a fact`)
  }
})
