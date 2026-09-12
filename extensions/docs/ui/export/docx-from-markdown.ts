import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx'
import { marked, type Token, type Tokens } from 'marked'

import { withTitleHeading } from './title-heading'

/**
 * Markdown to a Word document, through marked's tokens.
 *
 * Not through HTML: a token already says "heading, depth 2" or "ordered list
 * item, level 1", which is exactly what a Word paragraph needs, where HTML
 * would have to be parsed back into the same facts. What Word has no plain
 * equivalent for degrades to text: a wiki link becomes its title, an image its
 * alt text, raw HTML its text content.
 */

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
] as const

const MONO = 'Menlo'
const ORDERED = 'ordered'

interface RunStyle {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  code?: boolean
}

interface BlockContext {
  listLevel: number
  quote: boolean
  nextListInstance: { value: number }
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
}

function run(text: string, style: RunStyle): TextRun {
  return new TextRun({
    text: decode(text),
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    ...(style.code ? { font: MONO } : {}),
  })
}

function inlineRuns(tokens: Token[] | undefined, style: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = []
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        out.push(...inlineRuns((token as Tokens.Strong).tokens, { ...style, bold: true }))
        break
      case 'em':
        out.push(...inlineRuns((token as Tokens.Em).tokens, { ...style, italics: true }))
        break
      case 'del':
        out.push(...inlineRuns((token as Tokens.Del).tokens, { ...style, strike: true }))
        break
      case 'codespan':
        out.push(run((token as Tokens.Codespan).text, { ...style, code: true }))
        break
      case 'br':
        out.push(new TextRun({ break: 1 }))
        break
      case 'link': {
        const link = token as Tokens.Link
        out.push(new ExternalHyperlink({
          link: link.href,
          children: [new TextRun({ text: decode(link.text), style: 'Hyperlink' })],
        }))
        break
      }
      case 'image':
        out.push(run((token as Tokens.Image).text, { ...style, italics: true }))
        break
      case 'html':
        out.push(run((token as Tokens.HTML).text.replace(/<[^>]+>/g, ''), style))
        break
      default: {
        const withChildren = token as { tokens?: Token[]; text?: string }
        if (withChildren.tokens?.length) out.push(...inlineRuns(withChildren.tokens, style))
        else if (typeof withChildren.text === 'string') out.push(run(withChildren.text, style))
      }
    }
  }
  return out
}

const QUOTE = {
  indent: { left: 720 },
  border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 8 } },
}

function listItemParagraphs(item: Tokens.ListItem, ordered: boolean, instance: number, ctx: BlockContext): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = []
  const marker = ordered
    ? { numbering: { reference: ORDERED, level: ctx.listLevel, instance } }
    : { bullet: { level: ctx.listLevel } }
  const prefix = item.task ? (item.checked ? '☑ ' : '☐ ') : ''
  for (const sub of item.tokens) {
    if (sub.type === 'list') {
      out.push(...blocks([sub], { ...ctx, listLevel: Math.min(ctx.listLevel + 1, 5) }))
    } else if (sub.type === 'text' || sub.type === 'paragraph') {
      const inner = (sub as Tokens.Text | Tokens.Paragraph).tokens ?? [sub]
      out.push(new Paragraph({ ...marker, children: [...(prefix ? [new TextRun(prefix)] : []), ...inlineRuns(inner)] }))
    } else if (sub.type !== 'space') {
      out.push(...blocks([sub], ctx))
    }
  }
  return out
}

function blocks(tokens: Token[], ctx: BlockContext): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = []
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading
        out.push(new Paragraph({ heading: HEADINGS[Math.min(heading.depth, 6) - 1], children: inlineRuns(heading.tokens) }))
        break
      }
      case 'paragraph':
        out.push(new Paragraph({ ...(ctx.quote ? QUOTE : {}), children: inlineRuns((token as Tokens.Paragraph).tokens) }))
        break
      case 'list': {
        const list = token as Tokens.List
        const instance = list.ordered ? ctx.nextListInstance.value++ : 0
        for (const item of list.items) out.push(...listItemParagraphs(item, list.ordered, instance, ctx))
        break
      }
      case 'blockquote':
        out.push(...blocks((token as Tokens.Blockquote).tokens, { ...ctx, quote: true }))
        break
      case 'code':
        for (const line of (token as Tokens.Code).text.split('\n')) {
          out.push(new Paragraph({
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
            children: [new TextRun({ text: line, font: MONO, size: 20 })],
          }))
        }
        break
      case 'table': {
        const table = token as Tokens.Table
        const cell = (c: Tokens.TableCell, bold: boolean) => new TableCell({
          children: [new Paragraph({ children: inlineRuns(c.tokens, { bold }) })],
        })
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: table.header.map((c) => cell(c, true)) }),
            ...table.rows.map((row) => new TableRow({ children: row.map((c) => cell(c, false)) })),
          ],
        }))
        break
      }
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } }, children: [] }))
        break
      case 'html': {
        const text = (token as Tokens.HTML).text.replace(/<[^>]+>/g, '').trim()
        if (text) out.push(new Paragraph({ children: [run(text, {})] }))
        break
      }
      default:
        break
    }
  }
  return out
}

const NUMBERING = {
  config: [{
    reference: ORDERED,
    levels: Array.from({ length: 6 }, (_, level) => ({
      level,
      format: LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    })),
  }],
}

export function buildDocxDocument(md: string, title: string): Document {
  const source = withTitleHeading(md, title).replace(/\[\[([^\]\n]+)\]\]/g, '$1')
  const tokens = marked.lexer(source, { gfm: true })
  return new Document({
    title,
    creator: 'SwarmClaw Docs',
    numbering: NUMBERING,
    sections: [{ children: blocks(tokens, { listLevel: 0, quote: false, nextListInstance: { value: 1 } }) }],
  })
}

export function markdownToDocx(md: string, title: string): Promise<Blob> {
  return Packer.toBlob(buildDocxDocument(md, title))
}
