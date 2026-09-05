import { Buffer } from 'node:buffer'

import { readString, readWholeNumber } from './args.mjs'
import { GmailError, TOKEN_CODES } from './hibak.mjs'

/**
 * Gmail REST client for the gmail extension.
 *
 * Moved here from `extensions/aisignal/src/gmail.mjs`, whose oddities are scars
 * and are kept as such. Two rules shape every line.
 *
 * The first: a sweep that found nothing and a sweep that could not look are
 * different facts, and the caller must be able to tell them apart. So no path
 * in this module answers a failure with an empty list. Every way this can go
 * wrong throws a `GmailError` carrying a named `code`, and the codes are a
 * closed set the rest of the extension catches by name. The set itself lives in
 * `hibak.mjs` -- one list for the whole module rather than a copy per file --
 * and these are the members this file can throw:
 *
 *   gmail_token_missing     no Google credential stored (from the host)
 *   gmail_token_unreadable  the stored refresh token cannot be decrypted (host)
 *   gmail_token_revoked     the refresh token was revoked or expired (host)
 *   gmail_refresh_failed    the token stage failed some other way (host)
 *   gmail_token_invalid     Gmail rejected the access token with 401
 *   gmail_scope_missing     Gmail answered 403 for a missing scope
 *   gmail_list_failed       listing labels or messages failed
 *   gmail_profile_failed    the mailbox profile could not be read
 *   gmail_fetch_failed      fetching one message failed
 *   gmail_draft_failed      creating, reading or deleting a draft failed
 *   gmail_send_failed       sending a draft failed
 *   gmail_cimkezes_sikertelen  a label change did not apply
 *   gmail_kurzor_ervenytelen   a `cursor` that is not a page token
 *   gmail_argumentum_alak      a `max` that is not a whole number in range
 *   gmail_timeout           Gmail did not finish answering within the deadline
 *   gmail_unexpected        transport error, a reply that is not JSON, or a
 *                           reply that parses but is not the documented shape
 *
 * `gmail_label_missing` is NOT thrown here any more and is not a code this file
 * can produce. `labels()` hands back the whole list and the caller matches the
 * name it wanted, because that is the only place the name is known; a caller
 * that finds no match raises `gmail_label_missing` itself. The distinction the
 * old `labelId` protected survives the move and is now `labels()`'s job: a
 * reply with no `labels` array is `gmail_unexpected`, never "no such label",
 * because sending an operator off to create a label that already exists is a
 * wrong answer rather than a slow one.
 *
 * The same rule shapes the two results that are not a single value:
 * `list` returns `{ ids, nextCursor, complete, stoppedOn }` because a listing
 * cut short is not the same fact as a listing Gmail finished, and because "the
 * cap filled up" and "the request budget ran out" are not the same fact either;
 * and `get` returns `textInAttachment` because a message whose text part was
 * served as an attachment is not the same fact as a message with no text at
 * all.
 *
 * The second: a message's content is data, never instruction. Nothing here
 * evaluates, follows or re-serialises what a message says. `stripHtml` removes
 * `<script>` and `<style>` because their contents are markup rather than
 * readable prose, not as a security control, and everything it returns is an
 * inert string. Nothing in this file branches on a `subject`, a `text` or a
 * header value, and no such value reaches a path, a query string or an error
 * message: the one place foreign text is allowed to take a shape is
 * `mime.mjs`, which says so at its own head and refuses rather than escapes.
 *
 * The access token arrives through an injected `getToken` rather than by
 * importing the host's OAuth module, so the whole client is testable against a
 * fake `fetch` with no credential anywhere near it.
 *
 * WHAT CHANGED ON THE WAY OVER FROM AI SIGNAL, listed because a comment that
 * still described the old shape would be worse than no comment:
 *
 *   - `GmailError` and `TOKEN_CODES` are imported from `hibak.mjs` instead of
 *     being declared here, so the vocabulary has one home.
 *   - `listIds({ labelId, since, max })` is `list({ labelIds, q, max, cursor })`:
 *     a real page cursor, a caller-supplied query, a list of labels rather than
 *     one, and `{ complete, nextCursor }` in place of `truncated`. `since` is
 *     gone from this layer -- a caller that wants the old window passes
 *     `q: sinceQuery(since)`, and `sinceQuery` is still exported for it.
 *   - `labelId(name)` is `labels()`, above.
 *   - `getMessage(id)` is `get(id)` and carries `threadId`, `labelIds` and
 *     `sizeEstimate` as well, because those are three of the ten fields the
 *     read projection is allowed to hand out (design spec 4.3) and the layer
 *     that projects them creates no client of its own.
 *   - `call` takes a method and a JSON body, so the five write calls below run
 *     under the same deadline and the same error mapping as the reads.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * Hard ceiling on how many list pages one `list` call will ever request.
 *
 * The bound that usually bites is the requested cap, not this number. Gmail
 * applies `q` inside a scan window, so a filtered page can under-deliver -- it
 * may answer with one id, or with an empty `messages` array and a
 * `nextPageToken`, when the page of the label holds little that matches. A page
 * is therefore worth as little as one id, and a cap of N can genuinely need N
 * pages; bounding the loop at a fixed 25 pages truncated a request for 200 down
 * to 25 without saying so.
 *
 * It is the ONLY page bound, and that is a change from the old `listIds`, which
 * also stopped at `Math.min(limit, MAX_PAGES)` pages. A cap cannot stand in for
 * a page bound once pages may be empty: a cap of 5 against a run of pages that
 * each match nothing would have stopped after 5 requests with 5 pages of the
 * label unexamined, and reported a mailbox that was never looked at. So the
 * budget is a request budget, spelt once, and a cap only ends the walk when ids
 * actually arrive.
 *
 * Whichever bound bites, the result says so: `complete` is false whenever the
 * walk stopped with a live page token in hand, `nextCursor` carries that token
 * so the caller can resume, and `stoppedOn` names which bound did it. The ids
 * collected are genuinely found ids, but "these are all of them" would be a
 * false statement.
 */
