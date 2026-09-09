import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { genId } from '@/lib/id'
import { loadSkills, saveSkills } from '@/lib/server/storage'
import { loadSkillCatalog } from '@/lib/server/skills/skill-catalog'
import { normalizeSkillPayload } from '@/lib/server/skills/skills-normalize'
export const dynamic = 'force-dynamic'


// The catalog, not just the skills table: a SKILL.md discovered on disk is
// already in the agent's prompt, so it belongs in the list the operator sees.
export async function GET() {
  return NextResponse.json(loadSkillCatalog())
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const skills = loadSkills()
  const id = genId()
  const normalized = normalizeSkillPayload(body)
  const scope = body.scope === 'agent' ? 'agent' as const : 'global' as const
  const agentIds = scope === 'agent' && Array.isArray(body.agentIds)
    ? (body.agentIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : []
  skills[id] = {
    id,
    name: normalized.name,
    filename: normalized.filename || `skill-${id}.md`,
    content: normalized.content || '',
    description: normalized.description || '',
    sourceUrl: normalized.sourceUrl,
    sourceFormat: normalized.sourceFormat,
    author: normalized.author,
    tags: normalized.tags,
    version: normalized.version,
    homepage: normalized.homepage,
    primaryEnv: normalized.primaryEnv,
    skillKey: normalized.skillKey,
    toolNames: normalized.toolNames,
    capabilities: normalized.capabilities,
    always: normalized.always,
    installOptions: normalized.installOptions,
    skillRequirements: normalized.skillRequirements,
    detectedEnvVars: normalized.detectedEnvVars,
    security: normalized.security,
    invocation: normalized.invocation,
    commandDispatch: normalized.commandDispatch,
    frontmatter: normalized.frontmatter,
    scope,
    agentIds,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveSkills(skills)
  return NextResponse.json(skills[id])
}
