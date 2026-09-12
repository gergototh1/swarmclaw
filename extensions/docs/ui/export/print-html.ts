import { mdToHtml } from '../markdown'
import { withTitleHeading } from './title-heading'

/**
 * The standalone page a PDF is printed from. The markdown goes through the
 * editor's own `mdToHtml`, which escapes raw HTML before rendering, so what
 * the doc says is what the PDF shows -- never markup the doc smuggled in.
 *
 * `@page { margin: 0 }` plus the page margin moved onto `body` padding is
 * deliberate: a nonzero `@page` margin is a band the browser's print dialog
 * is free to stamp its own header/footer into (page title, URL, page
 * number), which is exactly what showed up live -- `localhost:3456/x/docs
 * 6/6` baked into the exported file. Electron's own `printToPDF` adds no
 * such band by default, so giving the page itself the whitespace produces
 * the same layout there with nothing left for either renderer to draw into.
 */
const PRINT_CSS = `
@page { size: A4; margin: 0; }
body { font: 11pt/1.55 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif; color: #111; margin: 0; padding: 18mm 16mm; }
h1, h2, h3 { font-family: 'Gabarito', -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif; }
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

/**
 * Builds the print page. Pure and synchronous on purpose: the caller fetches
 * `embeddedFontsCss` (see `fetchEmbeddedFontsCss` below) ahead of time and
 * passes the result in, so this stays a plain string-in/string-out function
 * the existing tests can call with no network and no host.
 */
export function buildPrintHtml(md: string, title: string, embeddedFontsCss?: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${escapeText(title)}</title>`,
    `<style>${embeddedFontsCss ?? ''}${PRINT_CSS}</style>`,
    '</head><body><article>',
    mdToHtml(withTitleHeading(md, title)),
    '</article></body></html>',
  ].join('')
}

/** One font file, base64-encoded as a `data:` URI `@font-face` can embed. */
async function fetchFontFaceRule(path: string, unicodeRange: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(path)
  if (!res.ok) throw new Error(`docs: font fetch failed (${res.status}): ${path}`)
  const buffer = await res.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  const dataUri = `data:font/woff2;base64,${btoa(binary)}`
  // `font-display: swap` matters more here than in a normal page load: the
  // print/PDF path gives the font only a short, bounded window (see the
  // comment in `electron/pdf-save.ts`) before the page gets rasterized. Without
  // `swap`, headings sit in the font's "block" period -- invisible, not a
  // fallback glyph -- and a print/printToPDF that fires inside that window
  // captures blank headings even though the font arrives moments later.
  return `@font-face { font-family: 'Gabarito'; src: url(${dataUri}) format('woff2'); font-weight: 400 900; font-style: normal; font-display: swap; unicode-range: ${unicodeRange}; }`
}

/**
 * The heading font as an embedded `@font-face` block, fetched from the app's
 * own `/fonts/*.woff2` files (the same ones `src/app/globals.css` serves).
 *
 * A plain `url(/fonts/...)` in the print page's CSS is not reliable: the page
 * runs both inside an Electron window loaded from a `file://` temp file and
 * inside a same-origin iframe, and a relative or root-relative URL resolves
 * against whichever of those happens to be current -- wrong for the other
 * one. Fetching and inlining the bytes here sidesteps that entirely.
 *
 * Only Gabarito is fetched: the app itself has no self-hosted Inter file
 * (`public/fonts/` carries only the two Gabarito subsets), so the body text
 * relies on the plain font stack in `PRINT_CSS` -- Inter where it happens to
 * be installed (as it is on this machine), the system stack otherwise. If
 * the fetch fails for any reason (offline, a build that dropped the font
 * files), the caller gets back an empty string and `buildPrintHtml` falls
 * through to that same plain stack for headings too.
 */
export async function fetchEmbeddedFontsCss(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const [latin, latinExt] = await Promise.all([
      fetchFontFaceRule(
        '/fonts/gabarito-latin.woff2',
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
        fetchImpl,
      ),
      fetchFontFaceRule(
        '/fonts/gabarito-latin-ext.woff2',
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
        fetchImpl,
      ),
    ])
    return `${latin}\n${latinExt}`
  } catch {
    return ''
  }
}
