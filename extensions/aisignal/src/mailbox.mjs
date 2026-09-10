/**
 * The seam AI Signal reads its mailbox through: the `mailbox` contract that the
 * `gmail` extension provides, and nothing else.
 *
 * This file replaces `src/gmail.mjs`, which was a Gmail REST client of this
 * extension's own. That client now lives in `extensions/gmail/src/client.mjs`
 * behind the contract, so there is one Gmail credential in the product instead
 * of two and the operator connects once. What is left here is the part that was
 * never the client's: naming a source, naming a failure, and naming the window.
 *
 * WHAT THIS LAYER OWES THE FRONTIER. `sweep.mjs` keeps a stored watermark per
 * source, and every property that watermark rests on passes through here:
 *
 *   - A SOURCE IS RESOLVED, NOT GUESSED. `resolveSource` asks the contract what
 *     the operator's label name resolves to and whose mailbox it is in, and a
 *     run that cannot answer both halves gets an exception rather than a
 *     half-built key. `sweep.mjs` calls it before it reads any frontier, which
 *     is why a run that cannot name its source reads none and moves none.
 *   - THE MATCH ON THE LABEL NAME IS EXACT, case included. Gmail allows two
 *     labels differing only in case, so folding the case could resolve the
 *     operator's name to the other one and sweep the wrong bucket. The contract
 *     deliberately hands over the whole label list rather than matching for us,
 *     because only this side knows which name it wants; so `gmail_label_missing`
 *     is raised HERE, and there is no thrower for it anywhere in
 *     `extensions/gmail/src/`.
 *   - A FAILURE KEEPS ITS NAME. See `codeOf`: the host wraps a provider's
 *     exception, and the wrapper's own code says nothing an operator can act on.
 *
 * WHAT THIS LAYER DOES NOT DO. It does not sanitise. Label names, subjects and
 * bodies are written by strangers and cross as bytes; the only thing that
 * happens to them here is an equality comparison against the name the operator
 * typed. No value read off a message or a label reaches a query, a file name, a
 * log something parses, an error message, or anything read as control state --
 * `resolveSource` names the operator's own setting in its refusal and never the
 * mailbox's answer.
 */

/** The extension that provides the mailbox, as `ctx.contracts.get` spells it. */
export const MAILBOX_PROVIDER = 'gmail'
/** The contract, as this extension names it in `consumes` and asks for it. */
export const MAILBOX_CONTRACT = 'mailbox'
/**
 * The contract version this extension is written against.
 *
 * It is declared in `index.mjs`'s `consumes`, and the host -- not this constant
 * -- is what refuses a provider serving a different one, with reason
 * `version_mismatch`. The constant is here so the page and the sweep can say
 * WHICH version they wanted; a second, weaker version check on this side would
 * only be another place to disagree with the host.
 */
export const MAILBOX_VERSION = 2

/**
 * The contract could not be resolved into a handle at all: the `gmail`
 * extension is not installed, or is switched off, or serves a different
 * version, or this extension's own `consumes` declaration is missing.
 *
 * One code rather than four, with the host's reason word in the message and on
 * the page's own status. The four reasons are four different operator actions
 * and none of them is "look at the sweep row"; what a sweep row needs to say is
 * that the run never reached a mailbox, which is one fact.
 */
export const MAILBOX_UNAVAILABLE = 'aisignal_mailbox_unavailable'

/**
 * An error this extension raises about the mailbox, carrying a name the sweep
 * row records and the page can branch on.
 *
 * A class of its own rather than the `gmail` extension's `GmailError`: the two
 * extensions are installed into separate workspaces, so nothing under
 * `extensions/gmail/src/` is on this module's resolution path at runtime. The
 * codes are spelled the same as that module's on purpose -- `codeOf` passes a
 * provider's own code through untouched, so a row that reads `gmail_timeout`
 * means the same thing whichever side raised it.
 */
