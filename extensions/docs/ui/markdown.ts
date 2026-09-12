import { marked } from 'marked'
import TurndownService from 'turndown'

/**
 * Markdown in, HTML out, and back again.
 *
 * The editor works in HTML because that is what ProseMirror understands; the
 * file is markdown because that is the whole premise of the module. So every
 * load converts one way and every save converts back, and the risk that
 * introduces is a round trip that is not faithful -- a document that changes
 * because it was opened.
 *
 * Two things keep that in check. The converters are configured to agree on the
 * spellings they use (ATX headings, dashes for bullets, fenced code), so a
 * document written by this editor survives a round trip byte for byte. And a
 * document written elsewhere is only ever rewritten when the operator actually
 * edits it: opening one and closing it again writes nothing, because the page
 * only saves on a real change.
 */

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
})

/**
 * Wiki links survive the round trip as plain text.
 *
 * Without this rule Turndown escapes the brackets -- `\[\[Target\]\]` -- and the
 * link silently stops being one. The rule matches the text node produced for a
 * link that was never turned into an anchor, and hands the brackets back.
 */
/**
 * Both rules read the DOM through `getAttribute` and `querySelectorAll` only.
 *
 * Turndown runs on a real DOM in the browser and on `domino` under Node, and
 * domino implements the core interfaces but not the convenience properties:
 * `element.dataset` and `table.rows` are both absent there. Written against
 * those, these rules worked in the page and threw in the test suite -- which is
 * the wrong way round for a bug to be found.
 */
turndown.addRule('wikilink', {
  filter: (node) => node.nodeName === 'SPAN'
    && (node as Element).getAttribute?.('data-wikilink') === 'true',
  // The node's own text, not Turndown's `content`: by the time content is
  // handed over, an underscore or an asterisk inside the title has been
  // backslash-escaped for markdown, and `[[doc\_a1b2]]` is no longer the link
  // it started as.
  replacement: (_content, node) => `[[${(node as Element).textContent ?? ''}]]`,
})

/**
 * Collects descendants by tag name using `childNodes` alone.
 *
 * Neither `querySelectorAll` nor `rows` can be relied on: the node Turndown
 * hands a rule is a plain DOM node under `domino`, which implements the tree
 * interfaces and little else. `childNodes` and `nodeName` are what both
 * environments certainly have.
 */
function descendants(node: Node, names: string[]): Node[] {
  const found: Node[] = []
  const walk = (current: Node) => {
    for (const child of Array.from(current.childNodes ?? [])) {
      if (names.includes(child.nodeName)) found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}

turndown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => {
    const rows = descendants(node as unknown as Node, ['TR'])
    if (rows.length === 0) return ''
    const cells = (row: Node) => descendants(row, ['TH', 'TD'])
      .map((c) => (c.textContent ?? '').trim().replace(/\|/g, '\\|'))
    const header = cells(rows[0])
    if (header.length === 0) return ''
    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...rows.slice(1).map((r) => `| ${cells(r).join(' | ')} |`),
    ]
    return `\n\n${lines.join('\n')}\n\n`
  },
})

/**
 * Escapes the four characters that could turn text into markup.
 *
 * The editor never renders raw HTML from a document: markdown goes through
 * `marked` with HTML disabled, so a document containing a `<script>` tag shows
 * the tag as text. This is what enforces that, ahead of `marked`, because a
 * disabled-HTML setting is a setting and this is not.
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
  ))
}

/** Markdown to the HTML the editor loads. */
export function mdToHtml(md: string, knownTitles: Set<string> = new Set()): string {
  const safe = escapeHtml(md)
  const html = marked.parse(safe, { async: false, gfm: true, breaks: false }) as string
  // Wiki links become spans the editor shows and Turndown converts back. The
  // class says whether the target exists, which is the only cue the operator
  // gets that a link is still dangling.
  return html.replace(/\[\[([^\]\n]+)\]\]/g, (_m, raw: string) => {
    const known = knownTitles.has(raw.trim())
    return `<span data-wikilink="true" class="docs-link${known ? '' : ' docs-link-unresolved'}">${raw}</span>`
  })
}

/** The editor's HTML back to markdown. */
export function htmlToMd(html: string): string {
  const md = turndown.turndown(html)
  return md.endsWith('\n') || md === '' ? md : `${md}\n`
}
