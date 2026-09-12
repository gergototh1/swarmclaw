import { mdToHtml } from '../markdown'
import { withTitleHeading } from './title-heading'

/**
 * The standalone page a PDF is printed from. The markdown goes through the
 * editor's own `mdToHtml`, which escapes raw HTML before rendering, so what
 * the doc says is what the PDF shows -- never markup the doc smuggled in.
 */
const PRINT_CSS = `
@page { size: A4; margin: 18mm 16mm; }
body { font: 11pt/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 10pt; }
h2 { font-size: 15pt; margin: 16pt 0 6pt; }
h3 { font-size: 12.5pt; margin: 12pt 0 4pt; }
p, ul, ol, blockquote, pre, table { margin: 0 0 8pt; }
code, pre { font-family: Menlo, Consolas, monospace; font-size: 9.5pt; }
pre { background: #f3f4f6; padding: 8pt; white-space: pre-wrap; }
blockquote { border-left: 3px solid #ccc; padding-left: 10pt; color: #444; margin-left: 0; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
img { max-width: 100%; }
a, .docs-link { color: inherit; }
`

function escapeText(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

export function buildPrintHtml(md: string, title: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${escapeText(title)}</title>`,
    `<style>${PRINT_CSS}</style>`,
    '</head><body><article>',
    mdToHtml(withTitleHeading(md, title)),
    '</article></body></html>',
  ].join('')
}
