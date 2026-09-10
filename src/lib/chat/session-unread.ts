import type { Session } from '@/types'
import { isVisibleSessionForViewer } from '@/lib/observability/local-observability'

/**
 * Az olvasatlansag SZARMAZTATOTT ertek, nem tarolt boolean.
 *
 * Harom idobelyeg donti el, es mindharom a szerveron el:
 *   - `lastAssistantAt` -- az utolso ugynok-uzenet. Mar letezett; a
 *     `message-repository` tartja karban.
 *   - `lastFailedTurnAt` -- az utolso hibaval vegzodo turn. Azert kell kulon,
 *     mert egy elhasalt turn gyakran nem hagy maga utan uzenetet, tehat a
 *     `lastAssistantAt` nem mozdulna, es a hiba nemakent tunne el.
 *   - `lastReadAt` -- meddig olvastad.
 *
 * `isError` akkor igaz, ha a hiba az UTOLSO esemeny: egy kesobbi sikeres valasz
 * elmossa a korabbi hibat, mert a beszelgetes azota tovabb ment.
 */
export interface SessionUnreadInput {
  lastAssistantAt?: number | null
  lastFailedTurnAt?: number | null
  lastReadAt?: number | null
}

export interface SessionUnreadState {
  unread: boolean
  isError: boolean
  lastActivityAt: number
}

function at(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function sessionUnreadState(session: SessionUnreadInput): SessionUnreadState {
  const assistant = at(session.lastAssistantAt)
  const failed = at(session.lastFailedTurnAt)
  const read = at(session.lastReadAt)
  const lastActivityAt = Math.max(assistant, failed)
  const unread = lastActivityAt > read
  return { unread, isError: unread && failed >= assistant && failed > 0, lastActivityAt }
}

export interface SessionWithUnreadState<T extends SessionUnreadInput = SessionUnreadInput> {
  session: T
  unread: SessionUnreadState
}

export function selectUnreadSessions<T extends SessionUnreadInput>(
  sessions: Record<string, T>,
): SessionWithUnreadState<T>[] {
  return Object.values(sessions)
    .map((session) => ({ session, unread: sessionUnreadState(session) }))
    .filter((row) => row.unread.unread)
    .sort((a, b) => b.unread.lastActivityAt - a.unread.lastActivityAt)
}

/**
 * `selectUnreadSessions` alone is not safe to render straight from the store:
 * `GET /api/chats` returns every session in the install, and the `/chat`
 * destination does not re-check ownership. Every other surface that lists
 * sessions (search, the command palette) gates through
 * `isVisibleSessionForViewer` before showing anything, so the unread-chat row
 * list on home does too. Filter first, then rank -- a session that's invisible
 * to this viewer never enters the unread computation at all.
 */
export function selectVisibleUnreadSessions(
  sessions: Record<string, Session>,
  currentUser: string | null | undefined,
  options?: { localhost?: boolean },
): SessionWithUnreadState<Session>[] {
  const visible: Record<string, Session> = {}
  for (const [id, session] of Object.entries(sessions)) {
    if (isVisibleSessionForViewer(session, currentUser, options)) visible[id] = session
  }
  return selectUnreadSessions(visible)
}
