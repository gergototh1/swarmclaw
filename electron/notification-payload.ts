/**
 * Which text a native desktop notification should show for an agent reply.
 *
 * Kept apart from `notifications.ts` so it can be tested without an Electron
 * runtime: it is pure text formatting and nothing here imports `electron`
 * (see the header comment of `electron/external-navigation.ts` for why that
 * split matters — outside an Electron runtime the `electron` package exports
 * a path string, not the API, so a test importing it would fail to resolve).
 */

export interface NotifiableSession {
  name: string
  lastAssistantAt?: number | null
  lastFailedTurnAt?: number | null
}

export interface NotificationPayload {
  title: string
  body: string
  isError: boolean
}

/**
 * The text is its own function so it is testable without an Electron
 * runtime. No user text is reinterpreted: the chat name passes through as-is.
 */
export function buildNotificationPayload(session: NotifiableSession, agentName: string): NotificationPayload {
  const failed = typeof session.lastFailedTurnAt === 'number' ? session.lastFailedTurnAt : 0
  const assistant = typeof session.lastAssistantAt === 'number' ? session.lastAssistantAt : 0
  const isError = failed > 0 && failed >= assistant
  return {
    title: agentName.trim() || 'SwarmClaw',
    body: isError ? `A futas hibaval vegzodott: ${session.name}` : `Valaszolt: ${session.name}`,
    isError,
  }
}
