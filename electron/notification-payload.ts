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

/**
 * Body length past which the excerpt is cut with an ellipsis. macOS trims a
 * banner further on its own; this only keeps a pathological reply from
 * shipping kilobytes over IPC.
 */
const MAX_BODY_LENGTH = 200

/**
 * Remove markdown syntax so the few characters a notification shows are words,
 * not `**` and `#`. Only markup is removed: underscores inside words
 * (`foo_bar`) and a lone `*` (`2 * 3`) are left alone.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}])_(\S(?:.*?\S)?)_(?![\p{L}\p{N}])/gu, '$1')
    .replace(/`([^`]*)`/g, '$1')
}

/**
 * Strip markdown, collapse whitespace/newlines into single spaces and cut to
 * a single-line excerpt, falling back to `fallback` when nothing is left.
 */
function excerptOf(text: string | null | undefined, fallback: string): string {
  const collapsed = stripMarkdown(text ?? '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return fallback
  if (collapsed.length <= MAX_BODY_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_BODY_LENGTH).trimEnd()}…`
}

/**
 * The text is its own function so it is testable without an Electron
 * runtime. User text is only stripped of markdown marks, whitespace-collapsed
 * and length-limited — never otherwise rewritten.
 */
export function buildNotificationPayload(session: NotifiableSession, agentName: string): NotificationPayload {
  const failed = typeof session.lastFailedTurnAt === 'number' ? session.lastFailedTurnAt : 0
  const assistant = typeof session.lastAssistantAt === 'number' ? session.lastAssistantAt : 0
  const isError = failed > 0 && failed >= assistant
  return {
    title: agentName.trim() || 'SwarmClaw',
    body: isError
      ? `Run failed: ${session.name}`
      : excerptOf(session.lastMessageText, session.name),
    isError,
  }
}
