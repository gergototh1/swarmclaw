/**
 * Generates concise abstracts (~100 tokens) for memory entries.
 *
 * Used in proactive recall to inject summaries instead of truncated raw content,
 * reducing token waste and preserving semantic meaning.
 */
import { HumanMessage } from '@langchain/core/messages'

const ABSTRACT_TIMEOUT_MS = 15_000

/**
 * Budget for a model-free abstract, matched to the width of one recall bullet
 * so the summary and the line that renders it agree. Characters, not tokens —
 * a character count is the same on every model.
 */
export const ABSTRACT_MAX_CHARS = 220

/** Sentence end: . ! ? possibly closed by a quote or bracket, then a space or the end. */
const SENTENCE_END = /([.!?]["'»)\]]?)(\s+|$)/g

/**
 * Summarize without a model.
 *
 * A fleet running entirely on CLI providers has no generation model to call,
 * so this is the abstract for every memory, not a rare fallback. The old
 * behaviour — content.slice(0, 150) — cut mid-word and mid-sentence, which is
 * what a reader saw in every recall bullet.
 *
 * Three passes, cheapest first: a structured note's own heading line, then
 * whole sentences, then a word boundary.
 */
export function summarizeWithoutModel(content: string, maxChars: number = ABSTRACT_MAX_CHARS): string {
  const raw = String(content || '')
  if (!raw.trim()) return ''

  // A note written as "HEADING\ndetail\ndetail" already states its own summary
  // on the first line. Require some substance, so a stray short line does not
  // become the abstract of a long note.
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length > 1) {
    const first = lines[0].replace(/\s+/g, ' ')
    if (first.length >= 12 && first.length <= maxChars) return first
  }

  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat

  // Whole sentences while they fit. Ending on a sentence boundary reads as a
  // summary; ending mid-clause reads as damage.
  SENTENCE_END.lastIndex = 0
  let end = 0
  for (let match = SENTENCE_END.exec(flat); match; match = SENTENCE_END.exec(flat)) {
    const candidate = match.index + match[1].length
    if (candidate > maxChars) break
    end = candidate
  }
  if (end > 0) return flat.slice(0, end).trim()

  // No sentence fits — cut at the last word boundary inside the budget.
  const clipped = flat.slice(0, maxChars)
  const lastSpace = clipped.lastIndexOf(' ')
  const cut = lastSpace > maxChars * 0.5 ? clipped.slice(0, lastSpace) : clipped
  return `${cut.replace(/[\s,;:–—-]+$/, '')}...`
}

/**
 * Generate a short abstract (~100 tokens) summarizing memory content.
 * Falls back to a truncated prefix if LLM generation fails or is unavailable.
 */
export async function generateAbstract(content: string, title?: string): Promise<string | null> {
  if (!content || content.length <= 200) return null

  try {
    const { buildLLM } = await import('@/lib/server/build-llm')
    const { llm } = await buildLLM()

    const prompt = [
      'Summarize the following memory entry in 1-2 concise sentences (max ~100 tokens).',
      'Preserve the key facts, decisions, or conclusions. Do not add commentary.',
      title ? `Title: ${title}` : '',
      `Content: ${content.slice(0, 2000)}`,
    ].filter(Boolean).join('\n')

    const response = await Promise.race([
      llm.invoke([new HumanMessage(prompt)]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('abstract-timeout')), ABSTRACT_TIMEOUT_MS),
      ),
    ])

    const text = extractText(response.content)
    return text || fallbackAbstract(content)
  } catch {
    return fallbackAbstract(content)
  }
}

function fallbackAbstract(content: string): string {
  return summarizeWithoutModel(content)
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') return part.trim()
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text.trim()
      }
    }
  }
  return ''
}
