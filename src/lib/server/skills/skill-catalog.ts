import fs from 'fs'
import type { Skill } from '@/types'
import { loadSkills } from '@/lib/server/storage'
import { discoverSkills } from './skill-discovery'
import { buildSkillKey } from './runtime-skill-resolver'

function fileMtime(sourcePath: string): number {
  try {
    return fs.statSync(sourcePath).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Every skill an agent can actually reach, as one map the UI can list.
 *
 * `loadSkills()` alone only sees the skills table, so a SKILL.md written
 * straight into `<SWARMCLAW_HOME>/skills` or shipped in the app's own `skills/`
 * directory was invisible in the Skills page while `resolveRuntimeSkills`
 * happily put it in the agent's prompt. This merges the same three discovery
 * layers the runtime uses on top of the stored records.
 *
 * A discovered skill is keyed by its frontmatter name, which is the string an
 * agent's `skillIds` pin already carries for a file that has no storage id --
 * so pinning one from the agent sheet writes a selector `skillSelectors()`
 * matches. When a name collides, the stored record wins: it is the one that can
 * be edited and deleted.
 */
export function loadSkillCatalog(opts?: {
  cwd?: string
  storedSkills?: Record<string, Skill>
}): Record<string, Skill> {
  const stored = opts?.storedSkills ?? loadSkills()
  const catalog: Record<string, Skill> = {}
  const claimed = new Set<string>()

  for (const skill of Object.values(stored)) {
    catalog[skill.id] = { ...skill, source: 'stored', readOnly: false }
    claimed.add(buildSkillKey(skill))
  }

  for (const discovered of discoverSkills({ cwd: opts?.cwd })) {
    const key = buildSkillKey(discovered)
    if (claimed.has(key)) continue
    claimed.add(key)
    const id = discovered.name
    if (catalog[id]) continue
    const mtime = fileMtime(discovered.sourcePath)
    catalog[id] = {
      ...discovered,
      id,
      readOnly: true,
      scope: 'global',
      agentIds: [],
      createdAt: mtime,
      updatedAt: mtime,
    }
  }

  return catalog
}
