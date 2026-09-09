import type { Message, Session } from '@/types'

const MAX_SESSION_SUMMARY_TEXT = 280

type SessionSummaryLike = Pick<Session, 'messages'> & Partial<Pick<Session, 'messageCount' | 'lastMessageSummary' | 'lastAssistantAt'>>

export function getSessionMessageCount(session: SessionSummaryLike): number {
  if (typeof session.messageCount === 'number' && Number.isFinite(session.messageCount)) {
    return session.messageCount
  }
  return Array.isArray(session.messages) ? session.messages.length : 0
}

export function getSessionLastMessage(session: SessionSummaryLike): Message | null {
  if (session.lastMessageSummary) return session.lastMessageSummary
  return Array.isArray(session.messages) && session.messages.length > 0
    ? session.messages[session.messages.length - 1]
    : null
}

export function getSessionLastAssistantAt(session: SessionSummaryLike): number | null {
  if (typeof session.lastAssistantAt === 'number' && Number.isFinite(session.lastAssistantAt)) {
    return session.lastAssistantAt
  }
  if (!Array.isArray(session.messages)) return null
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index]
    if (message?.role === 'assistant' && typeof message.time === 'number') {
      return message.time
    }
  }
  return null
}

function summarizeMessage(message: Message | null): Message | null {
  if (!message) return null
  return {
    role: message.role,
    text: typeof message.text === 'string'
      ? message.text.slice(0, MAX_SESSION_SUMMARY_TEXT)
      : '',
    time: message.time,
    kind: message.kind,
    source: message.source,
    suppressed: message.suppressed,
    streaming: message.streaming,
    bookmarked: message.bookmarked,
  }
}

export function buildSessionListSummary(session: Session): Session {
  return {
    ...session,
    messages: [],
    /*
     * `getSessionMessageCount`, NOT `session.messages.length`.
     *
     * Messages moved to the `session_messages` table, so the array on a stored
     * record is empty for every session that is not mid-migration -- and this
     * counted that array. The list endpoint therefore reported 0 messages for
     * all 42 sessions in a real install, including one holding 199, and
     * anything asking "is this conversation empty" got yes for all of them.
     * The helper directly above prefers the record's own count, which
     * `listChatsForApi` fills from the table before calling this.
     */
    messageCount: getSessionMessageCount(session),
    lastAssistantAt: getSessionLastAssistantAt(session),
    lastMessageSummary: summarizeMessage(getSessionLastMessage(session)),
  }
}
