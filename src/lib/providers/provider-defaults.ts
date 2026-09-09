/** Default base URLs for built-in LLM providers */
export const PROVIDER_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434',
  ollamaCloud: 'https://ollama.com',
} as const

/**
 * Which files a provider sends as image BYTES.
 *
 * The text-extension list that used to sit beside this is gone: deciding what
 * a non-image attachment says now happens once, in
 * `@/lib/server/attachments/attachment-text`, because four providers had four
 * copies of that decision and they had drifted apart. This one stays here --
 * it is not a question about content but about which of the two shapes a
 * provider's message format takes.
 */
export const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i

/** Max message history entries sent to providers */
export const MAX_HISTORY_MESSAGES = 40

/** Default max tokens for Anthropic responses */
export const ANTHROPIC_MAX_TOKENS = 8192

/**
 * Write an SSE data frame.  All provider streaming uses this envelope.
 *
 * @example writeSSE(write, 'd', delta)          // text delta
 * @example writeSSE(write, 'err', errMsg)       // error
 * @example writeSSE(write, 'md', jsonPayload)   // metadata
 */
export function writeSSE(write: (data: string) => void, type: string, text: string): void {
  write(`data: ${JSON.stringify({ t: type, text })}\n\n`)
}
