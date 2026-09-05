import { DECISIONS } from './db.mjs'
import { MAILBOX_CONTRACT, MAILBOX_PROVIDER } from './mailbox.mjs'
import { createItemReads, readWholeNumber } from './reads.mjs'
import { DEFAULT_LABEL, repoOf } from './sweep.mjs'

/**
 * The methods AI Signal's own page may call, and nothing else.
 *
 * One of the two entry points over `createItemReads`; the other is the
 * `signals` contract in contract.mjs. This one is the wider of the two on
 * purpose. It is reached over `POST /api/extensions/aisignal/call/<method>`,
 * which the app's access-key check already guards, and the only thing on the
 * far side of it is this extension's own bundle -- so it carries the surface a
 * page needs, including the one method that writes.
 *
 * Adding a method here adds nothing to the contract. That is the whole reason
 * the two are separate objects in separate files rather than one map the
 * contract re-exports a slice of: the contract is a promise to somebody else's
 * code, and it must not grow because this page grew.
 *
 * WHAT AN EMPTY LIST MEANS HERE, AND WHAT IT DOES NOT.
 * The rule the sweep and research layers are built on -- a source that answered
 * with nothing and a source that could not be asked are different facts -- does
 * not stop at the tool boundary, because a page that draws an empty deck under
 * the words "nothing new" has made the false report on their behalf. Nothing in
 * this file can tell the two apart on its own; what it can do is hand over the
 * rows that can, and never flatten them:
 *
 *   - `board().sweeps` and `sweeps()` return sweep rows as stored, `ok` and
 *     `note` and `finished_at` included. A run that blew up is `ok: 0` with its
 *     failure text in `note`; a run that read the label and found nothing is
 *     `ok: 1` with `found: 0`; a run still in flight, or one whose process
 *     died, is `finished_at: null`. An empty deck beside any of those means
 *     something different, and all three reach the page.
 *   - `board().gmail` and `health().gmail` separate a mailbox this install can
 *     reach, one it cannot and the named reason why, and a question this
 *     process could not put at all. See `mailboxHealth`.
 *   - Every capped list says what it was capped at and how many rows are behind
 *     it, so a full page cannot be read as "that is all there is". `deck` has
 *     `deckLimit` and `undecided`, exactly as the repository built it;
 *     `sweeps` and the `items` pages get the same treatment from `counts`.
 *
 * WHAT THIS FILE DOES TO THE STORED TEXT: NOTHING. Every headline, summary and
 * url on these rows is newsletter prose or a forum post written by a stranger,
 * and it is handed on byte for byte. Neither does any of it steer anything
 * here: no branch in this file reads a row's content. See the header of
 * reads.mjs, which states both halves for the queries themselves.
 */

/** Cards on the decide deck. */
const DECK_LIMIT = 50

/**
 * The page size the list asks `items()` for, and the sweep rows `board()`
 * returns beside the deck.
 *
 * Both are caps and neither is a total. `board()` returns `counts` so the page
 * can say "50 of 4,318" instead of implying the cap is the whole table -- the
 * same reason the repository's own `board()` returns `undecided` beside a
 * capped `deck`. `board()` reports `allLimit` but does not ship the list
 * itself: the list view asks `items()` for the page it shows, and a board is
 * reloaded after every decision, so 200 rows nothing read went out each time.
 */
const ALL_LIMIT = 200
const SWEEP_LIMIT = 10

/** The most sweep rows one `sweeps()` call will return, however many are asked for. */
const MAX_SWEEPS = 100

/**
 * The Gmail half of `board()` and `health()`: whether this install can reach a
 * mailbox at all.
 *
 * WHAT IT IS NOW A QUESTION ABOUT, AND WHAT IT IS NOT. It used to ask the host
 * whether a Google credential was stored under this extension's own OAuth
 * purpose. There is no such credential any more: the mailbox belongs to the
 * `gmail` extension, and this one reaches it over that extension's `mailbox`
 * contract. So the question this file can honestly put is whether the contract
 * resolves, and nothing about a credential -- the page says so in as many
 * words and links to `/x/gmail`, where the credential's own status is
 * reported by the extension that holds it.
 *
 * `ready` therefore means less than `connected` used to and must not be drawn
 * as more: the provider is installed, enabled and serving the version this
 * extension pinned. It does not mean a mailbox is connected, and it does not
 * mean a sweep would succeed. A run that actually asks is the only thing that
 * settles that, and it comes back with a `gmail_*` code on the sweep row.
 *
 * `unavailable` carries the host's own reason word -- `provider_missing`,
 * `provider_disabled`, `version_mismatch`, `not_declared` -- because each is a
 * DIFFERENT OPERATOR ACTION: install it, switch it back on, upgrade one of the
 * two, reinstall this one. Folding them into "not available" would leave the
 * operator with four places to look.
 *
 * Three states and not two, for the reason there were three before:
 * `contracts.why` can fail rather than answer -- resolving asks the host to
 * make sure its extension map is loaded -- and both of the other answers would
 * be false reports. Saying `unavailable` when the check blew up sends an
 * operator to install an extension that may be sitting there working; letting
 * the throw escape turns the whole board into a 500 over a status line.
 *
 * What is deliberately not in the return value: any part of the thrown error.
 * It comes from the host, this file cannot know what it quotes, and an rpc
 * response is the wrong place to find out; it is logged instead. `code` and
 * `reason` are fixed strings out of closed sets, so a page may branch on
 * either.
 */