export const MAX_PAGES = 200

/**
 * How long one call may take -- token, headers and body together -- before it
 * is abandoned under its own code.
 *
 * Without a deadline a request that never answers hangs the whole run forever:
 * `fetch` has no default timeout, so a connection a middlebox holds open leaves
 * the caller waiting with a row open, no `finished_at`, and nothing on the
 * schedule to notice -- these runs are started by a schedule, so a hung one is
 * not a person staring at a spinner, it is a mailbox that quietly stops being
 * read. Every call goes through `call` below, so putting the deadline there
 * covers `/profile`, `/labels`, `/messages`, `/messages/{id}`, the three drafts
 * endpoints and `/messages/{id}/modify` at once.
 *
 * It covers the token stage as well as the Gmail request, and it has to. The
 * first network round trip of every call is not to Gmail at all: `getToken` is
 * the host's, and the host refreshes against Google's token endpoint with a
 * bare `fetch` carrying no signal and no timeout of its own. A hang there
 * strands a scheduled run before the first Gmail call has returned, so there is
 * not even a failed row to point at, and the mailbox stops being read with
 * nothing anywhere to say why.
 *
 * What this layer can do about that is bounded, and the boundary is written
 * down rather than implied: the host's fetch never receives this
 * `AbortController`'s signal, so the wait is *raced* against the deadline, not
 * cancelled. A token request that has already gone out is abandoned and lives
 * on until it settles by itself; what the deadline guarantees is that the run
 * fails on time, under `gmail_timeout`, instead of hanging forever. That is
 * less than cancellation and more than nothing, and it is the whole promise.
 *
 * It covers the body as well as the headers, because a reply whose stream never
 * ends hangs exactly as thoroughly as one that never arrives.
 *
 * Thirty seconds is far above anything Gmail takes for these endpoints and far
 * below a schedule interval, so it cannot cut off a slow-but-working reply and
 * cannot let a dead one outlive the run that made it. Timing out is a failure
 * like any other here: it reaches the caller with a code, nothing is marked
 * seen, and the next run picks the same messages up.
 */
