import { repoOf } from './sweep.mjs'

/**
 * The item queries, written once and served to both audiences.
 *
 * Two things read AI Signal's stored cards: the extension's own UI page,
 * through the `rpc` map in rpc.mjs, and another extension, through the
 * `signals` contract in contract.mjs. Both need the same two questions
 * answered -- "which cards match this filter?" and "what is this one card?" --
 * so the questions are answered here and the two entry points are thin
 * wrappers over this module. Neither of them re-implements a filter, and
 * neither can drift from the other on what a `status` means or what a limit is
 * capped at.
 *
 * They stay two entry points on purpose. A contract is a promise to code the
 * operator installed separately, and the way a promise like that quietly grows
 * is by being spelled `methods: rpc` -- after which every method the UI needs
 * next month is also a method a consumer may call, without anybody deciding
 * that. So this module exports the shared implementation and neither entry
 * point exports the other's surface: rpc.mjs lists what the page may call,
 * contract.mjs lists what a consumer may call, and adding to one adds nothing
 * to the other.
 *
 * WHAT THIS LAYER DOES TO THE STORED TEXT: NOTHING.
 * Every headline, summary and url in these rows is newsletter prose or a forum
 * post written by a stranger -- see the second rule in the headers of sweep.mjs
 * and research.mjs. It leaves here exactly as it was stored, byte for byte: not
 * escaped, not truncated, not stripped. Sanitising here would be worse than
 * useless, because it would let the caller believe the text had been cleaned
 * when only this one path had touched it, and the caller is the layer that
 * knows where the text is going -- a DOM node, a model prompt, an outbound
 * message. What this layer does guarantee is the other half: nothing stored
 * steers anything here. No row's content is read, compared, dispatched on or
 * interpolated. The filters below are built from the caller's arguments,
 * checked against closed vocabularies, and passed to the repository as bound
 * parameters; a headline could be `' OR 1=1 --` or `__proto__` and this module
 * would still only be counting rows.
 *
 * HOW AN ARGUMENT IS READ, IN ONE RULE.
 * Absent, null or blank means "no opinion" and takes the default. Anything else
 * that cannot be honoured is refused by name rather than quietly replaced --
 * the rule `resolveMax` in sweep.mjs already states for the per-run cap, and
 * the rule `decide` in db.mjs already states for the decision vocabulary
 * ("mapping it there would turn a caller's typo into a silent un-decide"). It
 * matters more here than in either, because the value being widened is a
 * filter: a caller that asks for `status: 'saevd'` and is handed every card
 * including the archived ones has been given more than it asked for, and the
 * caller most likely to do that is a module putting these cards on an outbound
 * channel.
 *
 * The single exception is a `limit` above the cap, which is capped rather than
 * refused. That one can be partly honoured and cannot mislead: `total` on the
 * result is the size of the whole match, so a page cut short at the cap is
 * still distinguishable from a match that was that small. A `limit` of zero, a
 * fractional one and a negative one buy nothing by being guessed at, so they
 * are refused with the rest.
 */

/** The complete status vocabulary `list` accepts. 'all' is the absence of a status filter. */
export const ITEM_STATUSES = Object.freeze(['all', 'new', 'saved', 'archived', 'unknown'])

/** The complete ordering vocabulary `list` accepts, spelled as the repository spells it. */
export const ITEM_ORDERS = Object.freeze(['recent', 'score'])

/** Cards per page when the caller has no opinion, and the most any caller can have on one page. */
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 500

/**
 * The longest search text a caller may send.
 *
 * A longer one is refused rather than shortened. Shortening looks harmless and
 * is not: `LIKE '%<first 200 chars>%'` matches a superset of what the full
 * string would have matched, so a truncated search answers with rows that do
 * not match the question that was asked, and says nothing about having changed
 * it.
 */
export const MAX_QUERY = 200

/**
 * A whole number the caller may or may not have an opinion about.
 *
 * Only a number or a numeric string is considered. `Number` alone would accept
 * `true` as 1 and `[5]` as 5, and a caller that sent either did not mean a
 * limit of one or five; it made a mistake this layer would then hide.
 *
 * Exported because `rpc.sweeps` reads a limit of its own against a different
 * cap. The cap belongs to the caller, the rule does not: a second copy of the
 * rule is how one limit ends up refusing what the other clamps, and how a
 * negative one ends up reaching SQLite -- where a negative LIMIT means no limit
 * at all.
 */
export function readWholeNumber(what, raw, { min, max, fallback }) {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new Error(`${what} must be a whole number of at least ${min}, not a ${Array.isArray(raw) ? 'array' : typeof raw}`)
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${what} must be a whole number of at least ${min}`)
  return max === undefined ? n : Math.min(n, max)
}

/** One value out of a closed vocabulary, or the default when the caller named none. */
function readEnum(what, raw, allowed, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw new Error(`${what} must be one of ${allowed.join(', ')}`)
  }
  return raw
}

/** The search text, or '' for no search. Refused rather than truncated; see MAX_QUERY. */
function readQuery(raw) {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string') throw new Error('q must be a string')
  if (raw.length > MAX_QUERY) {
    throw new Error(`q must be at most ${MAX_QUERY} characters: a shortened search matches more than was asked for, so a longer one is refused rather than cut`)
  }
  return raw
}

/** The id of one card. Refused when absent, because "no id" is not a question this can answer. */
function readId(raw) {
  if (typeof raw !== 'string' || raw === '') throw new Error('id must be a non-empty string')
  return raw
}

/**
 * The two reads both entry points are built from.
 *
 * `state` is the shared object index.mjs fills in `setup()`, reached through
 * `repoOf` on every call rather than captured once: these functions are built
 * at module scope, before `setup()` has run, and a repository captured then
 * would be null forever. `repoOf` also names the missing step instead of
 * throwing a TypeError from inside a query.
 */
export function createItemReads(state) {
  return {
    /**
     * A page of cards, plus `total` -- the size of the whole match, not of the
     * page. A caller that asked for more than `MAX_LIMIT` gets `MAX_LIMIT`
     * rows and a `total` that still says how many there were.
     */
    list(args = {}) {
      return repoOf(state).items({
        status: readEnum('status', args.status, ITEM_STATUSES, 'all'),
        q: readQuery(args.q),
        order: readEnum('order', args.order, ITEM_ORDERS, 'recent'),
        limit: readWholeNumber('limit', args.limit, { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT }),
        offset: readWholeNumber('offset', args.offset, { min: 0, fallback: 0 }),
      })
    },
    /**
     * One card by id, or null when no row carries that id.
     *
     * `null` is the answer for a card that never existed and for one that is no
     * longer there, and it is deliberately not an empty object or an empty
     * list: "there is no such card" and "here is a card with nothing in it" are
     * different facts, and only the first one is true.
     */
    get(args = {}) {
      return repoOf(state).itemById(readId(args.id))
    },
  }
}
