/**
 * Which list the Chat page shows beside the transcript: every conversation, or
 * one row per agent that opens the agent's own long-lived thread. Both lists
 * open the same `/chat/:sessionId` page; only the panel differs.
 */
export type ChatListMode = 'conversations' | 'agents'

export const CHAT_LIST_MODE_KEY = 'sc_chat_list_mode'

export function parseChatListMode(raw: string | null): ChatListMode {
  return raw === 'agents' ? 'agents' : 'conversations'
}
