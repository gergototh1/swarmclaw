/**
 * `[[wiki links]]`: finding them, resolving them, and following a rename.
 *
 * This module touches neither the filesystem nor the settings. It reads through
 * the repository and, for the rename, through two callbacks the caller
 * supplies. That is what lets the same function serve the agent tool and the
 * page without either of them leaking into it.
 */

const LINK_RE = /\[\[([^\]\n]+)\]\]/g

/**
 * The body with code blanked out, same length as the original.
 *
 * A `[[...]]` in a code example is an example, not a reference. Blanking rather
 * than deleting keeps every index the same, so a match found in the masked text
 * can be applied to the real one -- which is exactly what the rename does.
 *
 * Fences are handled before inline code because a backtick pair inside a fenced
 * block is not inline code, and an unclosed fence runs to the end of the file:
 * that is what CommonMark says, and treating the tail as code is the safer of
 * the two readings anyway.
 */
function maskCode(body) {
  const chars = [...body]
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }

  // Fenced blocks: ``` or ~~~ at the start of a line, to the matching fence or
  // the end of the file.
  const fence = /^[ \t]*(```+|~~~+)/gm
  let open = null
  let match = fence.exec(body)
  while (match !== null) {
    if (open === null) {
      open = { start: match.index, marker: match[1][0] }
    } else if (match[1][0] === open.marker) {
      blank(open.start, match.index + match[0].length)
      open = null
    }
    match = fence.exec(body)
  }
  if (open !== null) blank(open.start, body.length)

  const masked = chars.join('')

  // Inline code: a backtick run and its matching run on the same line.
  const out = [...masked]
  const inline = /(`+)([^`\n]*)\1/g
  let inlineMatch = inline.exec(masked)
  while (inlineMatch !== null) {
    for (let i = inlineMatch.index; i < inlineMatch.index + inlineMatch[0].length; i += 1) {
      if (out[i] !== '\n') out[i] = ' '
    }
    inlineMatch = inline.exec(masked)
  }
  return out.join('')
}

/** Every `[[link]]` in the body, once each, in the order they appear. */
export function extractLinks(body) {
  const masked = maskCode(String(body ?? ''))
  const seen = new Set()
  const found = []
  for (const match of masked.matchAll(LINK_RE)) {
    const raw = match[1].trim()
    if (raw === '' || seen.has(raw)) continue
    seen.add(raw)
    found.push(raw)
  }
  return found
}

/**
 * The document a link points at, or null.
 *
 * Three steps, narrowest first: an id, an exact title, then a title matched
 * with case folded. Nothing here guesses beyond that -- a link that resolves to
 * "probably this one" would be worse than one that stays visibly unresolved.
 */
export function resolveLink(repo, raw) {
  const byId = repo.getById(raw)
  if (byId && !byId.deleted_at) return byId.id
  const byTitle = repo.findByTitle(raw, { caseInsensitive: true })
  return byTitle ? byTitle.id : null
}

/** The link rows for this body, ready for `repo.setLinks`. */
export function linkRowsFor(repo, body) {
  return extractLinks(body).map((raw) => ({ toId: resolveLink(repo, raw), toRaw: raw }))
}

/**
 * Points every title link at this document's new title.
 *
 * Links written as an id are left alone: an id does not change when a title
 * does, which is the reason ids exist here at all. A referrer the caller may
 * not write is skipped and named rather than silently rewritten or silently
 * dropped -- the caller shows that list, so a partial rename is visible.
 *
 * The rewrite runs over the masked body so that an example inside a code fence
 * keeps the old title, and applies the offsets to the real body.
 */
export function renameLinksTo(repo, { docId, oldTitle, newTitle, canWrite, readBody, writeBody }) {
  const frissitett = []
  const kihagyott = []
  for (const back of repo.backlinks(docId)) {
    if (!canWrite(back.path)) {
      kihagyott.push(back.path)
      continue
    }
    const body = readBody(back.path)
    if (typeof body !== 'string') continue
    const masked = maskCode(body)
    let out = ''
    let cursor = 0
    for (const match of masked.matchAll(LINK_RE)) {
      if (match[1].trim() !== oldTitle) continue
      out += body.slice(cursor, match.index)
      out += `[[${newTitle}]]`
      cursor = match.index + match[0].length
    }
    if (cursor === 0) continue
    out += body.slice(cursor)
    writeBody(back.path, out)
    frissitett.push(back.path)
  }
  return { frissitett, kihagyott }
}
