import type { ConversationRowState } from './conversation-row-state'

/**
 * Amit a sor bal szélén álló pont mutat.
 *
 * A `conversationRowState` szándékosan három független boolt ad vissza, nem
 * állapotgépet: egy chat lehet egyszerre olvasatlan és dolgozó. Egy pont
 * viszont egy dolgot tud mutatni, ezért a sorrendet itt kell eldönteni.
 *
 * A sorrend az, ami cselekvést kíván:
 *   1. hiba      -- beavatkozást kér, és magától nem múlik el
 *   2. dolgozik  -- él, és pár másodperc múlva úgyis olvasatlanná válik
 *   3. olvasatlan -- olvasásra vár
 */
export type ConversationDot = 'error' | 'working' | 'unread' | 'none'

export function conversationDot(state: ConversationRowState): ConversationDot {
  if (state.isError) return 'error'
  if (state.working) return 'working'
  if (state.unread) return 'unread'
  return 'none'
}
