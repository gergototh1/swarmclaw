import type { ProviderId, Session } from '@/types'

type SessionResetSnapshot = Pick<
  Session,
  | 'provider'
  | 'claudeSessionId'
  | 'codexThreadId'
  | 'opencodeSessionId'
  | 'opencodeWebSessionId'
  | 'geminiSessionId'
  | 'copilotSessionId'
  | 'droidSessionId'
  | 'cursorSessionId'
  | 'qwenSessionId'
  | 'acpSessionId'
  | 'delegateResumeIds'
>

type AgentSessionCloneSource = Pick<
  Session,
  | 'id'
  | 'name'
  | 'cwd'
  | 'user'
  | 'provider'
  | 'model'
  | 'ollamaMode'
  | 'credentialId'
  | 'fallbackCredentialIds'
  | 'apiEndpoint'
  | 'routePreferredGatewayTags'
  | 'routePreferredGatewayUseCase'
  | 'sessionType'
  | 'agentId'
  | 'tools'
  | 'extensions'
  | 'heartbeatEnabled'
  | 'heartbeatIntervalSec'
  | 'sessionResetMode'
  | 'sessionIdleTimeoutSec'
  | 'sessionMaxAgeSec'
  | 'sessionDailyResetAt'
  | 'sessionResetTimezone'
  | 'thinkingLevel'
>

const PROVIDER_RESET_HINTS: Partial<Record<ProviderId, { label: string; equivalentCommand?: string }>> = {
  'copilot-cli': { label: 'Copilot CLI', equivalentCommand: '/new' },
}

const CLI_PROVIDER_IDS = new Set<ProviderId>([
  'claude-cli',
  'codex-cli',
  'opencode-cli',
  'gemini-cli',
  'copilot-cli',
  'droid-cli',
  'cursor-cli',
  'qwen-code-cli',
  'goose',
])

export function hasResettableSessionRuntime(session: SessionResetSnapshot): boolean {
  return Boolean(
    session.claudeSessionId
      || session.codexThreadId
      || session.opencodeSessionId
      || session.opencodeWebSessionId
      || session.geminiSessionId
      || session.copilotSessionId
      || session.droidSessionId
      || session.cursorSessionId
      || session.qwenSessionId
      || session.acpSessionId
      || session.delegateResumeIds?.claudeCode
      || session.delegateResumeIds?.codex
      || session.delegateResumeIds?.opencode
      || session.delegateResumeIds?.gemini
      || session.delegateResumeIds?.copilot
      || session.delegateResumeIds?.droid
      || session.delegateResumeIds?.cursor
      || session.delegateResumeIds?.qwen
  )
}

export function getNewSessionButtonTitle(session: SessionResetSnapshot): string {
  const providerHint = PROVIDER_RESET_HINTS[session.provider]
  if (providerHint?.equivalentCommand) {
    return `Create a brand-new chat session. For ${providerHint.label}, this starts fresh instead of reusing the saved thread (equivalent to ${providerHint.equivalentCommand}).`
  }
  if (CLI_PROVIDER_IDS.has(session.provider)) {
    return 'Create a brand-new chat session without reusing the saved CLI thread.'
  }
  return 'Create a brand-new chat session and keep the current conversation intact.'
}

export function buildNewAgentSessionPayload(session: AgentSessionCloneSource): Record<string, unknown> {
  return {
    name: session.name,
    cwd: session.cwd,
    user: session.user,
    provider: session.provider,
    model: session.model,
    ollamaMode: session.ollamaMode ?? null,
    credentialId: session.credentialId ?? null,
    fallbackCredentialIds: session.fallbackCredentialIds ?? [],
    apiEndpoint: session.apiEndpoint ?? null,
    routePreferredGatewayTags: session.routePreferredGatewayTags ?? [],
    routePreferredGatewayUseCase: session.routePreferredGatewayUseCase ?? null,
    sessionType: session.sessionType ?? 'human',
    agentId: session.agentId ?? null,
    parentSessionId: session.id,
    tools: session.tools ?? [],
    extensions: session.extensions ?? [],
    heartbeatEnabled: session.heartbeatEnabled ?? null,
    heartbeatIntervalSec: session.heartbeatIntervalSec ?? null,
    sessionResetMode: session.sessionResetMode ?? null,
    sessionIdleTimeoutSec: session.sessionIdleTimeoutSec ?? null,
    sessionMaxAgeSec: session.sessionMaxAgeSec ?? null,
    sessionDailyResetAt: session.sessionDailyResetAt ?? null,
    sessionResetTimezone: session.sessionResetTimezone ?? null,
    thinkingLevel: session.thinkingLevel ?? null,
  }
}

/** A fresh conversation with the agent that owns `thread`, named after the agent. */
export function buildAgentChatPayload(thread: AgentSessionCloneSource, agentName: string | null): Record<string, unknown> {
  return { ...buildNewAgentSessionPayload(thread), name: agentName || thread.name }
}

export function sortSessionsNewestFirst<T extends Pick<Session, 'createdAt' | 'lastActiveAt'>>(sessions: T[]): T[] {
  return [...sessions].sort((left, right) => {
    const leftTime = left.lastActiveAt || left.createdAt || 0
    const rightTime = right.lastActiveAt || right.createdAt || 0
    return rightTime - leftTime
  })
}

export function summarizeFirstMessageAsTitle(text: string, fallback = 'New Chat'): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/[`*_#>\[\]]/g, '')
    .trim()
  if (!cleaned) return fallback
  const sentenceMatch = cleaned.match(/^(.+?[.!?])(?:\s|$)/)
  const sentence = (sentenceMatch?.[1] || cleaned).trim()
  const words = sentence.split(' ').filter(Boolean).slice(0, 8)
  const shortened = words.join(' ').trim()
  if (!shortened) return fallback
  return shortened.length > 60 ? `${shortened.slice(0, 57).trimEnd()}...` : shortened
}