export class MailboxError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'MailboxError'
    this.code = code
  }
}

/**
 * The name every failure this extension records has to end up with.
 *
 * THE HOST WRAPS. A contract call that reaches the provider and throws comes
 * back as an `ExtensionContractError` whose `code` is `provider_threw` and
 * whose `cause` is the provider's own exception. Filed under the wrapper's code
 * a revoked credential, a timeout and a 403 would all land on the sweep row as
 * `provider_threw`, which tells an operator nothing to do -- so the cause's own
 * code is what is read, and it is the same vocabulary the old in-tree client
 * raised (`gmail_token_missing`, `gmail_timeout`, `gmail_scope_missing`, ...).
 *
 * The wrapper is matched on `err.name`, not with `instanceof`: an extension
 * module cannot import the host's `src/`, and the host documents the name and
 * the four codes as the surface an extension matches on.
 *
 * `unavailable` is the one wrapper code that is not a provider failure and is
 * given this extension's own name, with the host's reason word carried in the
 * message. The other two -- `unknown_method`, `call_depth_exceeded` -- are
 * already names out of a closed public set and pass through as themselves.
 *
 * Everything else keeps its string `code` whatever its class, because an error
 * that crossed a module boundary can carry a perfectly good name and fail
 * `instanceof`; only a genuinely unnamed error falls through to the generic
 * one.
 */
export function codeOf(e) {
  // Unwrapped once and not followed as a chain: the host rethrows a contract
  // error raised deeper down rather than re-wrapping it, so a `provider_threw`
  // never wraps another one, and walking a `cause` an unknown number of times
  // is a loop a self-referencing error could hold open.
  let named = e
  if (e?.name === 'ExtensionContractError') {
    if (e.code === 'unavailable') return MAILBOX_UNAVAILABLE
    if (e.code === 'provider_threw') named = e.cause
  }
  const code = named?.code
  return typeof code === 'string' && code !== '' ? code : 'gmail_unexpected'
}

/**
 * The mailbox handle this run will use, or an exception naming why there is
 * none.
 *
 * `state.gmailFactory` keeps its name so the shape of the existing tests
 * survives, but what it doubles has changed: it is the double of the CONTRACT
 * HANDLE now, not of a Gmail client, and its methods are `mailbox()`,
 * `labels()`, `list({ labelIds, q, max })` and `get({ id })`.
 *
 * Nothing is cached. The host re-resolves on every call through a handle
 * anyway, so holding one across runs would buy nothing and would hide the case
 * this function exists to report: `get` answers null the moment the provider is
 * switched off, and a run that quietly carried on through a stale closure is
 * precisely what the host's re-resolution refuses to allow.
 *
 * REFUSING HERE IS WHAT KEEPS THE FRONTIER STILL. This is called before the
 * source is resolved and therefore before any frontier is read, so an
 * unavailable provider fails the run with no key in hand: nothing is read,
 * nothing is moved, and the mail the window still holds is offered again on the
 * next run.
 */
export function mailboxFor(state) {
  if (state.gmailFactory) return state.gmailFactory()
  const contracts = state.contracts
  if (!contracts) {
    // `setup()` has not run, or it ran on a host that hands no `contracts` to
    // an extension. Either way there is no route to a mailbox, and saying so is
    // better than a `TypeError` on `undefined.get`.
    throw new MailboxError(MAILBOX_UNAVAILABLE, 'the AI Signal extension has no contract access: the host did not hand one over')
  }
  const handle = contracts.get(MAILBOX_PROVIDER, MAILBOX_CONTRACT)
  if (handle) return handle
  throw new MailboxError(MAILBOX_UNAVAILABLE, `the ${MAILBOX_PROVIDER} extension's ${MAILBOX_CONTRACT} contract v${MAILBOX_VERSION} is not available: ${whyUnavailable(contracts)}`)
}

