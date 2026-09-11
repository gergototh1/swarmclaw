/**
 * Who may write where. One rule, one file, one table-driven test.
 *
 * This module has no side effects and knows nothing about the filesystem: it
 * does not check that a path is inside the root -- `vault.abs()` does that --
 * it only states the rule. Keeping the two apart means a change to the rule
 * cannot accidentally weaken containment, and a change to containment cannot
 * accidentally widen the rule.
 *
 * An actor is `{ kind: 'user' }`, `{ kind: 'agent', slug }` or
 * `{ kind: 'ext', name }`. The caller's identity always comes from the host --
 * the session for a tool call, the extension id for a contract call -- and
 * never from a tool argument. If an agent could name itself, it could name
 * someone else.
 */

const AGENTS_ROOT = 'agents'
const TEMPLATES_FOLDER = '_templates'
const INTERNAL_FOLDER = '.swarmdocs'

/**
 * A folder name for an agent: lower case, unaccented, dash separated.
 *
 * The fold is NFD plus dropping the combining marks, which turns 'ő' into 'o'
 * and 'ű' into 'u' the same way the search tokenizer does, so a folder name and
 * a search for it agree.
 *
 * The id is not decoration. A name that leaves nothing behind -- empty, or all
 * punctuation -- would otherwise produce an empty slug and a folder path of
 * 'agents//', so the first six characters of the id stand in. Two agents whose
 * names fold to the same slug are a collision this does not resolve; the
 * indexer stores the mapping rather than recomputing it, so the first one to
 * claim a folder keeps it.
 */
export function agentSlug(name, id) {
  const folded = String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (folded !== '') return folded
  return String(id ?? '').slice(0, 6) || 'unknown'
}

/** How this actor is recorded in a document's `owner` field. */
export function ownerOf(actor) {
  if (actor?.kind === 'agent') return `agent:${actor.slug}`
  if (actor?.kind === 'ext') return `ext:${actor.name}`
  return 'user'
}

/** The folder this actor writes into by default, or null for the operator. */
export function homeFolderOf(actor) {
  if (actor?.kind === 'agent') return `${AGENTS_ROOT}/${actor.slug}`
  if (actor?.kind === 'ext') return `${AGENTS_ROOT}/${actor.name}`
  return null
}

/**
 * True when `relPath` is inside `folder`.
 *
 * The trailing slash is the whole point: `'agents/marketing-2/a.md'
 * .startsWith('agents/marketing')` is true and would hand one agent another
 * agent's folder. Comparing against `'agents/marketing/'` does not. The folder
 * path itself is deliberately not "inside" itself -- a folder is not a file
 * anyone writes to.
 */
function isInside(relPath, folder) {
  return relPath.startsWith(`${folder}/`)
}

/** Everyone reads everything. Siloed knowledge was the thing to avoid. */
export function canRead() {
  return true
}

export function canWrite(actor, relPath, { sharedFolderName = 'shared' } = {}) {
  if (typeof relPath !== 'string' || relPath === '') return false
  // The trash is reachable only through the delete and restore operations, so
  // that a document cannot be edited into or out of it by path.
  if (relPath === INTERNAL_FOLDER || isInside(relPath, INTERNAL_FOLDER)) return false

  if (actor?.kind === 'user') return true

  const home = homeFolderOf(actor)
  if (!home) return false
  if (isInside(relPath, home)) return true
  if (isInside(relPath, sharedFolderName)) return true
  // Templates are the operator's to curate; an agent reads them and starts
  // documents from them, but does not rewrite them under everyone else.
  return false
}

export { TEMPLATES_FOLDER, INTERNAL_FOLDER, AGENTS_ROOT }
