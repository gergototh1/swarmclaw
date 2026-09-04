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
 * The row shape gets the same separation, one level down. Both reads here
 * return the row `db.mjs` builds with `SELECT *`, so rpc.mjs's page keeps the
 * whole thing -- it is this extension's own surface. contract.mjs does not:
 * it narrows every row through `projectSignalColumns` to
 * `SIGNAL_CONTRACT_COLUMNS`, the explicit allowlist below, before a consumer
 * ever sees one. A migration that adds a column to `ext_aisignal_items` for
 * the page's own use does not reach a contract consumer until that array is
 * edited, which is the point: which columns cross the boundary is a decision,
 * not a side effect of the table growing.
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

/**
 * The complete status vocabulary `list` accepts. 'all' is the absence of a
 * status filter.
 *
 * Not exported: nothing outside this module names the vocabulary today, and a
 * second copy would be the way it drifts. Build for the current requirement --
 * see M2 in the review this rule comes from.
 */
const ITEM_STATUSES = Object.freeze(['all', 'new', 'saved', 'archived', 'unknown'])

/** The complete ordering vocabulary `list` accepts, spelled as the repository spells it. */
const ITEM_ORDERS = Object.freeze(['recent', 'score'])

/** Cards per page when the caller has no opinion, and the most any caller can have on one page. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

/**
 * The longest search text a caller may send.
 *
 * A longer one is refused rather than shortened. Shortening looks harmless and
 * is not: `LIKE '%<first 200 chars>%'` matches a superset of what the full
 * string would have matched, so a truncated search answers with rows that do
 * not match the question that was asked, and says nothing about having changed
 * it.
 */
const MAX_QUERY = 200

