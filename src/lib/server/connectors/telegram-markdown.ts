/**
 * Markdown to Telegram HTML.
 *
 * Telegram's HTML parse mode understands a short list of inline tags and
 * nothing else: no headings, no tables, no nested block structure. Agent
 * replies are written in ordinary Markdown, so without a conversion step every
 * asterisk and backtick reaches the chat verbatim.
 *
 * The mapping is deliberately lossy where Telegram has no equivalent. Headings
 * become bold lines and tables become a monospace block with padded columns,
 * because a readable approximation beats raw pipe characters.
 *
 * Only these tags are ever produced, matching what the Bot API accepts:
 * b, i, s, a, code, pre, blockquote.
 */

/** Placeholders for extracted spans, chosen so no real message can contain them. */
const BLOCK_MARK = String.fromCharCode(1)
const INLINE_MARK = String.fromCharCode(2)

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableDivider(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-')
}

/** Cells with inline emphasis stripped — the monospace block cannot render it. */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim().replace(/\*\*|__|\*|_/g, ''))
}

function renderTable(rows: string[][]): string {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const widths: number[] = []
  for (let column = 0; column < columnCount; column += 1) {
    widths.push(rows.reduce((max, row) => Math.max(max, (row[column] ?? '').length), 0))
  }

  const lines: string[] = []
  rows.forEach((row, index) => {
    const cells = widths.map((width, column) => {
      const value = row[column] ?? ''
      return column === widths.length - 1 ? value : value.padEnd(width)
    })
    lines.push(cells.join('  ').replace(/\s+$/, ''))
    if (index === 0) lines.push(widths.map((width) => '-'.repeat(width)).join('  '))
  })
  return lines.join('\n')
}

/**
 * Converts Markdown to the HTML subset Telegram accepts.
 *
 * Code spans are lifted out first so their contents survive untouched, then the
 * remaining text is escaped and the inline syntax is translated.
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return ''

  const blocks: string[] = []
  const inlines: string[] = []

  let text = markdown.replace(/\r\n/g, '\n')

  text = text.replace(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*\n([\s\S]*?)```/g, (_match, body: string) => {
    blocks.push(body.replace(/\n$/, ''))
    return `${BLOCK_MARK}${blocks.length - 1}${BLOCK_MARK}`
  })

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlines.push(code)
    return `${INLINE_MARK}${inlines.length - 1}${INLINE_MARK}`
  })

  const lines = text.split('\n')
  const collected: string[] = []
  let index = 0
  while (index < lines.length) {
    if (isTableRow(lines[index]) && isTableDivider(lines[index + 1] ?? '')) {
      const rows = [splitTableRow(lines[index])]
      index += 2
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      blocks.push(renderTable(rows))
      collected.push(`${BLOCK_MARK}${blocks.length - 1}${BLOCK_MARK}`)
      continue
    }
    collected.push(lines[index])
    index += 1
  }
  text = collected.join('\n')

  text = escapeHtml(text)
  text = text.replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '———')
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '<b>$1</b>')
  text = text.replace(/^[ \t]{0,3}&gt;[ \t]?(.*)$/gm, '<blockquote>$1</blockquote>')
  text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  text = text.replace(/\*\*\*([^\s*][\s\S]*?)\*\*\*/g, '<b><i>$1</i></b>')
  text = text.replace(/\*\*([^\s*][\s\S]*?)\*\*/g, '<b>$1</b>')
  text = text.replace(/__([^\s_][\s\S]*?)__/g, '<b>$1</b>')
  text = text.replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=$|[\s.,;:!?)])/gm, '$1<i>$2</i>')
  text = text.replace(/(^|[\s(])_([^\s_][^_\n]*?)_(?=$|[\s.,;:!?)])/gm, '$1<i>$2</i>')
  text = text.replace(/~~([^\s~][\s\S]*?)~~/g, '<s>$1</s>')
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')

  text = text.replace(
    new RegExp(`${INLINE_MARK}(\\d+)${INLINE_MARK}`, 'g'),
    (_match, key: string) => `<code>${escapeHtml(inlines[Number(key)])}</code>`,
  )
  text = text.replace(
    new RegExp(`${BLOCK_MARK}(\\d+)${BLOCK_MARK}`, 'g'),
    (_match, key: string) => `<pre>${escapeHtml(blocks[Number(key)])}</pre>`,
  )

  return text
}

/**
 * True when conversion produced markup worth sending as HTML.
 *
 * Plain prose converts to itself. Sending it with `parse_mode` set would add a
 * way for the message to fail for no gain, so the caller skips HTML for it.
 */
export function hasTelegramMarkup(markdown: string, html: string): boolean {
  return html !== markdown
}
