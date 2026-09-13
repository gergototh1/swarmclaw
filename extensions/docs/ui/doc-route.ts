/**
 * The open doc's place in the URL: `/x/docs/<docId>`.
 *
 * Kept in the URL rather than in component state, so a reload, a bookmark, the
 * back button or a tab reopens the same doc.
 *
 * `?doc=<id>` is the older form of the same link. It is still read, so links
 * made before the change keep working.
 */

export function docIdFromSubPath(subPath: string): string | null {
  const segment = subPath.split('/').filter(Boolean)[0]
  if (!segment) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function subPathForDoc(id: string | null): string {
  return id ? encodeURIComponent(id) : ''
}

export function legacyDocIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('doc')?.trim()
  return value ? value : null
}
