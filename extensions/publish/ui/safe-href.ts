/**
 * The one gate between a stored url and an `href`.
 *
 * Copied from `extensions/video/ui/safe-href.ts` -- duplicated rather than
 * shared for the same reason `src/mcp-bridge.mjs` is duplicated across every
 * sibling module: this bundle builds from its own workspace with no
 * `node_modules` reach into another extension's `ui/`.
 *
 * Every url this page can reach an `href` with came from somewhere this
 * module does not control: a platform's own upload response (`ag.url`,
 * `src/db.mjs`'s `agEredmenyetIr`) is a real API answer, not agent-written
 * text, but constraints.md's rule ("href-be csak ellenőrizve") draws no
 * exception for it -- a compromised or misbehaving adapter is exactly the
 * case this gate exists for. Only `http:` and `https:` may become a link
 * target; `javascript:`, `data:`, `vbscript:`, `file:`, a scheme-relative
 * `//host` and anything else come back as `null`, and the caller shows the
 * text as text instead.
 *
 * Trimmed before the check because a leading space is how a `javascript:` url
 * used to slip past a naive prefix test in browsers that strip it, and
 * because a trailing newline is common and harmless.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}