/**
 * A whole number the caller may or may not have an opinion about.
 *
 * Only a number or a numeric string is considered. `Number` alone would accept
 * `true` as 1 and `[5]` as 5, and a caller that sent either did not mean a
 * limit of one or five; it made a mistake this layer would then hide.
 *
 * "Numeric string" is whatever `Number()` parses, which is wider than it
 * sounds: `'0x10'` reads as 16, `'1e3'` as 1000, and `' 5 '` as 5, all past the
 * type check above and into the same bound and cap every other value gets. Not
 * narrowed to decimal digits on purpose -- every one of those still names a
 * whole number inside the caller's declared bounds, so refusing the spelling
 * would refuse honest values for a cosmetic reason.
 *
 * `Number.isSafeInteger`, not `Number.isInteger`: the latter is true for
 * `1e21` and `1e300`, which is how an unbounded argument like `offset` (no
 * `max` at its call site) used to reach `LIMIT ? OFFSET ?` in db.mjs and raise
 * SQLite's own `datatype mismatch` instead of this module's named refusal.
 * Every value this module is meant to honour is far below the safe-integer
 * ceiling, so the narrower check disturbs nothing honest and closes the gap at
 * both call sites that have no `max` of their own to catch it first.
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
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${what} must be a whole number of at least ${min}`)
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
 * The columns a `signals` contract consumer receives, exported so contract.mjs
 * projects rows through the same list this module tests against rather than a
 * second one that could grow independently.
 *
 * `db.mjs`'s `items()` and `itemById()` both `SELECT *`, so a migration that
 * adds a column to `ext_aisignal_items` for the UI's own use joins the
 * contract the same day unless something stands between the two on purpose.
 * This is that something: a column reaches a contract consumer only by being
 * added to this array, which is a line somebody has to write and a reviewer
 * has to read, not a side effect of a `CREATE TABLE` migration three files
 * away. `contract.test.mjs` pins the array itself, so an addition here is
 * also a diff a review has to notice.
 *
 * Chosen for what a reader of the contract's own summary needs -- "a newsletter
 * module needs to identify, present, rank and link an item, and to know
 * whether the operator selected it":
 *
 *   - `id`                    identify: the handle `get` re-reads a card by.
 *   - `headline`, `summary`   present: the card's own text. Newsletter prose
 *                             or a forum post written by a stranger, handed
 *                             on unescaped and untruncated, exactly as
 *                             `db.mjs` stores it -- see the header of this
 *                             file for what "unchanged" means and does not.
 *   - `source_name`           present: who the card is attributed to, a
 *                             display name rather than a mailing address.
 *   - `url`                   link: where the card points.
 *   - `score`, `apply_score`  rank: `order: 'score'` sorts a list by both
 *                             together (`apply_score DESC, score DESC`), so a
 *                             consumer ranking its own selection needs both
 *                             numbers behind that ordering, not just the one
 *                             that broke the last tie.
 *   - `status`                selected: whether the operator has acted on
 *                             the card at all, and if so how -- 'new',
 *                             'saved' or 'archived'. This is the card's own
 *                             decision state, not sweep bookkeeping about how
 *                             it arrived.
 *
 * Deliberately left off, and why leaving each off is a decision rather than an
 * oversight:
 *
 *   - `source_email`          A stranger's mailing address, not the card's
 *                             own content. The earlier round that deferred
 *                             excluding it argued a contract consumer needs
 *                             the row byte-for-byte because the host does not
 *                             clean data crossing the boundary; that argument
 *                             conflates two different guarantees. The host's
 *                             promise not to touch what a provider returns
 *                             constrains the host -- it says nothing about
 *                             which columns a provider chooses to return in
 *                             the first place, and choosing the row shape is
 *                             exactly the decision the host declines to make
 *                             for a provider. A module composing outbound
 *                             mail has every opportunity to put a third
 *                             party's address in a body, a footer, a Reply-To
 *                             or a log, and a bearer handle's audience is not
 *                             "the newsletter module" but whoever it passes
 *                             the handle to.
 *   - `sweep_id`, `message_id`,
 *     `kind`, `account`       The sweep's own bookkeeping: which run and
 *                             which mailbox produced the row, not a fact
 *                             about the card. See the key inventory at the
 *                             top of db.mjs for what each one gates.
 *   - `sent_at`, `created_at`,
 *     `decided_at`            Timestamps nothing a reader, ranker or linker
 *                             needs today; adding one back is the same
 *                             deliberate, reviewed act as adding any other
 *                             column here.
 *   - `why`                   The score's own private rationale, written for
 *                             the operator's deck, not for a downstream
 *                             audience.
 *   - `link_read`             Whether this extension's own page has been
 *                             opened for this card -- a fact about this
 *                             page's reader, not about the card.
 *
 * The page itself is unaffected: `rpc.items` and `rpc.board` keep calling
 * `createItemReads` directly and return the row as `db.mjs` built it, because
 * the page is this extension's own surface and this allowlist exists only at
 * the contract boundary.
 */
export const SIGNAL_CONTRACT_COLUMNS = Object.freeze([
  'id', 'headline', 'summary', 'source_name', 'url', 'score', 'apply_score', 'status',
])

/**
 * Projects one stored row down to `SIGNAL_CONTRACT_COLUMNS`. `null` passes
 * through as `null` rather than becoming an object of undefined columns,
 * because a card the caller cannot find must stay indistinguishable from one
 * that never existed -- the rule `itemById` in db.mjs already states.
 */
export function projectSignalColumns(row) {
  if (!row) return row
  const projected = {}
  for (const column of SIGNAL_CONTRACT_COLUMNS) projected[column] = row[column]
  return projected
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
     *
     * `limit`/`offset` paging is not a stable cursor. A row inserted between
     * two calls shifts every row after it by one, so a caller paging through
     * with a fixed `offset` can see a row twice or skip one it never saw --
     * `total` moving between the two calls is the only signal that happened.
     * `saved` rows are written by an operator sweep rather than by a stranger
     * on a schedule, so the window this is reachable in is narrow, but it is
     * not handled: a caller that pages while a sweep may be running should
     * treat a moving `total` as "re-read, do not trust the seam."
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
