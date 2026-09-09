import type { Session } from '@/types'

/**
 * Egy hibaval vegzodott turn idejenek rogzitese.
 *
 * MIERT CSAK A `failed`. A `completed` turn a `lastAssistantAt`-on keresztul
 * amugy is jelez, tehat ott irni ketszeres konyveles lenne. A `cancelled`
 * pedig a felhasznalo sajat dontese volt -- arrol ertesitest kuldeni
 * ertelmetlen.
 */
export interface RecordFailedTurnDeps {
  patch: (id: string, updater: (current: Session | null) => Session | null) => Session | null
}

export function recordFailedTurn(
  sessionId: string,
  status: string,
  deps: RecordFailedTurnDeps,
): boolean {
  if (status !== 'failed') return false
  const lastFailedTurnAt = Date.now()
  const next = deps.patch(sessionId, (current) => {
    if (!current) return null
    return { ...current, lastFailedTurnAt }
  })
  return next !== null
}