/**
 * The host's word for why the contract does not resolve, or a stand-in when the
 * question itself could not be answered.
 *
 * `why` re-resolves, so it can in principle answer `null` -- the contract
 * resolved between the two calls -- and it can throw, because resolving asks
 * the host to make sure its extension map is loaded. Neither may become
 * "unavailable for no reason": a reason nobody can read is what sends an
 * operator looking in the wrong place.
 *
 * The value returned is one of the host's four closed-set words, or a fixed
 * string of this file's own. Nothing from a mailbox reaches it.
 */
export function whyUnavailable(contracts) {
  try {
    return contracts.why(MAILBOX_PROVIDER, MAILBOX_CONTRACT) ?? 'resolved on the second look'
  } catch {
    // The host's own message is not repeated: this layer cannot know what it
    // quotes, and a status line is the wrong place to find out.
    return 'the check itself failed'
  }
}

/**
 * Which source this run is about: the mailbox the credential opens and the
 * Gmail label id the operator's name resolves to.
 *
 * Both halves, or neither. A key built from one half is a key shared with every
 * other run that could not name the other, and the frontier under it would be a
 * statement about a source nobody can identify -- which is the whole defect the
 * source key exists to close.
 *
 * The label lookup goes first because it is the failure an operator actually
 * hits -- a typo in the setting -- and a run with no label has no source
 * whatever the mailbox says, so the mailbox request is not spent on it.
 *
 * Nothing is memoised: a remembered address outlives exactly the reconnect the
 * key exists to notice, and a remembered label id outlives exactly the repoint.
 */
export async function resolveSource(mb, label) {
  const sourceId = await labelIdFor(mb, label)
  return { account: await accountOf(mb), sourceId }
}

/**
 * The id of the label named exactly `label`.
 *
 * The comparison is case-sensitive, and that is the same decision the deleted
 * client made for the same reason: Gmail allows two labels differing only in
 * case, so folding the case could sweep the wrong bucket under the operator's
 * name. The contract hands over the whole list precisely so this side can
 * decide how to compare.
 *
 * A reply with no array of labels is a broken reply, not an answer about this
 * name: reporting it as `gmail_label_missing` would send the operator off to
 * create a label that already exists. Only a list that arrived and holds no
 * match is `gmail_label_missing`, and neither is ever an empty sweep.
 *
 * The matched entry's `id` is checked because an absent one is `undefined` by
 * the time it reaches `labelIds` on the next call, and the listing that comes
 * back is a listing of something else.
 *
 * The refusal names the label the operator typed and never a name the mailbox
 * answered with: the operator's own setting is the thing they can act on, and
 * the mailbox's names are stranger-writable text.
 */
async function labelIdFor(mb, label) {
  const labels = await mb.labels()
  if (!Array.isArray(labels)) throw new MailboxError('gmail_unexpected', 'the mailbox contract returned a label list that is not an array')
  const hit = labels.find((entry) => entry?.name === label)
  if (!hit) throw new MailboxError('gmail_label_missing', `no Gmail label named "${label}"`)
  if (typeof hit.id !== 'string' || !hit.id) throw new MailboxError('gmail_unexpected', 'the mailbox contract returned a label with no id')
  return hit.id
}

/**
 * The address of the mailbox this run is reading.
 *
 * The provider raises its own shape failure for a profile with no address, so
 * this is not the only check; it is this side's, because the value is about to
 * become half of a stored frontier key and an `undefined` there is a key shared
 * with every other mailbox that could not be named. A guard on the value a key
 * is built from belongs where the key is built.
 */