export const REQUEST_TIMEOUT_MS = 30000

/**
 * A 200 that parsed but is not the shape Gmail documents.
 *
 * Reading it anyway throws a `TypeError` whose `code` is `undefined`, so a
 * caller switching on `e.code` falls through every named branch and files the
 * run under whatever its default arm does. Same class of mistake as an
 * unparseable body, so it lands on the same code.
 */
function unexpectedShape(what) {
  return new GmailError('gmail_unexpected', `Gmail returned an unexpected ${what}`)
}

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * The Gmail search term for "not older than this", as `after:YYYY/MM/DD`.
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
 *   caller's `fetched_ids` dedup cannot recover a message that was never
 *   listed. Every evening between local 17:00 and midnight, that mailbox sweeps
 *   clean and reports "found nothing".
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
 * is the caller's frontier: `since` is a stored watermark a previous run
 * earned, and a watermark is a single instant while a run is an interval. The
 * sweep layer keeps the frontier no newer than the listing that earned it, and
 * this coarse window is the margin on the other side -- it re-opens far enough
 * back that a message which landed near the boundary, or a clock that moved
 * between the two runs, is listed again rather than passed over. An exact
 * `after:<frontier>` removes that margin, and what falls through it is not
 * delayed but skipped: the caller's dedup cannot recover a message that was
 * never listed. Erring wide costs a re-listing that lands on the dedup, which
 * is why every bound in this function errs wide.
 *
 * An absent or unparseable `since` yields an empty string, and the caller then
 * sends no `q` at all rather than a query that matches nothing.
 *
 * It stays in this file, and stays exported, because `list` no longer builds a
 * window of its own: the caller passes whatever `q` it wants, and this is the
 * one window that has been argued out. AI Signal imports it from here.
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

/** Readable text out of an HTML mail part. The result is a plain inert string. */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** A 403 reason string that means "the grant does not cover this", not "slow down". */
function isScopeReason(reason) {
  return reason.includes('ermission') || reason.includes('cope')
}

/**
 * Gmail base64url. Invalid input decodes to nonsense rather than throwing,
 * which is deliberate: one unreadable part must not abort a whole sweep.
 */
