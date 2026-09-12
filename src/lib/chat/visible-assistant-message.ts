import type { Message } from '@/types'

/**
 * Whether a stored message is a finished assistant reply the user can see.
 *
 * `lastAssistantAt` is derived from this, and both the unread dot and the
 * desktop notification are derived from `lastAssistantAt`. So this is the one
 * place that decides what "the agent wrote something in the chat" means.
 *
 * The case it exists for: while a turn runs, the server saves the half-built
 * reply every few hundred milliseconds with `streaming: true`, often with no
 * text and only tool events. Counting those fired a notification for every
 * hidden tool step, with an empty body that fell back to the chat name.
 */
export type VisibleAssistantInput = Pick<
  Message,
  'role' | 'text' | 'streaming' | 'suppressed' | 'kind' | 'imageUrl' | 'imagePath' | 'attachedFiles'
>

const VISIBLE_KINDS: ReadonlySet<NonNullable<Message['kind']>> = new Set(['chat', 'connector-delivery'])

export function isVisibleAssistantMessage(message: VisibleAssistantInput | null | undefined): boolean {
  if (!message || message.role !== 'assistant') return false
  if (message.streaming === true || message.suppressed === true) return false
  if (message.kind !== undefined && !VISIBLE_KINDS.has(message.kind)) return false
  const hasText = typeof message.text === 'string' && message.text.trim() !== ''
  const hasImage = Boolean(message.imageUrl || message.imagePath)
  const hasFiles = Array.isArray(message.attachedFiles) && message.attachedFiles.length > 0
  return hasText || hasImage || hasFiles
}
