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
