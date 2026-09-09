import fs from 'fs'

import { extractOfficeText, isOfficeDocument } from './office-text'

/**
 * One answer to "what does this attached file say", for every caller that asks.
 *
 * Four places built this independently -- the LangChain path in
 * `stream-agent-chat.ts` and the openai, anthropic and ollama providers -- and
 * they had drifted: only two of them parsed PDFs, anthropic read a PDF as UTF-8
 * text (a binary container, so what reached the model was mojibake), and all
 * four ended at `[Attached file: name]` for anything else, which is how a .docx
 * arrived as a filename with nothing behind it.
 *
 * Images are deliberately NOT handled here. A provider that can take an image
 * sends bytes, one that cannot has nothing useful to say about them, and the
 * two shapes have no common answer -- so each caller keeps its own image branch
 * and asks this only about the rest.
 */

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i

export const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html|htm|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|swift|rb|php|c|cpp|h|hpp|cs|yml|yaml|toml|ini|cfg|conf|env|log|sh|bash|zsh|sql|css|scss|less|vue|svelte|gradle|properties|srt|vtt)$/i

/** The ceiling one attachment may take of the context window. */
export const ATTACHMENT_MAX_CHARS = 100_000

function truncate(text: string): string {
  return text.length > ATTACHMENT_MAX_CHARS
    ? text.slice(0, ATTACHMENT_MAX_CHARS) + '\n\n[... truncated]'
    : text
}

function basename(filePath: string): string {
  return filePath.split('/').pop() || 'file'
}

async function pdfText(filePath: string, name: string): Promise<string> {
  try {
    const mod = await import(/* webpackIgnore: true */ 'pdf-parse') as unknown as {
      default: (input: Buffer) => Promise<{ text?: string; numpages: number }>
    }
    const result = await mod.default(fs.readFileSync(filePath))
    const text = (result.text || '').trim()
    if (!text) return `[Attached PDF: ${name} — no extractable text]`
    return `[Attached PDF: ${name} (${result.numpages} pages)]\n\n${truncate(text)}`
  } catch {
    return `[Attached PDF: ${name} — could not extract text]`
  }
}

function officeText(filePath: string, name: string): string {
  const extracted = extractOfficeText(filePath)
  // Null means the reader declined -- not a zip, ZIP64, encrypted. Naming the
  // file is the same answer every unknown format got before, and it is honest:
  // the agent is told the file is attached and that nothing was read from it.
  if (!extracted) return `[Attached file: ${name} — could not extract text]`
  const text = extracted.text.trim()
  if (!text) return `[Attached ${extracted.kind}: ${name} — no extractable text]`
  if (extracted.kind === 'xlsx') {
    // Say what this is. The strings are recoverable from a workbook, their row
    // and column are not, and a bare list presented as a table would be read as
    // one.
    return `[Attached spreadsheet: ${name} — the workbook's text, without its rows and columns]\n\n${truncate(text)}`
  }
  const label = extracted.kind === 'docx' ? 'Word document' : 'presentation'
  return `[Attached ${label}: ${name}]\n\n${truncate(text)}`
}

/**
 * The text of one non-image attachment, or a line naming it when there is none.
 *
 * Never throws and never returns null: a caller that has decided to mention an
 * attachment should always have something to say about it.
 */
export async function describeAttachment(filePath: string): Promise<string> {
  const name = basename(filePath)
  if (!fs.existsSync(filePath)) return `[Attached file: ${name} — not found]`
  /*
   * An image gets a line naming its PATH.
   *
   * This function answers for callers that can only send text, and every one of
   * them is a CLI that can open a file itself -- so the path is the useful
   * thing to hand it. Callers that CAN send bytes never ask about images: they
   * branch on the extension first and build an image part instead.
   */
  if (IMAGE_EXTENSIONS.test(filePath)) return `[Attached image: ${name} at ${filePath}]`
  if (/\.pdf$/i.test(filePath)) return pdfText(filePath, name)
  if (isOfficeDocument(filePath)) return officeText(filePath, name)
  if (TEXT_EXTENSIONS.test(filePath)) {
    try {
      return `[Attached file: ${name}]\n\n${truncate(fs.readFileSync(filePath, 'utf-8'))}`
    } catch {
      return `[Attached file: ${name} — read error]`
    }
  }
  // An unknown format still gets its PATH, not just its name: every CLI
  // provider can open a file itself, and a bare name gives it nothing to open.
  return `[Attached file: ${name} at ${filePath} — open it if you need its contents]`
}

/**
 * The block a prompt-only provider puts in front of the user's message.
 *
 * CLI providers take one string and no attachment channel, so this is the only
 * way a file reaches them. They can also open paths themselves, which is why
 * the unknown-format line above carries one.
 */
export async function buildAttachmentPreamble(filePaths: string[]): Promise<string> {
  const seen: string[] = []
  for (const p of filePaths) {
    if (p && !seen.includes(p)) seen.push(p)
  }
  if (!seen.length) return ''
  const blocks: string[] = []
  for (const p of seen) blocks.push(await describeAttachment(p))
  return blocks.join('\n\n')
}
