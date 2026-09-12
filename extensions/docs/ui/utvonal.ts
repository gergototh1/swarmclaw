/**
 * The open document's place in the URL: `/x/docs/<docId>`.
 *
 * It used to be `useState`, so leaving the page and coming back showed an
 * empty editor whatever had been open. Kept in the URL, a reload, a bookmark
 * or a tab reopens the same document.
 */

export function doksiIdAzUtbol(subPath: string): string | null {
  const szegmens = subPath.split('/').filter(Boolean)[0]
  if (!szegmens) return null
  try {
    return decodeURIComponent(szegmens)
  } catch {
    return null
  }
}

export function utADoksihoz(id: string | null): string {
  return id ? encodeURIComponent(id) : ''
}