async function accountOf(mb) {
  const answer = await mb.mailbox()
  const address = answer?.address
  if (typeof address !== 'string' || !address) throw new MailboxError('gmail_unexpected', 'the mailbox contract returned no mailbox address')
  return address
}

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * The Gmail search term for "not older than this", as `after:YYYY/MM/DD`, to be
 * handed to `mb.list` as its `q`.
 *
 * THIS IS A SECOND COPY, deliberately, and the first is
 * `sinceQuery` in `extensions/gmail/src/client.mjs`. It is not imported from
 * there because it cannot be: each extension is installed into its own
 * workspace under `data/extensions/.workspaces/`, so at runtime nothing under
 * the `gmail` extension's directory is on this module's resolution path. The
 * contract is the only route between the two, and a pure string helper is not
 * on it. The alternative -- putting `sinceQuery` on the contract -- would make
 * a date-formatting function part of a published version that cannot be taken
 * back, for no gain over the copy.
 *
 * The copy is not left to good intentions: `test/sweep.test.mjs` imports both
 * spellings, which it may because test files are never installed, and pins that
 * they agree character for character. A drift fails there.
 *
 * The day is the one *before* the UTC day of `since`, which looks like an
 * off-by-one and is not. Gmail evaluates `after:D` as local midnight of D in
 * the mailbox's timezone, not as the UTC day boundary. West of UTC local
 * midnight is *later* in UTC than the UTC day boundary, so naming the UTC day
 * of `since` makes the window narrower than asked, and the messages it excludes
 * are lost for good rather than merely delayed:
 *
 *   A mailbox in America/Los_Angeles (UTC-7 in September) sweeps at 18:00 local
 *   on Sep 3 and records since = 2026-09-04T01:00Z. A newsletter arrives at
 *   19:00 local = 2026-09-04T02:00Z. The naive query is after:2026/09/04, which
 *   Gmail reads as 2026-09-04T07:00Z, so that newsletter is excluded -- and the
 *   next sweep's watermark is later still, so nothing ever brings it back. The
 *   caller's dedup cannot recover a message that was never listed. Every
 *   evening between local 17:00 and midnight, that mailbox sweeps clean and
 *   reports "found nothing".
 *
 * Stepping one day back makes the window too wide instead, which is the error
 * this module is allowed to make. Local midnight of day D-1 in a zone at offset
 * `o` is the instant (D-1)T00:00Z minus `o`, and UTC offsets run from -12:00 to
 * +14:00, so that instant falls between (D-2)T10:00Z at the eastern extreme of
 * UTC+14 and (D-1)T12:00Z at the western extreme of UTC-12. Both ends are
 * before DT00:00Z, which is itself at or before `since`, so the window always
 * opens early enough. One day back is enough for every timezone on earth, and
 * the cost is re-listing messages the caller already has ids for: at most 62
 * hours of them, from (D-2)T10:00Z to the latest instant day D can hold.
 *
 * Why the granularity must not be tightened
 * -----------------------------------------
 * Gmail's `after:` also accepts epoch seconds, so "ask for the exact instant
 * instead of over-widening by up to two days" reads as a free optimisation. It
 * is not, and the timezone argument above is only the first reason. The second
 * is the frontier: `since` is a stored watermark a previous run earned, and a
 * watermark is a single instant while a run is an interval. `sweep.mjs` keeps
 * the frontier no newer than the listing that earned it, and this coarse window
 * is the margin on the other side -- it re-opens far enough back that a message
 * which landed near the boundary, or a clock that moved between the two runs,
 * is listed again rather than passed over. An exact `after:<frontier>` removes
 * that margin, and what falls through it is not delayed but skipped: the dedup
 * cannot recover a message that was never listed. Erring wide costs a
 * re-listing that lands on the dedup, which is why every bound here errs wide.
 *
 * An absent or unparseable `since` yields an empty string, and the caller then
 * sends no `q` at all rather than a query that matches nothing.
 */
export function sinceQuery(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // Date.UTC normalises a day-of-month of 0 into the last day of the previous
  // month, and a month of -1 into December of the previous year, so this is
  // correct across every month, year and leap-day boundary.
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1))
  return `after:${day.getUTCFullYear()}/${pad2(day.getUTCMonth() + 1)}/${pad2(day.getUTCDate())}`
}
