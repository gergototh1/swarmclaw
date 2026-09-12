const REFUSED = '\\/:*?"<>|'

/** A download name from a doc title: characters a file system refuses dropped, never empty. */
export function exportFileName(title: string, ext: 'docx' | 'pdf'): string {
  const kept = [...title].filter((c) => c.charCodeAt(0) >= 32 && !REFUSED.includes(c)).join('')
  const base = kept.replace(/\s+/g, ' ').trim().slice(0, 120)
  return `${base || 'doc'}.${ext}`
}
