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
 * the shapes it is checked against — `markdown-blocks-render.test.ts` asserts it
 * with the app's own react-markdown pipeline over the constructs an agent answer
 * actually produces.
 *
 * How it holds:
 *  - A blank line ends a block, except where markdown treats both sides as one
 *    unit: the next line is indented by 2+ columns, a tab counting as one (a
 *    continuation paragraph, nested list or code fence inside a list item), the
 *    block and the next line are both list items (a loose list must stay one
 *    list), or both are block quotes. A list item's text may also run on to the
 *    next line with no indentation at all, so the "is the block a list item?"
 *    side of that test looks past such lazy continuations.
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
const HEADING_RE = /^\s{0,3}#{1,6}(?:\s|$)/
const THEMATIC_BREAK_RE = /^\s{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
// A tab indents to the next 4-column stop, so it indents at least as far as the
// two spaces this rule asks for — and `FENCE` already accepted one, which is how
// a tab-indented fence used to escape the list item it belongs to.
const INDENTED_RE = /^(?: {0,3}\t| {2,})\S/
/** A block quote's `>` markers, so a line inside one can be judged on what follows them. */
const BLOCKQUOTE_PREFIX_RE = /^(?:\s{0,3}>\s?)+/

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

/** Whether a base line opens a construct of its own, rather than continuing the line above it. */
function opensBlock(line: string): boolean {
  return LIST_ITEM_RE.test(line)
    || BLOCKQUOTE_RE.test(line)
    || FENCE.test(line)
    || HEADING_RE.test(line)
    || THEMATIC_BREAK_RE.test(line)
}

/**
 * The base line that opened the block's last construct, looking past lazy continuations.
 *
 * A list item's text may run on to the next line with no indentation at all
 * (`- item one` / `continued lazily`), and that line is still inside the item —
 * the list is still open. `lastBaseLine` would hand back the continuation, which
 * is not a list item, and the loose list would be split into two tight ones.
 * Stop at the first line that opens something: past a heading, a block quote, a
 * fence or a thematic break the list really has ended.
 */
function lastBlockStartLine(lines: string[]): string | null {
  let lastNonEmpty: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (lastNonEmpty === null) lastNonEmpty = line
    if (INDENTED_RE.test(line)) continue
    if (opensBlock(line)) return line
  }
  return lastNonEmpty
}

/** Whether a blank-line run between `current`'s last line and `nextLine` should NOT split the block. */
function keepsBlockTogether(current: string[], nextLine: string): boolean {
  if (INDENTED_RE.test(nextLine)) return true
  const prevLine = lastBaseLine(current)
  if (prevLine === null) return false
  if (BLOCKQUOTE_RE.test(prevLine) && BLOCKQUOTE_RE.test(nextLine)) return true
  if (!LIST_ITEM_RE.test(nextLine)) return false
  const listStart = lastBlockStartLine(current)
  return listStart !== null && LIST_ITEM_RE.test(listStart)
}

/**
 * Whether the message carries a construct that may not be split from the rest of
 * the document. Lines inside a code fence are literal text, so a `<div>` or a
 * `[ref]:` in a code sample does not cost the message its memoization. A
 * definition inside a block quote still binds document-wide, so the `>` markers
 * are stripped before the line is judged.
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
    const bare = line.replace(BLOCKQUOTE_PREFIX_RE, '')
    if (WHOLE_TEXT_LINE.some((re) => re.test(bare))) return true
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
  while (i < kept.length) {
    const line = kept[i]
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
      while (j < kept.length && kept[j].trim() === '') j++
      if (j >= kept.length) {
        // Trailing blank lines: nothing left to decide.
        i = j
        continue
      }
      const nextLine = kept[j]
      if (current.length > 0 && keepsBlockTogether(current, nextLine)) {
        // Keep the blank-line run itself — it's part of the block's markdown.
        for (let k = i; k < j; k++) current.push(kept[k])
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
