/**
 * The checks on a "save this HTML as PDF" request, apart from the Electron
 * glue in `pdf-save.ts` so they can be tested without an Electron runtime.
 * The request comes from a renderer, so the main process reads it as untrusted.
 */
export const MAX_PDF_HTML_BYTES = 20 * 1024 * 1024

export interface SavePdfInput {
  html: string
  fileName: string
}

export function readSavePdfInput(raw: unknown): SavePdfInput | null {
  if (!raw || typeof raw !== 'object') return null
  const { html, fileName } = raw as Record<string, unknown>
  if (typeof html !== 'string' || html === '' || Buffer.byteLength(html, 'utf8') > MAX_PDF_HTML_BYTES) return null
  return { html, fileName: typeof fileName === 'string' ? fileName : '' }
}

const REFUSED = '\\/:*?"<>|'

export function safePdfFileName(name: string): string {
  const kept = [...name].filter((c) => c.charCodeAt(0) >= 32 && !REFUSED.includes(c)).join('')
  const base = kept.replace(/\s+/g, ' ').trim().replace(/\.pdf$/i, '').slice(0, 120)
  return `${base || 'document'}.pdf`
}
