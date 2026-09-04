import { DECISIONS } from './db.mjs'
import { createItemReads, readWholeNumber } from './reads.mjs'
import { DEFAULT_LABEL, OAUTH_PURPOSE, repoOf } from './sweep.mjs'

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
 *   - `board().gmail` and `health().gmail` separate a credential that is
 *     connected, one that is absent, and one this process could not ask about.
 *     See `gmailHealth`.
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
 * The Gmail half of `board()` and `health()`: connected, absent, or unknown.
 *
 * `connected` means the host holds a credential filed under this extension's
 * purpose. It does not mean a sweep would succeed, and the page must not say
 * that it does: a token the user revoked at Google, or one whose scopes were
 * narrowed, still reads as `connected` here until a run actually asks Gmail and
 * comes back with a `gmail_*` code on the sweep row. This is a question about
 * what is stored, and the only honest thing to draw from it is whether there is
 * anything to sweep with at all.
 *
 * Three states and not two, because `hasGoogleCredential` can fail rather than
 * answer -- the host reads the stored credential off disk to answer it -- and
 * the two failures a caller might otherwise be handed are both false reports.
 * Saying `missing` when the check itself blew up tells an operator to reconnect
 * an account that may be perfectly well connected; letting the throw escape
 * turns the whole board into a 500 over a status line. So a throw is its own
 * status, with a code from this file's own vocabulary.
 *
 * What is deliberately not in the return value: any part of the credential, and
 * any part of the thrown error. No token, no expiry, no account name -- the
 * page asks whether it may sweep, not what the secret is. The thrown message is
 * logged rather than returned for a narrower reason: it comes from the host's
 * credential store, this file cannot know what it quotes, and an rpc response
 * is the wrong place to find out. `code` is a fixed string, so a page may
 * safely branch on it; `status` is the only thing it needs to.
 */
function gmailHealth(state, hasGoogleCredential) {
  try {
    return hasGoogleCredential(OAUTH_PURPOSE) ? { status: 'connected' } : { status: 'missing', code: 'gmail_token_missing' }
  } catch (err) {
    state.log?.warn?.('aisignal: could not check the Google credential', { message: err instanceof Error ? err.message : String(err) })
    return { status: 'error', code: 'gmail_check_failed' }
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
 * `hasGoogleCredential` arrives as a dependency rather than being read off
 * `state.oauth` here so a test can drive both a connected and a disconnected
 * install with no credential anywhere near it -- the seam `gmailFactory` is for
 * sweep.mjs and `fetchImpl` is for research.mjs. It is required at build time
 * rather than defaulted: a wiring mistake in index.mjs would otherwise surface
 * as `gmail: { status: 'error' }` on every board, which reads as a broken
 * credential and is a false report about Gmail.
 */
export function createRpc(state, deps) {
  if (typeof deps?.hasGoogleCredential !== 'function') {
    throw new Error('createRpc needs a hasGoogleCredential function: without one the board cannot say whether Gmail is connected')
  }
  const reads = createItemReads(state)
  const gmail = () => gmailHealth(state, deps.hasGoogleCredential)
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
     * The status line: whether a Google credential is stored, which label the
     * sweep would read, and how much this install has.
     *
     * The repository is resolved first so an extension that has not been set up
     * says exactly that, rather than reporting a Gmail status it has no business
     * knowing yet.
     *
     * There is no token, no refresh token and no account address in this
     * response, and there is nothing to add one to: `gmail` is a status and an
     * optional fixed code.
     */
    async health() {
      const repo = repoOf(state)
      return { gmail: gmail(), label: labelOf(state), counts: repo.counts(), deckLimit: DECK_LIMIT }
    },
  }
}
