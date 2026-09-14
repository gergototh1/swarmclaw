/**
 * Splits markdown into the blocks a renderer can memoize.
 *
 * A streamed answer grows at the end, so every block but the last is byte-for-byte
 * what it was on the previous chunk. Rendering one memoized component per block
 * means a chunk re-parses and re-highlights only the block being written, instead
 * of the whole message — which is what made a long answer cost more and more per
 * chunk.
 *
 * Blocks break on blank lines, except:
 *  - inside a fenced code block: a fence that is still open (the model is
 *    mid-code-block) keeps everything after it in one block, so the fence is
 *    never split across two renderers — including an unterminated fence at the
 *    end of a streaming message.
 *  - when the blank line sits between two lines that markdown treats as one
 *    unit even with blank lines between them. Splitting there would change how
 *    the message renders, not just how it's chunked for memoization:
 *      1. the next non-empty line is indented by 2+ spaces — a continuation
 *         paragraph or nested content inside a list item.
 *      2. the block ends on a list item line and the next non-empty line is
 *         also a list item — a "loose" list must stay one list, or it renders
 *         as several separate lists with different spacing.
 *      3. the block ends on a block-quote line and the next non-empty line is
 *         also a block quote.
 */
const FENCE = /^\s{0,3}(```|~~~)/
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/
const BLOCKQUOTE_RE = /^\s{0,3}>/
const INDENTED_RE = /^ {2,}\S/

function lastNonEmptyLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i]
  }
  return null
}

/** Whether a blank-line run between `current`'s last line and `nextLine` should NOT split the block. */
function keepsBlockTogether(current: string[], nextLine: string): boolean {
  if (INDENTED_RE.test(nextLine)) return true
  const prevLine = lastNonEmptyLine(current)
  if (prevLine === null) return false
  if (LIST_ITEM_RE.test(prevLine) && LIST_ITEM_RE.test(nextLine)) return true
  if (BLOCKQUOTE_RE.test(prevLine) && BLOCKQUOTE_RE.test(nextLine)) return true
  return false
}

export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null

  const closeBlock = () => {
    const block = current.join('\n').trim()
    if (block.length > 0) blocks.push(block)
    current = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE)

    if (fence === null && fenceMatch) {
      // A fence starts a block of its own, so the paragraph before it stays separate.
      closeBlock()
      fence = fenceMatch[1]
      current.push(line)
      i++
      continue
    }

    if (fence !== null) {
      current.push(line)
      if (fenceMatch && fenceMatch[1] === fence) {
        fence = null
        closeBlock()
      }
      i++
      continue
    }

    if (line.trim() === '') {
      // Look past the whole run of blank lines to the next real line.
      let j = i
      while (j < lines.length && lines[j].trim() === '') j++
      if (j >= lines.length) {
        // Trailing blank lines: nothing left to decide.
        i = j
        continue
      }
      const nextLine = lines[j]
      if (current.length > 0 && keepsBlockTogether(current, nextLine)) {
        // Keep the blank-line run itself — it's part of the block's markdown.
        for (let k = i; k < j; k++) current.push(lines[k])
      } else {
        closeBlock()
      }
      i = j
      continue
    }

    current.push(line)
    i++
  }
  closeBlock()
  return blocks
}
