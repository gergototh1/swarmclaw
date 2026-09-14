/**
 * Splits markdown into the blocks a renderer can memoize.
 *
 * A streamed answer grows at the end, so every block but the last is byte-for-byte
 * what it was on the previous chunk. Rendering one memoized component per block
 * means a chunk re-parses and re-highlights only the block being written, instead
 * of the whole message — which is what made a long answer cost more and more per
 * chunk.
 *
 * What the rules below guarantee: rendering the blocks one by one and
 * concatenating the HTML gives the same HTML as rendering the whole text in one
 * pass. That is a promise about the reader's screen, and it is only as good as
 * the shapes it is checked against — `markdown-blocks-render.test.tsx` asserts it
 * with the app's own react-markdown pipeline over the constructs an agent answer
 * actually produces.
 *
 * How it holds:
 *  - A blank line ends a block, except where markdown treats both sides as one
 *    unit: the next line is indented by 2+ spaces (a continuation paragraph,
 *    nested list or code fence inside a list item), the block and the next line
 *    are both list items (a loose list must stay one list), or both are block
 *    quotes.
 *  - A fenced code block is never split. An indented fence belongs to the list
 *    item above it, so it neither opens nor closes a block. A closing run must be
 *    the same character as the opening one and at least as long, so a ````-fence
 *    containing ``` stays whole. An unterminated fence — the model is still
 *    writing the code — swallows everything after it.
 *  - A block keeps its lines' indentation: only leading and trailing blank LINES
 *    are dropped, never the leading spaces of a line, so a 4-space indented code
 *    block is still a code block on its own.
 *  - Some constructs bind to a use that can sit anywhere else in the message, or
 *    span blank lines by their own rules: footnote definitions, link/image
 *    reference definitions, and raw HTML blocks. When one of those appears
 *    outside a code fence the whole text is returned as a single block — correct,
 *    just without the memoization win.
 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
// `(?:\s|$)` matters mid-stream: a bare `2.` is already an (empty) list item to
// markdown, so the item the model has only half-typed must not split the list.
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d+[.)])(?:\s|$)/
const BLOCKQUOTE_RE = /^\s{0,3}>/
const INDENTED_RE = /^ {2,}\S/

/** Line shapes that cannot be split away from the rest of the document. */
const WHOLE_TEXT_LINE = [
  /^\s{0,3}\[\^[^\]]+\]:/, // footnote definition — its use may be any earlier block
  /^\s{0,3}\[[^\]]+\]:\s*\S/, // link / image reference definition — same
  /^\s{0,3}<[!/?a-zA-Z]/, // raw HTML block — types 1-5 run past blank lines
]

/** Whether `closing` ends a fenced block opened by `opening` (same char, no shorter). */
function closesFence(opening: string, closing: string): boolean {
  return closing[0] === opening[0] && closing.length >= opening.length
}

/** Drop leading and trailing blank lines, keeping every remaining line's indentation. */
function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

/**
 * The last non-empty line at the block's own indentation.
 *
 * Indented lines are content *inside* the block's last construct (a fenced code
 * block or a paragraph under a list item), so they must not be mistaken for the
 * thing the next blank line has to be judged against.
 */
function lastBaseLine(lines: string[]): string | null {
  let lastNonEmpty: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (lastNonEmpty === null) lastNonEmpty = line
    if (!INDENTED_RE.test(line)) return line
  }
  return lastNonEmpty
}

/** Whether a blank-line run between `current`'s last line and `nextLine` should NOT split the block. */
function keepsBlockTogether(current: string[], nextLine: string): boolean {
  if (INDENTED_RE.test(nextLine)) return true
  const prevLine = lastBaseLine(current)
  if (prevLine === null) return false
  if (LIST_ITEM_RE.test(prevLine) && LIST_ITEM_RE.test(nextLine)) return true
  if (BLOCKQUOTE_RE.test(prevLine) && BLOCKQUOTE_RE.test(nextLine)) return true
  return false
}

/**
 * Whether the message carries a construct that may not be split from the rest of
 * the document. Lines inside a code fence are literal text, so a `<div>` or a
 * `[ref]:` in a code sample does not cost the message its memoization.
 */
function requiresWholeText(lines: string[]): boolean {
  let fence: string | null = null
  for (const line of lines) {
    const fenceMatch = line.match(FENCE)
    if (fence !== null) {
      if (fenceMatch && closesFence(fence, fenceMatch[1])) fence = null
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      continue
    }
    if (WHOLE_TEXT_LINE.some((re) => re.test(line))) return true
  }
  return false
}

export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split('\n')
  const kept = trimBlankLines(lines)
  if (kept.length === 0) return []
  if (requiresWholeText(kept)) return [kept.join('\n')]

  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null
  // An indented fence sits inside the list item above it: opening it must not end
  // that block, and closing it must not either — the list can go on after the code.
  let fenceContinuesBlock = false

  const closeBlock = () => {
    const block = trimBlankLines(current)
    if (block.length > 0) blocks.push(block.join('\n'))
    current = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE)

    if (fence === null && fenceMatch) {
      // The indentation rule is checked first: an indented fence is part of the
      // block above it, so it never starts one of its own.
      fenceContinuesBlock = current.length > 0 && INDENTED_RE.test(line)
      // A fence at the base indentation starts a block, so the paragraph before it stays separate.
      if (!fenceContinuesBlock) closeBlock()
      fence = fenceMatch[1]
      current.push(line)
      i++
      continue
    }

    if (fence !== null) {
      current.push(line)
      if (fenceMatch && closesFence(fence, fenceMatch[1])) {
        fence = null
        if (!fenceContinuesBlock) closeBlock()
        fenceContinuesBlock = false
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
