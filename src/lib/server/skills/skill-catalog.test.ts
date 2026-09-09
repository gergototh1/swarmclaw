import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Skill } from '@/types'
import { clearDiscoveredSkillsCache } from './skill-discovery'
import { loadSkillCatalog } from './skill-catalog'

function withWorkspaceSkill<T>(name: string, run: () => T): T {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-skill-catalog-'))
  const skillDir = path.join(tempHome, 'skills', name)
  const previousHome = process.env.SWARMCLAW_HOME
  try {
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: ${name}
description: A workspace skill that lives only on disk.
---

# ${name}
`, 'utf8')
    process.env.SWARMCLAW_HOME = tempHome
    clearDiscoveredSkillsCache()
    return run()
  } finally {
    clearDiscoveredSkillsCache()
    if (previousHome === undefined) delete process.env.SWARMCLAW_HOME
    else process.env.SWARMCLAW_HOME = previousHome
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
}

test('loadSkillCatalog lists a workspace skill that has no stored record', () => {
  withWorkspaceSkill('katalogus-teszt', () => {
    const catalog = loadSkillCatalog({ storedSkills: {} })
    const entry = catalog['katalogus-teszt']

    assert.ok(entry, 'a workspace skill on disk must appear in the catalog')
    assert.equal(entry.source, 'workspace')
    assert.equal(entry.readOnly, true)
    assert.equal(entry.description, 'A workspace skill that lives only on disk.')
    assert.ok(entry.sourcePath?.endsWith(path.join('katalogus-teszt', 'SKILL.md')))
  })
})

test('loadSkillCatalog ids a discovered skill by the name a pin already uses', () => {
  withWorkspaceSkill('pin-nev-teszt', () => {
    const catalog = loadSkillCatalog({ storedSkills: {} })
    assert.equal(catalog['pin-nev-teszt']?.id, 'pin-nev-teszt')
  })
})

test('loadSkillCatalog includes bundled skills shipped with the app', () => {
  const catalog = loadSkillCatalog({ storedSkills: {} })
  const bundled = catalog['google-workspace']

  assert.ok(bundled, 'bundled skills must be listed too')
  assert.equal(bundled.source, 'bundled')
  assert.equal(bundled.readOnly, true)
})

test('loadSkillCatalog keeps the editable stored record when a name collides', () => {
  withWorkspaceSkill('utkozo-teszt', () => {
    const stored: Record<string, Skill> = {
      abc123: {
        id: 'abc123',
        name: 'utkozo-teszt',
        filename: 'utkozo-teszt.md',
        content: '# stored',
        description: 'The stored copy.',
        createdAt: 1,
        updatedAt: 2,
      },
    }
    const catalog = loadSkillCatalog({ storedSkills: stored })

    assert.equal(catalog['abc123']?.readOnly, false)
    assert.equal(catalog['abc123']?.source, 'stored')
    assert.equal(catalog['utkozo-teszt'], undefined, 'the stored record owns the name; no duplicate card')
  })
})

test('loadSkillCatalog leaves stored skills otherwise untouched', () => {
  const stored: Record<string, Skill> = {
    xyz789: {
      id: 'xyz789',
      name: 'csak-tarolt',
      filename: 'csak-tarolt.md',
      content: '# stored only',
      createdAt: 1,
      updatedAt: 2,
    },
  }
  const catalog = loadSkillCatalog({ storedSkills: stored })

  assert.equal(catalog['xyz789']?.name, 'csak-tarolt')
  assert.equal(catalog['xyz789']?.updatedAt, 2)
})
