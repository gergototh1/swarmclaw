import fs from 'node:fs'
import path from 'node:path'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { trashAgent } from '@/lib/server/agents/agent-service'
import { deleteSchedule, loadSchedules } from '@/lib/server/schedules/schedule-repository'
import { resolveWorkspaceSkillsDir } from '@/lib/server/skills/skill-discovery'
import { log } from '@/lib/server/logger'
import { notify } from '@/lib/server/ws-hub'

/**
 * The delete branch of extension-managed resources: what an uninstall does to
 * the agents and schedules a reconcile created.
 *
 * `reconcileExtensionManagedResources` has a create branch and an update
 * branch and, before this file, nothing that ran the other way. An uninstall
 * dropped the extension's tables and its files and left both schedules
 * `active` on their cron, resolving to agents that still existed, whose
 * prompts told them to call tools that were gone. The scheduler then
 * dispatched a dozen unattended turns a day that could only fail, and nothing
 * on the Extensions screen said why, because the extension was no longer on
 * it.
 *
 * Kept in its own module rather than in `extension-managed-resources.ts`:
 * that file imports the extension manager, and the manager's `deleteExtension`
 * is the caller here, so the reconcile module cannot be its dependency without
 * a cycle. This file reaches only the repositories.
 *
 * WHAT HAPPENS TO AN AGENT THE OPERATOR HAS EDITED
 * ------------------------------------------------
 * Nothing here can tell an edited managed agent from an untouched one: the
 * marker records the hash of the DECLARATION, not of the stored row, and a
 * reconcile deliberately preserves the route, the pins and the budgets an
 * operator set by hand, so the stored row is expected to differ from the
 * declaration. The choice is therefore made for every managed agent alike,
 * and it is the trash, not the delete. `trashAgent` is the same path the
 * agents screen's delete button takes: the row keeps everything the operator
 * changed, it drops out of every listing, its sessions are detached and its
 * references suspended, and the Trash view can restore it. An operator who
 * had made one of these agents their own gets it back with one click; an
 * operator who never touched it never sees it again. Deleting outright would
 * have made the first case unrecoverable to save the second one a row in the
 * trash.
 *
 * The schedules are not trashed, because a schedule has no trash, and they
 * are deleted rather than paused or archived for a reason a reinstall
 * exposes: `buildManagedSchedule` finds an existing managed schedule by its
 * stable id and keeps an `archived` one archived, so a paused-or-archived
 * leftover would have made the next install's reconcile produce two
 * schedules that never run. A deleted one is simply created again. Their run
 * history goes with them; the schedule history is the extension's, and the
 * activity log keeps the fact that the uninstall removed them.
 *
 * Order matters: schedules first, agents second. Trashing an agent pauses
 * its schedules with a `suspendedByTrash` marker for restore, and a schedule
 * that is about to be deleted has no business being marked for restore.
 *
 * WHAT HAPPENS TO THE SKILL FILES
 * -------------------------------
 * An installer that copies skill directories into the workspace skills layer
 * (`<SWARMCLAW_HOME>/skills`, the layer `discoverSkills` scans) records the
 * directory names it shipped in `shipped-skills.json` in the extension's
 * workspace, because a copy alone is not an upgrade and the next install
 * needs to know what to prune. The same manifest is what an uninstall needs:
 * without it the host cannot tell a shipped directory from one the operator
 * wrote, and a name a declaration pins is not safe to remove by name, since
 * a declaration matches a skill on its frontmatter `name` and an operator's
 * own skill may carry the same one. So exactly the directories the manifest
 * names are removed, and a workspace with no manifest removes none. Read
 * BEFORE the workspace is removed, which is why the caller passes the path
 * rather than this file deriving it after the fact.
 */
export const SHIPPED_SKILLS_MANIFEST = 'shipped-skills.json'

export interface ManagedResourceTeardownResult {
  deletedSchedules: string[]
  trashedAgents: string[]
  removedSkillDirs: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The directory names an installer recorded as shipped, or none. */
export function readShippedSkillNames(workspaceDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(workspaceDir, SHIPPED_SKILLS_MANIFEST), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * Removes the named directories from the workspace skills layer. A name that
 * would leave that directory -- a separator, a `..` -- is refused rather than
 * resolved, because the manifest is a file on disk and this is a delete.
 */
export function removeShippedSkillDirs(names: string[]): string[] {
  const skillsDir = resolveWorkspaceSkillsDir()
  const removed: string[] = []
  for (const name of names) {
    if (name !== path.basename(name) || name === '.' || name === '..') {
      log.warn('extensions', 'Refusing to remove a shipped skill whose name is not a plain directory name', { name })
      continue
    }
    const target = path.join(skillsDir, name)
    if (!fs.existsSync(target)) continue
    fs.rmSync(target, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/**
 * Deletes every schedule and trashes every agent marked as managed by
 * `extensionId`. Idempotent: an extension with nothing marked removes nothing.
 */
export function removeExtensionManagedResources(extensionId: string): Omit<ManagedResourceTeardownResult, 'removedSkillDirs'> {
  const deletedSchedules: string[] = []
  const trashedAgents: string[] = []

  for (const schedule of Object.values(loadSchedules())) {
    const marker: unknown = schedule?.managedByExtension
    if (!isRecord(marker) || marker.extensionId !== extensionId) continue
    deleteSchedule(schedule.id)
    deletedSchedules.push(schedule.id)
  }

  for (const agent of Object.values(loadAgents())) {
    const marker: unknown = agent?.managedByExtension
    if (!isRecord(marker) || marker.extensionId !== extensionId) continue
    const result = trashAgent(agent.id)
    if (result.ok) trashedAgents.push(agent.id)
  }

  if (deletedSchedules.length > 0) notify('schedules')
  if (trashedAgents.length > 0) notify('agents')
  return { deletedSchedules, trashedAgents }
}
