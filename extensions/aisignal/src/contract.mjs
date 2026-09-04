import { createItemReads, projectSignalColumns } from './reads.mjs'

/**
 * The one thing another extension may ask AI Signal for: its stored cards.
 *
 * This is a `provides` declaration, the host-mediated way one extension reaches
 * another's data (`src/lib/server/extensions/extension-contracts.ts`). Extension
 * storage is otherwise isolated per extension, and this does not open that up:
 * a consumer reaches these two methods only after naming this extension, this
 * contract and this version in its own `consumes`, with a sentence the operator
 * reads before granting it.
 *
 * WHY THESE TWO METHODS AND NOT THE OTHERS.
 * The surface a consumer needs to read signals is a filtered list and a
 * single-card read, and the whole of what the planned newsletter module does is
 * "give me the saved cards, and give me that one again by id". So the contract
 * is `list` and `get`.
 *
 * Everything else on the rpc map is deliberately outside it:
 *
 *   - `decide` writes. A contract whose summary says "read" and whose methods
 *     include a write is exactly the mismatch the host cannot catch for an
 *     operator -- it mediates access, not semantics -- so the honest way to
 *     keep the promise is not to declare the method. Deciding a card is the
 *     owner's act: the person looking at the deck, through this extension's own
 *     page.
 *   - `health` reports on the operator's Google credential. Whether a mailbox
 *     is connected is not a fact about signals, and a consumer that needs to
 *     know whether it is looking at a stale set can read the sweep rows through
 *     the operator's own UI rather than probe another extension's credential
 *     state through a data contract.
 *   - `board` and `sweeps` are the page's shape, not a data model. `board`
 *     bundles a deck, a recent list, a history, a label and a credential status
 *     because that is one page load; a consumer that gets it is coupled to
 *     this extension's UI and breaks when the page changes. `sweeps` is the
 *     run history, which is diagnostics for the operator.
 *
 * A method may be added here later, with a version bump, and that will be a
 * decision somebody makes. What must not happen is the contract growing because
 * the page grew, which is why this file lists its methods one by one over the
 * shared implementation in reads.mjs instead of handing over a slice of the rpc
 * map.
 *
 * WHAT THIS SIDE OF THE BOUNDARY CANNOT DO, AND MUST NOT PRETEND TO.
 * The host decides who reaches these methods: a consumer that did not name
 * this contract in its own `consumes` gets `not_declared` and no handle, and
 * the handle it does get is a bearer capability -- it carries the identity of
 * the extension it was minted for wherever it is passed on, and the host never
 * re-checks that against whoever actually calls. So nothing arrives here that
 * says who is asking, and nothing below may act as though something did. A
 * method that answered differently "for the newsletter module" would be
 * trusting a name it cannot verify, and the way to narrow what a consumer can
 * reach is the only way there is: declare fewer methods. These two read, and
 * that is the whole of the limit.
 *
 * Nor is this the only route to these rows, and the comments here must not read
 * as though it were. Extensions are trusted same-process code; a browser bundle
 * on the app's own page can already POST to
 * `/api/extensions/aisignal/call/<method>` under any extension's id, which the
 * route itself says plainly. What the contract buys is not containment. It is
 * that a *server-side* consumer's access is declared, versioned, and listed on
 * the operator's extension card with the sentence that consumer wrote for
 * wanting it.
 *
 * WHAT THE CONSUMER IS HOLDING WHEN THESE RETURN.
 * Not the row `db.mjs` stores -- a fixed projection of it, `SIGNAL_CONTRACT_
 * COLUMNS` in reads.mjs, chosen for what a reader needs to identify, present,
 * rank and link a card and to know whether the operator has acted on it.
 * `source_email`, the sweep's own bookkeeping (`sweep_id`, `message_id`,
 * `kind`, `account`), and the columns reads.mjs lists beside them do not cross
 * this boundary; see that list for the full accounting of what is in and what
 * is out, and why each one is.
 *
 * Within that projection, `headline`, `summary` and `url` are exactly what the
 * newsletter or the forum wrote -- unescaped, untruncated, and written by a
 * stranger who has every reason to try to steer whatever reads them next. The
 * host does not clean data crossing this boundary and does not claim to; the
 * `summary` below says so in the sentence the operator reads, and it is the
 * consumer -- the layer that knows whether the text is going into a DOM node,
 * a model prompt or an outbound email -- that has to guard it there. Nothing on
 * this side of the boundary treats it as anything but bytes: see the header of
 * reads.mjs. The allowlist narrows which columns arrive; it does not clean the
 * ones that do.
 */

/** The contract name, as a consumer spells it in `consumes` and in `ctx.contracts.get`. */
export const SIGNALS_CONTRACT = 'signals'

/**
 * The contract version. A consumer pinning a different number gets
 * `version_mismatch` and no handle, which is the point: bump this whenever a
 * method is removed, renamed, or changed in a way an existing consumer would
 * read wrongly.
 */
export const SIGNALS_CONTRACT_VERSION = 1

/**
 * Builds the `provides.signals` declaration index.mjs hands the host.
 *
 * Built at module scope, before `setup()` has run, so it cannot capture a
 * repository; the methods reach `state` on every call, the way the tools and
 * the rpc handlers do.
 *
 * Both methods are `async` even though the repository is synchronous. Not
 * decoration: a consumer always awaits, because the handle the host mints
 * around these returns a promise whatever they do, and the rpc methods over the
 * same reads are async too. A caller that gets a promise from one entry point
 * and a bare value from the other has to remember which is which, and the
 * refusals -- which are the interesting half -- would arrive as a throw on one
 * side and a rejection on the other.
 */
export function createSignalsContract(state) {
  const reads = createItemReads(state)
  return {
    version: SIGNALS_CONTRACT_VERSION,
    summary: 'Reads AI Signal cards: a filtered, paged list and one card by id. Their text is newsletter and forum content written by strangers; guard it before showing or sending it.',
    methods: {
      /**
       * A page of cards: `{ total, count, items }`, filtered by `status` and
       * `q`, ordered by `order`, cut to `limit`/`offset`. `total` is the size
       * of the whole match, so a capped page is never mistaken for the end of
       * the list. Arguments are read by the rule in reads.mjs: absent means the
       * default, and anything present that cannot be honoured is refused rather
       * than widened -- a consumer that asks for `status: 'saevd'` gets an
       * error, not every card in the table.
       *
       * `items` is the shared query's rows narrowed through
       * `projectSignalColumns` to `SIGNAL_CONTRACT_COLUMNS` -- `total` and
       * `count` describe the same match either way, so only the row shape
       * changes at this boundary, never which rows matched or how many.
       */
      list: async (args) => {
        const { total, count, items } = await reads.list(args)
        return { total, count, items: items.map(projectSignalColumns) }
      },
      /**
       * One card by `id`, or `null` when nothing carries that id -- including
       * the case a consumer will actually hit, an id it read a moment ago whose
       * row is gone by the time it asks again. A row that is found is narrowed
       * through `projectSignalColumns` the same way `list`'s rows are.
       */
      get: async (args) => projectSignalColumns(await reads.get(args)),
    },
  }
}
