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
  /**
   * The reply text to excerpt into the notification body (already truncated
   * upstream -- see `session.lastMessageSummary`). `null`/`undefined`/empty
   * falls back to the chat name so the notification is never empty.
   */
  lastMessageText?: string | null
}

export interface NotificationPayload {
  title: string
  body: string
  isError: boolean
}

/** Body length past which the excerpt is cut with an ellipsis. */
const MAX_BODY_LENGTH = 120

/**
 * Collapse whitespace/newlines into single spaces and cut to a single-line
 * excerpt, falling back to `fallback` when there is no usable text.
 */
function excerptOf(text: string | null | undefined, fallback: string): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return fallback
  if (collapsed.length <= MAX_BODY_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_BODY_LENGTH).trimEnd()}…`
}

/**
 * The text is its own function so it is testable without an Electron
 * runtime. No user text is reinterpreted: it is only whitespace-collapsed
 * and length-limited, never parsed or reformatted.
 */
export function buildNotificationPayload(session: NotifiableSession, agentName: string): NotificationPayload {
  const failed = typeof session.lastFailedTurnAt === 'number' ? session.lastFailedTurnAt : 0
  const assistant = typeof session.lastAssistantAt === 'number' ? session.lastAssistantAt : 0
  const isError = failed > 0 && failed >= assistant
  return {
    title: agentName.trim() || 'SwarmClaw',
    body: isError
      ? `A futas hibaval vegzodott: ${session.name}`
      : excerptOf(session.lastMessageText, session.name),
    isError,
  }
}