function mailboxHealth(state) {
  const contracts = state.contracts
  // Null before `setup()` has run, and on a host that hands an extension no
  // contracts at all. Neither is a provider that is missing, and reporting one
  // as the other would send the operator to install something.
  if (!contracts) return { status: 'error', code: 'aisignal_contracts_missing' }
  try {
    const reason = contracts.why(MAILBOX_PROVIDER, MAILBOX_CONTRACT)
    return reason === null || reason === undefined ? { status: 'ready' } : { status: 'unavailable', reason }
  } catch (err) {
    state.log?.warn?.('aisignal: could not check the mailbox contract', { message: err instanceof Error ? err.message : String(err) })
    return { status: 'error', code: 'aisignal_contract_check_failed' }
  }
}

/** The Gmail label the operator configured, or the one a sweep would fall back to. */
function labelOf(state) {
  const settings = state.settings() || {}
  return String(settings.label || DEFAULT_LABEL)
}

/**
 * Builds the `rpc` map index.mjs declares.
 *
 * It takes no dependency object any more. The credential check that used to be
 * injected here is gone with the credential: `mailboxHealth` reads
 * `state.contracts`, which is the same shared object every other method here
 * reads and which a test fills the way `setup()` does. There is nothing left
 * for a wiring mistake in index.mjs to get wrong at this seam.
 */
export function createRpc(state) {
  const reads = createItemReads(state)
  const gmail = () => mailboxHealth(state)
  return {
    /**
     * Everything one page load needs: the deck to decide on, the sweep
     * history, the configured label and the Gmail status. The list is not
     * here; the page asks `items()` for it with `allLimit`.
     *
     * `deck` and `sweeps` are each capped, and each cap is reported beside
     * the count it was taken from -- `deckLimit`/`undecided` from the
     * repository, `sweepLimit` here, and `counts` for the totals behind all
     * of them and behind the `items()` pages.
     *
     * `board.undecided` and `counts.undecided` answer the same question --
     * how many cards are still `new` -- and `counts` is built from
     * `board.undecided` rather than from its own count of the same rows.
     * better-sqlite3 is synchronous and nothing awaits between the two reads
     * today, so they cannot disagree either way; but that is a property of
     * this function's current body, not of the two counts, and a later `await`
     * dropped in between them would let a write land in the gap and hand the
     * page two different numbers for one fact with no way to say which is
     * current. Building `counts.undecided` from `board.undecided` instead of a
     * second query makes the response internally consistent by construction,
     * so it stays that way regardless of what this function's body does next.
     */
    async board() {
      const repo = repoOf(state)
      const board = repo.board(DECK_LIMIT)
      return {
        ...board,
        allLimit: ALL_LIMIT,
        sweeps: repo.sweeps(SWEEP_LIMIT),
        sweepLimit: SWEEP_LIMIT,
        counts: { ...repo.counts(), undecided: board.undecided },
        label: labelOf(state),
        gmail: gmail(),
      }
    },
    /** A filtered page of cards. Arguments are read by the rule in reads.mjs. */
    async items(body = {}) {
      return reads.list(body)
    },
    /**
     * The one method here that writes.
     *
     * Both arguments are checked before the repository sees them, so a caller
     * gets a message naming what it may send rather than a SQLite bind error or
     * the repository's terser refusal. The decision vocabulary is imported from
     * db.mjs rather than retyped: the repository owns it, and a second copy
     * would eventually refuse a decision the repository accepts.
     *
     * An id that matches no row comes back as `{ ok: false }` from the
     * repository and is passed through unchanged. That is not an error -- the
     * card may have been there when the page drew it -- but it is also not a
     * write, and reporting it as one would be the false report this extension
     * spends its comments on.
     */
    async decide(body = {}) {
      if (typeof body.id !== 'string' || body.id === '') throw new Error('id must be a non-empty string')
      if (typeof body.decision !== 'string' || !DECISIONS.includes(body.decision)) {
        throw new Error(`decision must be one of ${DECISIONS.join(', ')}`)
      }
      return repoOf(state).decide(body.id, body.decision)
    },
    /**
     * The sweep history, newest first.
     *
     * The limit is read by the same rule every other limit is: absent means the
     * default, above the cap is capped, and anything else present is refused.
     * A negative one in particular has to be refused rather than passed on --
     * SQLite reads a negative LIMIT as no limit at all, so a caller that sent
     * `-1` would be handed every sweep row the install has ever written.
     */
    async sweeps(body = {}) {
      return repoOf(state).sweeps(readWholeNumber('limit', body.limit, { min: 1, max: MAX_SWEEPS, fallback: SWEEP_LIMIT }))
    },
    /**
     * The status line: whether the mailbox contract resolves, which label the
     * sweep would read, and how much this install has.
     *
     * The repository is resolved first so an extension that has not been set up
     * says exactly that, rather than reporting a mailbox status it has no
     * business knowing yet.
     *
     * There is no token, no refresh token and no account address in this
     * response, and there is nothing to add one to -- this extension holds no
     * credential and never sees the mailbox address outside a run. `gmail` is a
     * status plus one fixed word out of a closed set.
     */
    async health() {
      const repo = repoOf(state)
      return { gmail: gmail(), label: labelOf(state), counts: repo.counts(), deckLimit: DECK_LIMIT }
    },
  }
}
