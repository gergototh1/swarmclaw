import { sessionUnreadState, type SessionUnreadInput } from '@/lib/chat/session-unread'

/**
 * Amit egy sor magarol tud. Harom fuggetlen teny, nem egy allapotgep:
 * egy chat lehet EGYSZERRE olvasatlan es dolgozo (valaszolt, aztan tovabb
 * ment), ezert nem `status`-t adunk vissza, hanem harom boolt.
 *
 * `working` a `session.active`, amit a futasido tart karban. A lista mar fel
 * van iratkozva a `runs` topicra, tehat ez magatol frissul.
 */
export interface ConversationRowInput extends SessionUnreadInput {
  active?: boolean
}

export interface ConversationRowState {
  unread: boolean
  isError: boolean
  working: boolean
}

export function conversationRowState(session: ConversationRowInput): ConversationRowState {
  const { unread, isError } = sessionUnreadState(session)
  return { unread, isError, working: session.active === true }
}
