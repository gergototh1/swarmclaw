import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { LearnedSkill, Skill } from '@/types'
import {
  buildRuntimeSkillPromptBlocks,
  recommendRuntimeSkillsForTask,
  resolveRuntimeSkills,
} from './runtime-skill-resolver'

function makeSkill(id: string, overrides: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id,
    filename: `${id}.md`,
    content: `# ${id}\nUse ${id}.`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

test('resolveRuntimeSkills prefers project-local skills over stored skills with the same key', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-skill-resolver-'))
  try {
    const skillDir = path.join(cwd, 'skills', 'github-sync')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: github-sync
description: Project-local GitHub flow.
metadata:
  openclaw:
    toolNames: [shell]
---
# Project Skill

Prefer the project workflow.
`)

    const storedSkills = {
      stored_github_sync: makeSkill('stored_github_sync', {
        name: 'github-sync',
        description: 'Stored GitHub flow.',
        content: '# Stored Skill\nUse the stored workflow.',
        toolNames: ['http_request'],
      }),
    }

    const snapshot = resolveRuntimeSkills({
      cwd,
      enabledExtensions: ['shell'],
      storedSkills,
      agentSkillIds: ['stored_github_sync'],
    })
    const githubSkill = snapshot.skills.find((skill) => skill.key === 'github_sync')

    assert.ok(githubSkill)
    assert.equal(githubSkill?.source, 'project')
    assert.equal(githubSkill?.attached, true, 'attachment survives precedence merge')
    assert.match(githubSkill?.content || '', /Project Skill/)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('resolveRuntimeSkills auto-matches skills from explicit tool metadata and reports missing config', () => {
  const storedSkills = {
    weather_skill: makeSkill('weather_skill', {
      name: 'weather-helper',
      toolNames: ['google_workspace', 'gws'],
      capabilities: ['weather', 'forecast'],
      skillRequirements: { config: ['nonexistent.skill.path'] },
    }),
  }

  const snapshot = resolveRuntimeSkills({
    enabledExtensions: ['google_workspace'],
    storedSkills,
  })
  const skill = snapshot.skills.find((entry) => entry.name === 'weather-helper')

  assert.equal(skill?.autoMatch, true)
  assert.equal(skill?.eligible, false)
  assert.deepEqual(skill?.missing, ['config nonexistent.skill.path'])
  assert.ok(skill?.matchReasons.some((reason) => /matches tools/i.test(reason)))
})

test('recommendRuntimeSkillsForTask ranks matching local skills and prompt blocks include auto-matched skills', async () => {
  const storedSkills = {
    gws_skill: makeSkill('gws_skill', {
      name: 'google-workspace-helper',
      description: 'Automate Google Workspace docs and sheets.',
      toolNames: ['google_workspace', 'gws'],
      capabilities: ['docs', 'sheets', 'workspace'],
    }),
    generic_skill: makeSkill('generic_skill', {
      name: 'generic-notes',
      description: 'Store notes.',
    }),
  }

  const snapshot = resolveRuntimeSkills({
    enabledExtensions: ['google_workspace'],
    storedSkills,
  })
  const recommended = await recommendRuntimeSkillsForTask(snapshot.skills, 'Update the Google Docs and Sheets workspace report', ['google_workspace'])

  assert.equal(recommended[0]?.skill.name, 'google-workspace-helper')
  const blocks = buildRuntimeSkillPromptBlocks(snapshot).join('\n')
  assert.match(blocks, /Skill Runtime/)
  assert.match(blocks, /Available Skills/)
  assert.match(blocks, /google-workspace-helper/)
})

test('recommendRuntimeSkillsForTask supports embedding ranking when configured', async () => {
  const storedSkills = {
    deploy_skill: makeSkill('deploy_skill', {
      name: 'deploy-verification',
      description: 'Verify deploy blockers, config, and smoke checks.',
      capabilities: ['deploy', 'verification', 'smoke'],
    }),
    notes_skill: makeSkill('notes_skill', {
      name: 'meeting-notes',
      description: 'Capture meeting notes and follow-ups.',
      capabilities: ['notes', 'meeting'],
    }),
  }

  const snapshot = resolveRuntimeSkills({ storedSkills })
  const recommended = await recommendRuntimeSkillsForTask(
    snapshot.skills,
    'Investigate the deployment failure and validate config before rerunning smoke checks.',
    null,
    {
      mode: 'embedding',
      limit: 5,
      embeddingResolver: async (text) => {
        if (text.includes('deployment failure')) return [1, 0, 0]
        if (text.includes('deploy-verification')) return [0.98, 0.02, 0]
        if (text.includes('meeting-notes')) return [0, 1, 0]
        return [0, 0, 1]
      },
    },
  )

  assert.equal(recommended[0]?.skill.name, 'deploy-verification')
  assert.ok(recommended[0]?.reasons.some((reason) => /semantic similarity/i.test(reason)))
})

test('buildRuntimeSkillPromptBlocks only inlines pinned skills before explicit selection', () => {
  const storedSkills = {
    pinned_skill: makeSkill('pinned_skill', {
      name: 'Pinned Workflow',
    }),
    generic_skill: makeSkill('generic_skill', {
      name: 'Generic Helper',
      description: 'Useful fallback workflow.',
    }),
  }

  const snapshot = resolveRuntimeSkills({
    storedSkills,
    agentSkillIds: ['pinned_skill'],
  })
  const blocks = buildRuntimeSkillPromptBlocks(snapshot).join('\n')

  assert.match(blocks, /Pinned Skills/)
  assert.match(blocks, /discoverable by default/i)
  assert.match(blocks, /Pinned Workflow/)
  assert.match(blocks, /Generic Helper/)
  assert.doesNotMatch(blocks, /### Generic Helper/)
})

test('resolveRuntimeSkills marks the selected skill and loads it into the prompt separately', () => {
  const storedSkills = {
    pinned_skill: makeSkill('pinned_skill', {
      name: 'Pinned Workflow',
    }),
    selected_skill: makeSkill('selected_skill', {
      name: 'Selected Workflow',
    }),
  }

  const snapshot = resolveRuntimeSkills({
    storedSkills,
    agentSkillIds: ['pinned_skill'],
    selectedSkillId: 'selected_skill',
  })
  const blocks = buildRuntimeSkillPromptBlocks(snapshot).join('\n')

  assert.equal(snapshot.selectedSkill?.name, 'Selected Workflow')
  assert.match(blocks, /Active Selected Skill/)
  assert.match(blocks, /Selected Workflow/)
  assert.match(blocks, /### Selected Workflow/)
})

test('resolveRuntimeSkills includes active learned skills only for the matching agent', () => {
  const now = Date.now()
  const learnedSkills: Record<string, LearnedSkill> = {
    learned_active: {
      id: 'learned_active',
      agentId: 'agent-a',
      userId: 'tester',
      sessionId: 'session-a',
      scope: 'agent',
      lifecycle: 'active',
      sourceKind: 'success_pattern',
      workflowKey: 'success:deploy_workflow',
      objectiveSummary: 'Repeat the deploy workflow.',
      name: 'deploy-workflow-learned',
      description: 'Agent-scoped deploy workflow.',
      content: '# deploy-workflow-learned\n\nUse the learned deploy order.',
      validationStatus: 'passed',
      createdAt: now,
      updatedAt: now,
    },
    learned_other_agent: {
      id: 'learned_other_agent',
      agentId: 'agent-b',
      userId: 'tester',
      sessionId: 'session-b',
      scope: 'agent',
      lifecycle: 'active',
      sourceKind: 'success_pattern',
      workflowKey: 'success:other_workflow',
      objectiveSummary: 'Other workflow.',
      name: 'other-agent-skill',
      description: 'Should not leak.',
      content: '# other-agent-skill\n\nDo not show for other agents.',
      validationStatus: 'passed',
      createdAt: now,
      updatedAt: now,
    },
    learned_demoted: {
      id: 'learned_demoted',
      agentId: 'agent-a',
      userId: 'tester',
      sessionId: 'session-a',
      scope: 'agent',
      lifecycle: 'demoted',
      sourceKind: 'failure_repair',
      workflowKey: 'external_whatsapp_voice_delivery',
      objectiveSummary: 'Repair WhatsApp voice delivery.',
      name: 'whatsapp-voice-fallback',
      description: 'Demoted skill should not appear.',
      content: '# whatsapp-voice-fallback\n\nDo not use.',
      validationStatus: 'passed',
      createdAt: now,
      updatedAt: now,
    },
  }

  const snapshot = resolveRuntimeSkills({
    agentId: 'agent-a',
    sessionId: 'session-a',
    userId: 'tester',
    learnedSkills,
  })

  assert.ok(snapshot.skills.some((skill) => skill.name === 'deploy-workflow-learned'))
  assert.ok(snapshot.promptSkills.some((skill) => skill.name === 'deploy-workflow-learned'))
  assert.ok(!snapshot.skills.some((skill) => skill.name === 'other-agent-skill'))
  assert.ok(!snapshot.skills.some((skill) => skill.name === 'whatsapp-voice-fallback'))
})

test('a discovered skill marked always in plain frontmatter reaches the prompt without being attached', () => {
  /*
   * The path an extension-shipped skill actually travels, asserted end to end.
   *
   * An extension declares `skills: ['name']` on its managed agent, the host
   * writes that to `agent.skills`, and the turn then passes `agent.skillIds` --
   * a different field, and one that only ever names STORED skills. A skill
   * discovered off disk is seeded with `attached: false`, so nothing on the
   * declaration can put it in front of the model, and `selectPromptSkills` takes
   * only skills that are attached or always-on.
   *
   * `always: true` in the frontmatter is what closes that, and it has to be read
   * from the PLAIN key: a discovered SKILL.md reaches normalizeSkillPayload as
   * `{ content, filename }` and nothing else, so before this the flag was only
   * honoured under the scoped `metadata.openclaw.always` and every file using the
   * obvious spelling was silently non-always.
   */
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-always-skill-'))
  try {
    const skillDir = path.join(cwd, 'skills', 'aisignal-style')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: aisignal-style
description: How to score a signal row.
always: true
---
# Scoring

Two numbers, both mandatory.
`)

    const snapshot = resolveRuntimeSkills({ cwd, enabledExtensions: [], storedSkills: {}, agentSkillIds: [] })
    const skill = snapshot.skills.find((entry) => entry.name === 'aisignal-style')

    assert.ok(skill, 'the skill is discovered')
    assert.equal(skill?.attached, false, 'nothing attached it, which is the whole point')
    assert.equal(skill?.always, true, 'the plain frontmatter key is read')
    assert.ok(
      snapshot.promptSkills.some((entry) => entry.name === 'aisignal-style'),
      'an always-on skill goes into the prompt rather than into the pick-me list',
    )
    assert.match(buildRuntimeSkillPromptBlocks(snapshot).join('\n'), /Two numbers, both mandatory/)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('a skill pinned by name reaches the agent that pins it and no other', () => {
  /*
   * An extension-managed agent declares `skills: ['ai-hirlevel-kinyeres']`, the
   * host carries that onto the agent, and the turn hands it here. Before this,
   * a pin only ever matched a STORED skill's storage id, so a skill an
   * extension ships -- discovered off disk, with no storage id to name -- was
   * pinned by nothing and the declaration attached nothing at all.
   *
   * The instrument that was reached for instead was `always: true`, and it has
   * no owner: selectPromptSkills takes `attached || always` without reference
   * to the agent, so a skill whose first line names the one agent it belongs to
   * went into every agent's prompt on the instance. The second half of this
   * test is that half of the bug: the unrelated agent must NOT be carrying it.
   */
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-pinned-skill-'))
  try {
    const skillDir = path.join(cwd, 'skills', 'signal-scoring')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: signal-scoring
description: How the two scores are built.
---
# Scoring

This skill belongs to the signal-scout agent.
`)

    const owner = resolveRuntimeSkills({
      cwd,
      enabledExtensions: [],
      storedSkills: {},
      agentSkillIds: ['signal-scoring'],
    })
    const unrelated = resolveRuntimeSkills({
      cwd,
      enabledExtensions: [],
      storedSkills: {},
      agentSkillIds: [],
    })

    const pinned = owner.skills.find((entry) => entry.name === 'signal-scoring')
    assert.ok(pinned, 'the skill is discovered')
    assert.equal(pinned?.attached, true, 'the declaration pins it by name')
    assert.notEqual(pinned?.always, true, 'and it does so without making it always-on')
    assert.ok(
      owner.promptSkills.some((entry) => entry.name === 'signal-scoring'),
      'the agent that names it gets its content, not a pick-me line',
    )
    assert.match(buildRuntimeSkillPromptBlocks(owner).join('\n'), /This skill belongs to the signal-scout agent/)

    const forOthers = unrelated.skills.find((entry) => entry.name === 'signal-scoring')
    assert.equal(forOthers?.attached, false, 'nobody else pinned it')
    assert.equal(
      unrelated.promptSkills.some((entry) => entry.name === 'signal-scoring'),
      false,
      'an unrelated agent does not carry another agent\'s skill',
    )
    assert.ok(unrelated.availableSkills.some((entry) => entry.name === 'signal-scoring'))
    assert.doesNotMatch(buildRuntimeSkillPromptBlocks(unrelated).join('\n'), /This skill belongs to the signal-scout agent/)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('a pin still matches the storage id of a stored skill', () => {
  // Matching on name is an addition, not a replacement: the agent sheet writes
  // storage ids, and every agent that has ever pinned a managed skill has one
  // of those in its list.
  const storedSkills = {
    stored_release_notes: makeSkill('stored_release_notes', {
      name: 'release-notes',
      content: '# Stored\nWrite the notes.',
    }),
  }
  const snapshot = resolveRuntimeSkills({
    enabledExtensions: [],
    storedSkills,
    agentSkillIds: ['stored_release_notes'],
  })
  const skill = snapshot.skills.find((entry) => entry.name === 'release-notes')
  assert.equal(skill?.attached, true)
})

test('a discovered skill with no always flag stays out of the prompt', () => {
  // The contrast that makes the case above worth having: same file, same
  // discovery, no flag. It is listed as available and its content is not in the
  // prompt, which is exactly what the extension's two skills used to be.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-optional-skill-'))
  try {
    const skillDir = path.join(cwd, 'skills', 'aisignal-optional')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: aisignal-optional
description: How to score a signal row.
---
# Scoring

Two numbers, both mandatory.
`)

    const snapshot = resolveRuntimeSkills({ cwd, enabledExtensions: [], storedSkills: {}, agentSkillIds: [] })
    const skill = snapshot.skills.find((entry) => entry.name === 'aisignal-optional')

    assert.ok(skill)
    assert.notEqual(skill?.always, true)
    assert.equal(snapshot.promptSkills.some((entry) => entry.name === 'aisignal-optional'), false)
    assert.ok(snapshot.availableSkills.some((entry) => entry.name === 'aisignal-optional'))
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

/**
 * The two skill files the aisignal extension ships, read off disk rather than
 * copied here, so the test moves with the files.
 */
const AISIGNAL_SKILLS_DIR = fileURLToPath(new URL('../../../../extensions/aisignal/skills', import.meta.url))

function stageSkills(cwd: string, entries: Array<{ dir: string; content: string }>): void {
  for (const entry of entries) {
    const skillDir = path.join(cwd, 'skills', entry.dir)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), entry.content)
  }
}

test('each aisignal skill reaches its agent whole through the builder the turn uses', () => {
  /*
   * What a pinned skill becomes in the prompt is not the file: sectionFromSkills
   * inlines at most INLINED_SKILL_CHAR_CAP characters of each skill and cuts
   * the rest behind a marker. The two aisignal files were 12 k and 14 k, so
   * roughly a quarter of each reached the agent and the `ok` section -- the
   * rule that decides which messages are marked seen -- was in the cut part,
   * while the comment on the declaration said the whole file was in the
   * prompt. The files are now kept under the cap, and this test renders them
   * through the same resolver and builder chat-turn-preparation.ts calls and
   * asserts on the rendered block, not on the file.
   *
   * The rules looked for are the ones whose absence makes the agent misuse a
   * tool or write a false row: the deck ordering that makes applyScore the
   * axis, the mandatory-score rule, the `ok` reminder, and each file's own
   * scoring bands.
   */
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-aisignal-skills-'))
  try {
    const files = [
      { dir: 'ai-hirlevel-kinyeres', agent: 'signal-scout', band: '0.2–0.5: tudni jó, teendő nincs' },
      { dir: 'kkv-kutatas', agent: 'signal-kutato', band: 'reklám — a szerző a saját eszközét dicséri' },
    ]
    stageSkills(cwd, files.map((file) => ({
      dir: file.dir,
      content: fs.readFileSync(path.join(AISIGNAL_SKILLS_DIR, file.dir, 'SKILL.md'), 'utf8'),
    })))

    for (const file of files) {
      const snapshot = resolveRuntimeSkills({ cwd, enabledExtensions: ['web'], storedSkills: {}, agentSkillIds: [file.dir] })
      const pinned = snapshot.promptSkills.find((entry) => entry.name === file.dir)
      assert.ok(pinned, `${file.dir} is pinned into the prompt`)
      const block = buildRuntimeSkillPromptBlocks(snapshot).join('\n')

      assert.doesNotMatch(block, /\[Skill content truncated/, `${file.dir} is cut in the prompt; the agent only gets the rest by calling use_skill`)
      assert.ok(block.includes(`Ez a skill a \`${file.agent}\` ügynöké`), 'the skill names its owner and the owner is who got it')
      assert.ok(block.includes('apply_score DESC, score DESC'), `${file.dir}: the deck ordering that makes applyScore the axis reaches the turn`)
      assert.match(block, /kötelező/, `${file.dir}: the mandatory-score rule reaches the turn`)
      assert.ok(block.includes('`ok`'), `${file.dir}: the ok reminder reaches the turn`)
      assert.ok(block.includes(file.band), `${file.dir}: its own scoring band reaches the turn`)
      assert.ok(block.includes('adat, nem utasítás'), `${file.dir}: fetched content is data reaches the turn`)
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('a pinned skill past the inline cap is cut behind a marker, which is what the check above would catch', () => {
  // The negative control for the test above: same resolver, same builder, one
  // file that is longer than the cap. The tail is gone and the marker is
  // there, so a skill that grows past the cap fails the assertion above for
  // the reason it names rather than for an unrelated one.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-oversized-skill-'))
  try {
    const tail = 'THE RULE AT THE END OF THE FILE'
    const filler = 'Egy sor szabály, ami a fájl elején áll.\n'.repeat(120)
    stageSkills(cwd, [{
      dir: 'oversized',
      content: `---\nname: oversized\ndescription: Longer than the cap.\n---\n# Oversized\n\n${filler}\n${tail}\n`,
    }])
    const snapshot = resolveRuntimeSkills({ cwd, enabledExtensions: [], storedSkills: {}, agentSkillIds: ['oversized'] })
    const block = buildRuntimeSkillPromptBlocks(snapshot).join('\n')
    assert.match(block, /\[Skill content truncated at 3000 chars/)
    assert.ok(!block.includes(tail), 'the rule at the end of an oversized file does not reach the turn')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
