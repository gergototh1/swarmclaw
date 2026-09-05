/**
 * The one gate between a stored url and an `href`.
 *
 * Every url this page can reach an `href` with was written by a stranger: a
 * video's source text is a newsletter item or a forum post, carried through
 * `forras_szoveg` byte for byte, and the third paragraph of that text is where
 * `videoOpen` puts the source url. Only `http:` and `https:` may become a link
 * target; `javascript:`, `data:`, `vbscript:`, `file:`, a scheme-relative
 * `//host` and anything else come back as `null`, and the caller shows the
 * text as text instead. The test in test/safe-href.test.mjs pins the refusals
 * by example.
 *
 * Trimmed before the check because a leading space is how a `javascript:` url
 * used to slip past a naive prefix test in browsers that strip it, and because
 * a trailing newline in a pasted link is common and harmless.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}
