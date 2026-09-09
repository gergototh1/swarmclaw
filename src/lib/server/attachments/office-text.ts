import fs from 'fs'
import zlib from 'zlib'

/**
 * Plain text out of the Office formats an operator actually attaches.
 *
 * .docx, .xlsx and .pptx are not binary blobs: each one is a ZIP archive of XML
 * parts, so one reader covers all three. That is why this is written against
 * the container rather than as three format libraries -- and why it uses Node's
 * own `zlib` instead of adding a dependency for a job this size.
 *
 * WITHOUT THIS, A .docx REACHES THE MODEL AS ITS FILENAME AND NOTHING ELSE.
 * The attachment paths all end in the same fallback -- `[Attached file: name]`
 * -- for anything that is not an image, a PDF, or one of the known text
 * extensions, so the file appeared to be attached, the agent could see it was
 * attached, and there was no content behind it.
 *
 * The reader is deliberately narrow. It reads the central directory, and it
 * understands stored (method 0) and deflate (method 8), which is what Word,
 * Excel and PowerPoint write. Anything else -- ZIP64, an encrypted archive, a
 * spanned archive, a file that is not a ZIP at all -- makes it return null, and
 * the caller falls back to naming the file. It never throws.
 */

/** One entry of a ZIP central directory, reduced to what reading it needs. */
interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * The end-of-central-directory record, which is the only fixed point in a ZIP.
 *
 * It sits at the very end unless the archive carries a comment, so the search
 * runs backwards over the last 64KB -- the most a comment can be.
 */
function findEndOfCentralDirectory(buf: Buffer): number | null {
  const start = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return null
}

function readCentralDirectory(buf: Buffer): ZipEntry[] | null {
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd === null) return null
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  // 0xffffffff in the offset is the ZIP64 marker. The real offset lives in a
  // separate record this reader does not parse, so it declines rather than
  // seeking to a nonsense position.
  if (offset === 0xffffffff) return null

  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length) return null
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return null
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localHeaderOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, method, compressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * One entry's bytes.
 *
 * The local header repeats the name and extra-field lengths, and they are NOT
 * always the same as the central directory's -- the extra field in particular
 * differs between the two in archives Word writes. The data offset is therefore
 * computed from the local header, never from the central one.
 */
function readEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  const at = entry.localHeaderOffset
  if (at + 30 > buf.length) return null
  if (buf.readUInt32LE(at) !== LOCAL_SIGNATURE) return null
  const nameLength = buf.readUInt16LE(at + 26)
  const extraLength = buf.readUInt16LE(at + 28)
  const dataStart = at + 30 + nameLength + extraLength
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) {
    try { return zlib.inflateRawSync(data) } catch { return null }
  }
  return null
}

/** XML's five predefined entities, plus the numeric forms Word emits. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last: doing it first would turn `&amp;lt;` into a `<`.
    .replace(/&amp;/g, '&')
}

/**
 * The text of one OOXML part.
 *
 * Only the runs are taken -- `<w:t>` in Word, `<a:t>` in PowerPoint, `<t>` in
 * Excel's shared strings. Stripping every tag instead would also pull in the
 * document's style and numbering ids, which are XML attributes' worth of noise
 * that reads as content.
 */
function runsToText(xml: string, runTag: string): string {
  const out: string[] = []
  const runPattern = new RegExp(`<${runTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${runTag}>`, 'g')
  for (const match of xml.matchAll(runPattern)) out.push(decodeEntities(match[1]))
  return out.join('')
}

/**
 * Word keeps paragraphs in `<w:p>`; without splitting on them the whole
 * document is one line.
 *
 * Runs, tabs and breaks are matched by ONE pattern so they stay in document
 * order. Replacing `<w:tab/>` with a literal tab first and then pulling the
 * `<w:t>` runs out was the first attempt, and it dropped every tab and break:
 * the replacement text lands between the run elements, which the run scan then
 * steps over.
 */
function docxText(xml: string): string {
  const paragraphs: string[] = []
  const piece = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g
  for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    let out = ''
    for (const part of match[1].matchAll(piece)) {
      if (part[1] !== undefined) out += decodeEntities(part[1])
      else if (part[0].startsWith('<w:tab')) out += '\t'
      else out += '\n'
    }
    paragraphs.push(out)
  }
  return paragraphs.join('\n')
}

function pptxText(entries: ZipEntry[], buf: Buffer): string {
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const n = (s: string) => Number(s.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      return n(a.name) - n(b.name)
    })
  const out: string[] = []
  for (const slide of slides) {
    const data = readEntry(buf, slide)
    if (!data) continue
    const text = runsToText(data.toString('utf8'), 'a:t')
    if (text.trim()) out.push(text)
  }
  return out.join('\n\n')
}

/**
 * Excel's strings, not its grid.
 *
 * A worksheet stores cell VALUES as indexes into `sharedStrings.xml`, so the
 * strings are recoverable but their row and column are not without reading the
 * sheet's cell references too. This returns the strings and the caller says so
 * in the label: a list of the workbook's text is honest, a fake table is not.
 */
function xlsxText(entries: ZipEntry[], buf: Buffer): string {
  const shared = entries.find((e) => e.name === 'xl/sharedStrings.xml')
  if (!shared) return ''
  const data = readEntry(buf, shared)
  if (!data) return ''
  const xml = data.toString('utf8')
  const cells: string[] = []
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    const text = runsToText(match[1], 't')
    if (text.trim()) cells.push(text)
  }
  return cells.join('\n')
}

export interface OfficeText {
  /** What the file is, for the label the caller writes. */
  kind: 'docx' | 'xlsx' | 'pptx'
  text: string
}

/** True for the three extensions this module reads. */
export function isOfficeDocument(filePath: string): boolean {
  return /\.(docx|xlsx|pptx)$/i.test(filePath)
}

/**
 * Text out of an Office file, or null when this reader cannot answer.
 *
 * Null is not an error state to report as one: the caller names the file
 * instead, which is what it did for every unknown format before.
 */
export function extractOfficeText(filePath: string): OfficeText | null {
  if (!isOfficeDocument(filePath)) return null
  let buf: Buffer
  try { buf = fs.readFileSync(filePath) } catch { return null }

  const entries = readCentralDirectory(buf)
  if (!entries) return null

  const ext = filePath.split('.').pop()?.toLowerCase()
  if (ext === 'docx') {
    const part = entries.find((e) => e.name === 'word/document.xml')
    if (!part) return null
    const data = readEntry(buf, part)
    if (!data) return null
    return { kind: 'docx', text: docxText(data.toString('utf8')) }
  }
  if (ext === 'pptx') return { kind: 'pptx', text: pptxText(entries, buf) }
  if (ext === 'xlsx') return { kind: 'xlsx', text: xlsxText(entries, buf) }
  return null
}
