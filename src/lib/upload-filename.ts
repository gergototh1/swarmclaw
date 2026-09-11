/**
 * Filenames travel from the browser to the upload routes in the `X-Filename`
 * header, and a header value may not hold a code point above U+00FF. macOS
 * stores filenames decomposed (NFD), so "Kockázati jelentés.pdf" carries a
 * U+0301 combining accent and makes `fetch` throw before the request is sent.
 * Percent-encoding the name keeps the header inside that byte range.
 */

/** Encode a filename for the `X-Filename` request header. */
export function encodeFilenameHeader(name: string): string {
  return encodeURIComponent(name.normalize('NFC'))
}

/** Read a filename back out of the `X-Filename` header. */
export function decodeFilenameHeader(raw: string | null, fallback: string): string {
  if (!raw) return fallback
  try {
    return decodeURIComponent(raw).normalize('NFC')
  } catch {
    // A client from before the encoding change sent the name raw; a stray "%"
    // makes decodeURIComponent throw, and the raw name is still the best guess.
    return raw.normalize('NFC')
  }
}

/** Turn a filename into one that is safe to write to the uploads directory. */
export function safeUploadFilename(name: string): string {
  const unaccented = name.normalize('NFD').replace(/[̀-ͯ]/g, '')
  const safe = unaccented.replace(/[^a-zA-Z0-9._-]/g, '_')
  return /[a-zA-Z0-9]/.test(safe) ? safe : 'file'
}