function decode(data) {
  if (!data) return ''
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

/**
 * A part's media type without its parameters, lowercased. Gmail labels a part
 * `text/plain; charset=UTF-8` as often as bare `text/plain`, and an exact
 * case-sensitive comparison reads the parameterised form as "not text" and
 * returns an empty body for a message that had one.
 */
function mediaType(part) {
  return String(part?.mimeType || '').split(';')[0].trim().toLowerCase()
}

/**
 * Gather the text bodies out of a payload tree, however deeply it nests.
 *
 * A text part with a `size` and an `attachmentId` but no inline `data` is a
 * body Gmail is holding at the attachments endpoint. Skipping it silently would
 * make it look exactly like a message with no text part at all, so it is
 * counted: `out.detached` is how the caller tells "nothing to read" from "there
 * is something to read and it is not in this reply".
 */
function collect(part, out) {
  if (!part) return
  if (Array.isArray(part.parts)) for (const p of part.parts) collect(p, out)

  const type = mediaType(part)
  if (type !== 'text/plain' && type !== 'text/html') return
  if (part.body?.data) {
    if (type === 'text/plain') out.plain.push(decode(part.body.data))
    else out.html.push(decode(part.body.data))
    return
  }
  if (part.body?.attachmentId) out.detached += 1
}

/**
 * Split a `From` header into a display name and an address. A header with no
 * angle brackets is all address and no name, which is how Gmail renders a
 * sender that sent none.
 */
function parseFrom(from) {
  const m = from.match(/^(.*?)\s*<([^>]+)>$/)
  if (!m) return { fromName: '', fromEmail: from }
  return { fromName: m[1].replace(/^"|"$/g, ''), fromEmail: m[2] }
}

/** Gmail's epoch-milliseconds string as an ISO instant, or null if it is not one. */
function sentAtFrom(internalDate) {
  // `!internalDate` is not covered by the invalid-date check below: '' and 0
  // both coerce to the epoch, and 1970 is a wrong answer rather than no answer.
  // Everything else -- a word, Infinity, a value past the Date range -- lands on
  // Invalid Date, so one check is enough for all of them.
  if (!internalDate) return null
  const d = new Date(Number(internalDate))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * One Gmail Message resource as plain text plus the few fields a reader needs.
 *
 * `text/plain` wins where a message carries both, but only when it actually
 * carries something: a `multipart/alternative` whose plain part is a bare
 * newline, an empty decode or other whitespace would otherwise throw away
 * the HTML sibling holding the entire newsletter, and the message would be
 * recorded as read with no content.
 *
 * `textInAttachment` reports that a text part exists but was served at the
 * attachments endpoint rather than inline. With an empty `text` that is a
 * different fact from a message that genuinely has no text part, and the two
 * must not look alike.
 *
 * `withTo` adds the `To` header, and only the draft path asks for it. An
 * incoming message's recipient list is deliberately not readable (design spec
 * 4.3): whoever holds it is one step from building an outgoing recipient list
 * out of it, and that step is the one the outbound section exists to forbid. A
 * draft is the operator's own letter and the release check has to compare the
 * addresses standing in Gmail against the ones the row recorded, so there the
 * header is the point rather than a leak.
 *
 * `threadId`, `labelIds` and `sizeEstimate` are carried but not required: none
 * of the three is something a later fetch or a dedup turns on, so an absent one
 * is reported as absent ('' , [] and null) instead of failing a message that is
 * otherwise complete. `id` is the opposite and is checked, because it is what
 * the caller dedups on.
 */
function projectMessage(j, { withTo = false } = {}) {
  // The id is what the caller dedups on. Passing `undefined` through would
  // put a message in the store that no later sweep can recognise.
  if (typeof j?.id !== 'string' || !j.id) throw unexpectedShape('message with no id')
  // `format=full` always carries a payload, so an absent one is a broken
  // reply rather than a message with nothing in it. Reading it anyway
  // returns empty text and no attachment flag, which is exactly what a
  // genuine PDF-only newsletter returns; its siblings below already refuse
  // a payload of the wrong type, and this is the same failure.
  if (!j.payload || typeof j.payload !== 'object' || Array.isArray(j.payload)) throw unexpectedShape('message payload')
  const rawHeaders = j.payload.headers
  if (rawHeaders != null && !Array.isArray(rawHeaders)) throw unexpectedShape('message payload with no headers array')

  const headers = Object.fromEntries((rawHeaders || []).map((h) => [String(h?.name || '').toLowerCase(), h?.value || '']))
  const { fromName, fromEmail } = parseFrom(headers.from || '')

  const out = { plain: [], html: [], detached: 0 }
  collect(j.payload, out)
  const plain = out.plain.join('\n')
  const text = plain.trim() ? plain : stripHtml(out.html.join('\n'))

  const message = {
    id: j.id,
    threadId: typeof j.threadId === 'string' ? j.threadId : '',
    labelIds: Array.isArray(j.labelIds) ? j.labelIds.filter((l) => typeof l === 'string') : [],
    subject: headers.subject || '',
    fromName,
    fromEmail,
    sentAt: sentAtFrom(j.internalDate),
    text,
    textInAttachment: out.detached > 0,
    sizeEstimate: Number.isFinite(j.sizeEstimate) ? j.sizeEstimate : null,
  }
  if (withTo) message.to = headers.to || ''
  return message
}

export function createGmail({ getToken, fetchImpl = fetch }) {
  /**
   * One authenticated request. `failCode` is the code for "this operation
   * failed" and is used for every status that is not a token or scope problem,
   * so the caller learns which call broke as well as how.
   *
   * `method` and `body` are the write half and default to a plain GET, so the
   * reads that came over from AI Signal read exactly as they did there. A
   * `body` is serialised as JSON and nothing else: no caller-supplied string
   * ever reaches a URL through this function except an id, which is
   * percent-encoded by its call site.
   *
   * The whole exchange runs under one deadline -- see REQUEST_TIMEOUT_MS. The
   * timer is armed before the token is asked for and cleared only once the body
   * has been read, so the token refresh, a reply that never arrives and a reply
   * that arrives and then stalls mid-stream are all cut off alike. Whatever the
   * abort surfaces as (a rejected fetch, a rejected `json()`, a `TypeError`
   * from a fetch double that ignores the signal), the `aborted` flag is what
   * names it, not the error's own class or message.
   *
   * The two stages are bounded by different means, and only one of them is a
   * cancellation. The Gmail request gets the signal, so the deadline really
   * ends it. `getToken` is the host's and its own fetch never sees this signal,
   * so that stage is bounded by racing the wait: the call fails on time and the
   * host's token request is left running until it settles by itself. Abandoned,
   * not cancelled -- see REQUEST_TIMEOUT_MS.
   */
  async function call(path, failCode, { method = 'GET', body } = {}) {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS)
    const timedOut = (what = 'Gmail') => new GmailError('gmail_timeout', `${what} did not answer within ${REQUEST_TIMEOUT_MS} ms`)
    const tokenTimedOut = () => timedOut('the Google token endpoint')
    // The losing half of the token race. `Promise.race` attaches a handler to
    // it, so an abort that arrives after the token did is a settled rejection
    // rather than an unhandled one.
    const abandoned = new Promise((_resolve, reject) => {
      deadline.signal.addEventListener('abort', () => reject(tokenTimedOut()), { once: true })
    })
    /**
     * The error to throw at an exit that never reads the reply's body.
     *
     * On a real undici fetch an unread body holds its connection open until the
     * response is garbage collected, and clearing the timer in `finally` frees
     * nothing. These exits are done with the request, so they end it: the same
     * controller that carries the deadline is what releases the body. The 403
     * branch below reads its body already and needs none of this.
     */
    const endingIt = (err) => { deadline.abort(); return err }
    try {
      let token
      try {
        token = await Promise.race([getToken(), abandoned])
      } catch (e) {
        // The deadline first, for the reason the fetch catch below checks it
        // first: a run abandoned on time is not a credential the operator has
        // to go and reconnect. Otherwise the host names its own failures, and
        // anything unrecognised is still a failure of the token stage, so it
        // lands on the code that sends the user to reconnect rather than on a
        // code that blames Gmail.
        if (deadline.signal.aborted) throw tokenTimedOut()
        const code = TOKEN_CODES.has(e?.message) ? e.message : 'gmail_refresh_failed'
        throw new GmailError(code, e?.message)
      }

      const init = { method, headers: { authorization: `Bearer ${token}` }, signal: deadline.signal }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }

      let res
      try {
        res = await fetchImpl(`${BASE}${path}`, init)
      } catch (e) {
        // DNS, TLS, a dropped socket. Named so it cannot be mistaken for a
        // reply -- and the deadline first, so a run abandoned on time is not
        // filed as a transport error nobody can act on.
        if (deadline.signal.aborted) throw timedOut()
        throw new GmailError('gmail_unexpected', `Gmail request failed: ${e?.message || e}`)
      }

      if (res.status === 401) throw endingIt(new GmailError('gmail_token_invalid', 'Gmail rejected the access token'))
      if (res.status === 403) {
        const body403 = await res.json().catch(() => ({}))
        if (deadline.signal.aborted) throw timedOut()
        const reason = body403?.error?.errors?.[0]?.reason || ''
        throw new GmailError(isScopeReason(reason) ? 'gmail_scope_missing' : failCode, reason || 'HTTP 403')
      }
      if (!res.ok) throw endingIt(new GmailError(failCode, `HTTP ${res.status}`))
      // `users.drafts.delete` answers 204 with no body at all, and `json()` on
      // nothing rejects with a SyntaxError this function would then have to
      // report as `gmail_unexpected` -- a named failure for a call that
      // succeeded. A 204 carries no body to release either, so nothing is
      // aborted on the way out.
      if (res.status === 204) return {}

      let parsed
      try {
        parsed = await res.json()
      } catch (e) {
        // A proxy or sign-in interstitial answering 200 with HTML. Left unwrapped
        // this rejects with a bare SyntaxError whose `code` is undefined, and a
        // caller switching on the code would file the run as "nothing found".
        if (deadline.signal.aborted) throw timedOut()
        throw new GmailError('gmail_unexpected', `Gmail returned a body that is not JSON: ${e?.message || e}`)
      }
      // Parsing successfully is not the same as parsing into an object: a
      // literal `null`, a number or an array all parse, and every field read
      // after this would then throw uncoded.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unexpectedShape('JSON body that is not an object')
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * The address of the mailbox this credential opens, from
     * `users.getProfile`.
     *
     * It is the half of a source identity that a label id cannot supply: user
     * label ids are minted per mailbox, so the same id in two accounts is two
     * different sources, and the host stores one Google refresh token per
     * purpose -- disconnecting and reconnecting a different account swaps the
     * whole mailbox without anything the operator typed changing. The caller
     * keys its frontier on this together with the label id.
     *
     * Deliberately not memoised anywhere: a cached address outlives exactly the
     * reconnect it exists to notice, and would answer for a mailbox this
     * credential no longer opens. It costs one request per run, alongside the
     * label lookup and before the per-message fetches, so it is off the hot
     * path without being kept.
     *
     * An absent or empty `emailAddress` is a shape failure rather than an
     * anonymous mailbox: passed through it would become half of a frontier key
     * shared with every other unreadable profile.
     */
    async mailbox() {
      const j = await call('/profile', 'gmail_profile_failed')
      if (typeof j.emailAddress !== 'string' || !j.emailAddress) throw unexpectedShape('profile with no emailAddress')
      return j.emailAddress
    },

    /**
     * Every label in the mailbox, as `[{ id, name, type }]`.
     *
     * The whole list rather than one lookup by name, because the caller is the
     * only side that knows which name it wants, and matching there keeps the
     * one property the old `labelId` was built around: the comparison stays
     * EXACT. Gmail allows two labels differing only in case, so folding the
     * case could silently read the wrong one, and this method makes folding
     * impossible by never comparing at all -- it hands back both spellings and
     * lets the caller pick.
     *
     * A reply with no `labels` array is a broken reply, and it must not be
     * reported as an empty mailbox: an empty list here means the caller will
     * find no match and conclude the label does not exist, which sends the
     * operator off to create a label that already exists.
     *
     * An entry with no usable `id` or `name` refuses the WHOLE list rather than
     * being dropped from it, and that is the same argument one level down. An
     * absent id becomes `undefined` in a `labelIds=` query string and the
     * listing that comes back is a listing of something else; a dropped entry
     * is indistinguishable from a label the mailbox does not have. `type`
     * ('system' or 'user') is informational -- nothing branches on it -- so an
     * absent one is reported as '' rather than failing the list.
     */
    async labels() {
      const j = await call('/labels', 'gmail_list_failed')
      if (!Array.isArray(j.labels)) throw unexpectedShape('label list with no labels array')
      return j.labels.map((l) => {
        if (typeof l?.id !== 'string' || !l.id) throw unexpectedShape('label with no id')
        if (typeof l.name !== 'string' || !l.name) throw unexpectedShape('label with no name')
        return { id: l.id, name: l.name, type: typeof l.type === 'string' ? l.type : '' }
      })
    },

    /**
     * One page of message ids: `{ ids, nextCursor, complete, stoppedOn }`.
     *
     * `nextCursor` is Gmail's own `nextPageToken`, passed back out untouched and
     * taken back in untouched. This module never builds one and never reads
     * inside one.
     *
     * `complete` is the field the operator's existing Gmail MCP server cannot
     * answer: it has maxResults and no page token, so a caller that gets its cap
     * back cannot tell "this is all of them" from "there is more and it was
     * cut". The AI Signal frontier turns on exactly that bit.
     *
     * The invariant, pinned by a test:
     *   complete === (nextCursor === null) === (stoppedOn === null)
     * Three names for one fact, kept because callers use different halves: the
     * sweep uses the bit, an agent uses the cursor, the log uses which bound.
     *
     * The loop always sends at least one request -- `ids` starts empty and
     * `limit` is at least 1 -- so an empty `ids` always means Gmail was asked
     * and had nothing, never that nothing was asked.
     *
     * `q` goes to Gmail literally. There is no fuzzy threshold, no natural
     * language rewriting and no automatic "enhanced" mode, so the same `q`
     * names the same set until the mailbox changes. An empty `q` sends no
     * query parameter at all rather than an empty one.
     */
    async list({ labelIds = [], q = '', max, cursor = null } = {}) {
      const limit = readWholeNumber('max', max, { min: 1, max: 500, fallback: 50 })
      const ids = []
      let pageToken = cursor == null ? '' : readString('cursor', cursor, { max: 4096, code: 'gmail_kurzor_ervenytelen' })
      let stoppedOn = null

      for (let page = 0; ; page += 1) {
        // The cap first: when both bounds land on the same page, the caller's
        // own limit is the one it can act on.
        if (ids.length >= limit) { stoppedOn = 'cap'; break }
        if (page >= MAX_PAGES) { stoppedOn = 'page_ceiling'; break }

        const qs = new URLSearchParams({ maxResults: String(Math.min(100, limit - ids.length)) })
        // labelIds is an array, read by readArray one layer up. A comma
        // separated string here would iterate its characters; see readArray's
        // comment.
        for (const id of labelIds) qs.append('labelIds', id)
        if (q) qs.set('q', q)
        if (pageToken) qs.set('pageToken', pageToken)

        const body = await call(`/messages?${qs}`, 'gmail_list_failed')
        if (body.messages != null && !Array.isArray(body.messages)) throw unexpectedShape('message list with no messages array')
        // A page entry with no id is not an id. Pushing `undefined` would put a
        // hole in the list that only surfaces as a failed fetch much later.
        for (const m of body.messages || []) if (m?.id) ids.push(m.id)

        pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : ''
        // Gmail says there is nothing after this page, so the walk is complete
        // -- whichever bound would have stopped it next.
        if (!pageToken) break
      }

      // Gmail treats maxResults as a hint, so trim rather than trust it.
      return { ids: ids.slice(0, limit), nextCursor: pageToken || null, complete: pageToken === '', stoppedOn }
    },

    /** One message as plain text plus the few fields a reader needs. See projectMessage. */
    async get(id) {
      return projectMessage(await call(`/messages/${encodeURIComponent(id)}?format=full`, 'gmail_fetch_failed'))
    },

    /**
     * Create a draft from an already-built RFC 5322 message, base64url encoded
     * (`mime.mjs` builds it; nothing here composes one).
     *
     * `draftId` is checked because every later step -- reading the draft back
     * for the release check, sending it, discarding it -- is addressed by it,
     * and a row that recorded `undefined` names a draft nobody can reach.
     * `messageId` here is the id of the message WHILE IT SITS IN DRAFTS, not
     * the id it gets when it is sent; that one comes back from `sendDraft`.
     * Nothing keys on this one, so an absent one is reported as '' rather than
     * failing a draft that was created.
     */
    async createDraft({ raw }) {
      const j = await call('/drafts', 'gmail_draft_failed', { method: 'POST', body: { message: { raw } } })
      if (typeof j.id !== 'string' || !j.id) throw unexpectedShape('draft with no id')
      return { draftId: j.id, messageId: typeof j.message?.id === 'string' ? j.message.id : '' }
    },

    /**
     * A draft as it stands in Gmail right now, with its `To` header.
     *
     * The release path reads this rather than the stored row on purpose: the
     * operator may have edited the draft in their own client between the
     * writing and the click, and the whole point of the confirmation hash is
     * that it is computed over what is actually there (design spec 5.4).
     */
    async getDraft(draftId) {
      const j = await call(`/drafts/${encodeURIComponent(draftId)}?format=full`, 'gmail_draft_failed')
      if (typeof j.id !== 'string' || !j.id) throw unexpectedShape('draft with no id')
      return { draftId: j.id, ...projectMessage(j.message, { withTo: true }) }
    },

    /**
     * Send a draft. The only call in this module that puts a message in front
     * of a stranger, and the only one whose result is not recoverable.
     *
     * `messageId` is required rather than tolerated: it is the record that the
     * letter went out, it is what the outbound row stores, and a send that came
     * back without one leaves the row unable to say what happened. Failing here
     * is the honest answer -- the caller learns the reply was not the documented
     * shape rather than being told the send worked with nothing to show for it.
     */
    async sendDraft(draftId) {
      const j = await call('/drafts/send', 'gmail_send_failed', { method: 'POST', body: { id: draftId } })
      if (typeof j.id !== 'string' || !j.id) throw unexpectedShape('sent message with no id')
      return { messageId: j.id }
    },

    /**
     * Delete a draft. Answers 204 with no body, which `call` returns as `{}`.
     *
     * It shares `gmail_draft_failed` with the other two draft calls rather than
     * getting a code of its own, because the caller's remedy is the same for
     * all three and the discard path already says which step it was on.
     */
    async deleteDraft(draftId) {
      await call(`/drafts/${encodeURIComponent(draftId)}`, 'gmail_draft_failed', { method: 'DELETE' })
    },

    /**
     * Add and remove labels on one message.
     *
     * The reply is the updated message, and the labels it comes back with are
     * what the caller should believe rather than the lists it sent: Gmail may
     * refuse part of a change, and reporting the request back as if it were the
     * outcome is the same false report this module refuses everywhere else.
     */
    async modifyLabels(id, { addLabelIds = [], removeLabelIds = [] } = {}) {
      const j = await call(`/messages/${encodeURIComponent(id)}/modify`, 'gmail_cimkezes_sikertelen', {
        method: 'POST',
        body: { addLabelIds, removeLabelIds },
      })
      if (typeof j.id !== 'string' || !j.id) throw unexpectedShape('modified message with no id')
      return { id: j.id, labelIds: Array.isArray(j.labelIds) ? j.labelIds.filter((l) => typeof l === 'string') : [] }
    },
  }
}

/**
 * The one place a Gmail client is built in production. `state.clientFactory` is
 * the test seam, declared on the shared state in index.mjs so it is visible
 * beside setup()'s own keys rather than hidden here.
 *
 * `OAUTH_PURPOSE` lives here rather than in a reading or writing layer because
 * both of those need a client and neither may depend on the other. One
 * constant, one place: `health.mjs` asks `hasGoogleCredential` about this same
 * purpose, and two copies would be two places to drift apart.
 */
export const OAUTH_PURPOSE = 'gmail'

export function clientFor(state) {
  if (state.clientFactory) return state.clientFactory()
  return createGmail({ getToken: () => state.oauth.getGoogleAccessToken(OAUTH_PURPOSE), fetchImpl: state.fetchImpl || undefined })
}
