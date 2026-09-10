import type { Session, Sessions } from '@/types'

/**
 * Which sessions the Chat page lists, and why the other four kinds are not on it.
 *
 * Three of the four are told apart by who opened them rather than by any field:
 * they all carry `sessionType: 'human'` and an `agentId`, so the type says
 * nothing about them. The fourth, a subagent session, is the exception -- it is
 * the one kind the type does name.
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
 * - A DELEGATED session is one an agent opened for a subagent. Unlike the three
 *   above it is marked as such (`sessionType: 'delegated'`), and that mark is
 *   what `isDelegatedSession` reads -- see its own note for why the
 *   `parentSessionId` is the wrong field to key on.
 *
 * The two prefixes each have exactly one writer, named above. There are two
 * readers -- the Chat page (`conversation-list.tsx`) and the desktop
 * notifier's diff logic (`reply-notifier-state.ts`), which must not fire a
 * notification for a row the list would not show -- and both go through
 * `listConversations` here rather than reimplementing the predicates, so the
 * two cannot drift apart unnoticed while this module's test stands.
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

/**
 * Egy session, amit egy ügynök nyitott egy subagentnek, nem beszélgetés.
 *
 * A `spawn_subagent` valódi, tartós sessiont hoz létre (`subagent-runtime.ts`),
 * üzenetekkel -- tehát a `hasMessages` igazat mond rá, és egyetlen Sidekick-futás
 * öt sorral tolja lejjebb a valódi beszélgetéseket. Ezek a szülő chatből érhetők
 * el, nem innen.
 *
 * A szűrő a `sessionType`-ra megy, NEM a `parentSessionId`-re: a
 * `buildNewAgentSessionPayload` (`new-session.ts`) a felhasználó saját
 * "új chat ebből" sessionjére is ráteszi a szülőt, csak 'human' típussal.
 * A parentSessionId-re szűrés valódi beszélgetéseket tüntetne el.
 */
export function isDelegatedSession(session: Session): boolean {
  return session.sessionType === 'delegated'
}

export function isConversation(session: Session): boolean {
  return hasMessages(session)
    && !isTaskRunSession(session)
    && !isChatroomSession(session)
    && !isDelegatedSession(session)
}

/**
 * Newest-first ordering, shared by `listConversations` and
 * `groupConversationsByAge`'s per-bucket sort. One definition, so a future
 * tiebreaker cannot land in one call site and silently not the other.
 */
function sortByRecency(a: Session, b: Session): number {
  return (b.lastActiveAt || 0) - (a.lastActiveAt || 0)
}

/** The conversations, newest activity first. */
export function listConversations(sessions: Sessions): Session[] {
  return Object.values(sessions)
    .filter(isConversation)
    .sort(sortByRecency)
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

export interface ConversationGroup {
  label: string
  sessions: Session[]
}

/**
 * Naptári vödrök, nem eltelt óra.
 *
 * A "24 óránál frissebb" nem az, amit az olvasó keres: reggel kilenckor a
 * tegnap esti beszélgetés tegnapi, nem "17 órás". Ezért minden határ helyi
 * idő szerinti nap-, hét- és hónapkezdet, és ezért kell a `now` paraméter --
 * enélkül a függvény nem lenne tesztelhető határnapokra.
 *
 * A hét hétfővel kezdődik (magyar konvenció; a JS `getDay()` vasárnapot ad
 * 0-nak, ezt a `(day + 6) % 7` fordítja meg).
 *
 * A `lastActiveAt` nélküli session az OLDER vödörbe kerül, nem esik ki: egy
 * hiányzó időbélyeg nem ok arra, hogy egy beszélgetés eltűnjön a listáról.
 */
export function groupConversationsByAge(sessions: Session[], now: number): ConversationGroup[] {
  const ref = new Date(now)
  const startOfToday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const startOfWeek = startOfToday - ((ref.getDay() + 6) % 7) * 86_400_000
  const startOfMonth = new Date(ref.getFullYear(), ref.getMonth(), 1).getTime()

  const buckets: ConversationGroup[] = [
    { label: 'TODAY', sessions: [] },
    { label: 'YESTERDAY', sessions: [] },
    { label: 'THIS WEEK', sessions: [] },
    { label: 'THIS MONTH', sessions: [] },
    { label: 'OLDER', sessions: [] },
  ]

  for (const session of sessions) {
    const at = session.lastActiveAt || 0
    if (at >= startOfToday) buckets[0].sessions.push(session)
    else if (at >= startOfYesterday) buckets[1].sessions.push(session)
    else if (at >= startOfWeek) buckets[2].sessions.push(session)
    else if (at >= startOfMonth) buckets[3].sessions.push(session)
    else buckets[4].sessions.push(session)
  }

  for (const bucket of buckets) {
    bucket.sessions.sort(sortByRecency)
  }

  return buckets.filter((bucket) => bucket.sessions.length > 0)
}
