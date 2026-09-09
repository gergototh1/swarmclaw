import type { Session, Sessions } from '@/types'

/**
 * Which sessions the Chat page lists, and why the other three kinds are not on it.
 *
 * Every session in this app is `sessionType: 'human'` and carries an `agentId`,
 * so the type tells nothing apart. What separates them is who opened them:
 *
 * - A SCHEDULED RUN is opened by the task pipeline, which names it
 *   `[Task] <agent>: <task>` (`src/lib/server/agents/task-session.ts`). These
 *   are the loudest rows in the store -- two of them hold 199 and 181 messages
 *   against a typical conversation's two to eight -- and they would push every
 *   real conversation off the first screen. They belong to the Tasks board,
 *   which is where they are opened from and reported on.
 *
 * - A CHATROOM session is one agent's half of a room
 *   (`resolveChatroomSyntheticSessionId`), and a room reads as one thing on
 *   the Chatrooms page rather than as one row per participant here.
 *
 * - An EMPTY session is not a conversation yet. There are nine of them in this
 *   install, most named after their agent, which is what a list of "Sidekick,
 *   Sidekick, Sidekick" would be made of.
 *
 * The two prefixes each have exactly one writer, named above; this is the only
 * reader, so the pair cannot drift apart unnoticed while its test stands.
 */

const TASK_SESSION_NAME_PREFIX = '[Task] '
const CHATROOM_SESSION_ID_PREFIX = 'chatroom-'

/** A run the scheduler or task board opened, not a conversation someone had. */
export function isTaskRunSession(session: Session): boolean {
  return typeof session.name === 'string' && session.name.startsWith(TASK_SESSION_NAME_PREFIX)
}

/** One agent's half of a chatroom, which the Chatrooms page owns. */
export function isChatroomSession(session: Session): boolean {
  return typeof session.id === 'string' && session.id.startsWith(CHATROOM_SESSION_ID_PREFIX)
}

/**
 * Whether a session has anything in it.
 *
 * `messageCount` is the answer, but only because the list endpoint now reads
 * it from the message table on every call (`listChatsForApi`). The stored
 * field it used to carry was denormalised and stale -- 0 for sessions holding
 * dozens of rows -- and trusting that hid every real conversation behind an
 * empty page. The two fallbacks cover a session that reached this code from
 * somewhere other than that endpoint.
 */
export function hasMessages(session: Session): boolean {
  if (typeof session.messageCount === 'number' && session.messageCount > 0) return true
  if (session.lastMessageSummary) return true
  return Array.isArray(session.messages) && session.messages.length > 0
}

export function isConversation(session: Session): boolean {
  return hasMessages(session) && !isTaskRunSession(session) && !isChatroomSession(session)
}

/** The conversations, newest activity first. */
export function listConversations(sessions: Sessions): Session[] {
  return Object.values(sessions)
    .filter(isConversation)
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
}

/**
 * What a conversation is called in the list.
 *
 * A session's `name` is the first user message when there was one and the
 * agent's own name when there was not, so it is right most of the time and
 * useless exactly when several conversations with one agent pile up under that
 * agent's name. The last message is the tiebreaker the reader actually has.
 */
export function conversationTitle(session: Session, fallback: string): string {
  const name = (session.name || '').trim()
  if (name && name !== 'New Chat') return name
  const summary = session.lastMessageSummary?.text?.trim()
  if (summary) return summary.split('\n')[0].slice(0, 80)
  return fallback
}
