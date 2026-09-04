import { Buffer } from 'node:buffer'

/**
 * Gmail REST client for AI Signal.
 *
 * Two rules shape every line here.
 *
 * The first: a sweep that found nothing and a sweep that could not look are
 * different facts, and the caller must be able to tell them apart. So no path
 * in this module answers a failure with an empty list. Every way this can go
 * wrong throws a `GmailError` carrying a named `code`, and the codes are a
 * closed set the rest of the extension catches by name:
 *
 *   gmail_token_missing     no Google credential stored (from the host)
 *   gmail_token_unreadable  the stored refresh token cannot be decrypted (host)
 *   gmail_token_revoked     the refresh token was revoked or expired (host)
 *   gmail_refresh_failed    the token stage failed some other way (host)
 *   gmail_token_invalid     Gmail rejected the access token with 401
 *   gmail_scope_missing     Gmail answered 403 for a missing scope
 *   gmail_label_missing     the label list came back and holds no such name
 *   gmail_list_failed       listing labels or messages failed
 *   gmail_fetch_failed      fetching one message failed
 *   gmail_unexpected        transport error, a reply that is not JSON, a reply
 *                           that parses but is not the documented shape, or a
 *                           caller-side argument that cannot be honoured
 *
 * The same rule shapes the two results that are not a single value:
 * `listIds` returns `{ ids, truncated }` because a list cut short by the page
 * bound is not the same fact as a list Gmail finished; and `getMessage`
 * returns `textInAttachment` because a message whose text part was served as
 * an attachment is not the same fact as a message with no text at all.
 *
 * The second: a newsletter's content is data, never instruction. Nothing here
 * evaluates, follows or re-serialises what a message says. `stripHtml` removes
 * `<script>` and `<style>` because their contents are markup rather than
 * readable prose, not as a security control, and everything it returns is an
 * inert string.
 *
 * The access token arrives through an injected `getToken` rather than by
 * importing the host's OAuth module, so the whole client is testable against a
 * fake `fetch` with no credential anywhere near it.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * Hard ceiling on how many list pages one `listIds` call will ever request.
 *
 * The working bound is the requested cap, not this number. Gmail applies `q`
 * inside a scan window, so a filtered page can under-deliver -- it may answer
 * with one id, or with an empty `messages` array and a `nextPageToken`, when
 * the page of the label holds little that matches. A page is therefore worth as
 * little as one id, and a cap of N can genuinely need N pages; bounding the
 * loop at a fixed 25 pages truncated a request for 200 down to 25 without
 * saying so. This ceiling only stops an enormous cap from becoming thousands of
 * requests.
 *
 * Whichever bound bites, the result says so: `truncated` is true when the loop
 * stopped on the page bound while Gmail still had pages. The ids collected are
 * genuinely found ids, but "these are all of them" would be a false statement.
 */
const MAX_PAGES = 200

export class GmailError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'GmailError'
    this.code = code
  }
}

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
 * this module is allowed to make. UTC offsets run from -12:00 to +14:00, so
 * local midnight of the previous UTC day falls between (D-1)T10:00Z and
 * (D-1)T12:00Z -- always at or before the start of day D, and therefore always
 * at or before `since`. One day back is enough for every timezone on earth, and
 * the cost is re-listing at most a day of messages the caller already has ids
 * for.
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

/** Readable text out of an HTML mail part. The result is a plain inert string. */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The codes the host's `getGoogleAccessToken` throws. They pass through
 * untouched because each one tells the user a different thing to do, and only
 * the host knows which applies.
 */
const TOKEN_CODES = new Set(['gmail_token_missing', 'gmail_token_unreadable', 'gmail_token_revoked', 'gmail_refresh_failed'])

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

export function createGmail({ getToken, fetchImpl = fetch }) {
  /**
   * One authenticated GET. `failCode` is the code for "this operation failed"
   * and is used for every status that is not a token or scope problem, so the
   * caller learns which call broke as well as how.
   */
  async function call(path, failCode) {
    let token
    try {
      token = await getToken()
    } catch (e) {
      // The host names its own failures. Anything unrecognised is still a
      // failure of the token stage, so it lands on the code that sends the user
      // to reconnect rather than on a code that blames Gmail.
      const code = TOKEN_CODES.has(e?.message) ? e.message : 'gmail_refresh_failed'
      throw new GmailError(code, e?.message)
    }

    let res
    try {
      res = await fetchImpl(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } })
    } catch (e) {
      // DNS, TLS, a dropped socket. Named so it cannot be mistaken for a reply.
      throw new GmailError('gmail_unexpected', `Gmail request failed: ${e?.message || e}`)
    }

    if (res.status === 401) throw new GmailError('gmail_token_invalid', 'Gmail rejected the access token')
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}))
      const reason = body?.error?.errors?.[0]?.reason || ''
      throw new GmailError(isScopeReason(reason) ? 'gmail_scope_missing' : failCode, reason || 'HTTP 403')
    }
    if (!res.ok) throw new GmailError(failCode, `HTTP ${res.status}`)

    let body
    try {
      body = await res.json()
    } catch (e) {
      // A proxy or sign-in interstitial answering 200 with HTML. Left unwrapped
      // this rejects with a bare SyntaxError whose `code` is undefined, and a
      // caller switching on the code would file the run as "nothing found".
      throw new GmailError('gmail_unexpected', `Gmail returned a body that is not JSON: ${e?.message || e}`)
    }
    // Parsing successfully is not the same as parsing into an object: a literal
    // `null`, a number or an array all parse, and every field read after this
    // would then throw uncoded.
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw unexpectedShape('JSON body that is not an object')
    return body
  }

  return {
    /**
     * The id of the label with exactly this name. The comparison is exact:
     * Gmail allows two labels differing only in case, so folding the case could
     * silently sweep the wrong mailbox.
     *
     * A reply with no `labels` array is a broken reply, not an answer about
     * this name -- reporting it as `gmail_label_missing` would send the
     * operator off to create a label that already exists. Only a list that
     * arrived and holds no match is `gmail_label_missing`, and neither is ever
     * an empty sweep.
     */
    async labelId(name) {
      const j = await call('/labels', 'gmail_list_failed')
      if (!Array.isArray(j.labels)) throw unexpectedShape('label list with no labels array')
      const hit = j.labels.find((l) => l?.name === name)
      if (!hit) throw new GmailError('gmail_label_missing', `no Gmail label named "${name}"`)
      return hit.id
    },

    /**
     * Message ids under a label, newest first, at most `max` of them, as
     * `{ ids, truncated }`.
     *
     * `truncated` is true when the page bound stopped the walk while Gmail
     * still had pages: every id in `ids` was found, but there may be more.
     * Without it a bounded walk and a finished one look identical, and the
     * caller would record a partial sweep as a complete one.
     *
     * `max` must be a positive number. A blank `maxMessages` setting arrives
     * here as `''` (which `Number` turns into 0) or as `undefined` (NaN), and
     * answering either with an empty list would report a clean sweep that never
     * sent a request -- exactly the false negative this guard exists to
     * prevent. It cannot be deferred to the caller: by the time the value is
     * here, "asked for nothing deliberately" and "the operator typed nothing"
     * are the same value, and this module owns the rule that an empty list
     * means Gmail was asked and had nothing. No caller in the extension asks
     * for zero messages, so nothing is lost by refusing zero as well.
     */
    async listIds({ labelId, since, max }) {
      const limit = Number(max)
      if (!Number.isFinite(limit) || limit < 1) {
        throw new GmailError('gmail_unexpected', `listIds needs a positive message cap, got ${JSON.stringify(max) ?? String(max)}`)
      }

      // One page can carry as little as one matching id, so the cap is the
      // page bound; MAX_PAGES only keeps a huge cap from becoming a huge
      // number of requests.
      const maxPages = Math.min(Math.ceil(limit), MAX_PAGES)
      const ids = []
      let pageToken = ''
      let truncated = false

      for (let page = 0; ids.length < limit; page += 1) {
        if (page >= maxPages) {
          truncated = true
          break
        }

        const q = new URLSearchParams({ labelIds: labelId, maxResults: String(Math.min(100, limit - ids.length)) })
        const sq = sinceQuery(since)
        if (sq) q.set('q', sq)
        if (pageToken) q.set('pageToken', pageToken)

        const j = await call(`/messages?${q}`, 'gmail_list_failed')
        if (j.messages != null && !Array.isArray(j.messages)) throw unexpectedShape('message list with no messages array')
        // A page entry with no id is not an id. Pushing `undefined` would put a
        // hole in the list that only surfaces as a failed fetch much later.
        for (const m of j.messages || []) if (m?.id) ids.push(m.id)

        pageToken = typeof j.nextPageToken === 'string' ? j.nextPageToken : ''
        // Gmail says there is nothing after this page, so the walk is complete.
        if (!pageToken) break
      }

      // Gmail treats maxResults as a hint, so trim rather than trust it.
      return { ids: ids.slice(0, limit), truncated }
    },

    /**
     * One message as plain text plus the few headers a signal needs.
     *
     * `text/plain` wins where a message carries both, but only when it actually
     * carries something: a `multipart/alternative` whose plain part is a bare
     * newline, an empty decode or other whitespace would otherwise throw away
     * the HTML sibling holding the entire newsletter, and the message would be
     * recorded as read with no content.
     *
     * `textInAttachment` reports that a text part exists but was served at the
     * attachments endpoint rather than inline. With an empty `text` that is a
     * different fact from a message that genuinely has no text part, and the
     * two must not look alike.
     */
    async getMessage(id) {
      const j = await call(`/messages/${encodeURIComponent(id)}?format=full`, 'gmail_fetch_failed')

      // The id is what the caller dedups on. Passing `undefined` through would
      // put a message in the store that no later sweep can recognise.
      if (typeof j.id !== 'string' || !j.id) throw unexpectedShape('message with no id')
      if (j.payload != null && (typeof j.payload !== 'object' || Array.isArray(j.payload))) throw unexpectedShape('message payload that is not an object')
      const rawHeaders = j.payload?.headers
      if (rawHeaders != null && !Array.isArray(rawHeaders)) throw unexpectedShape('message payload with no headers array')

      const headers = Object.fromEntries((rawHeaders || []).map((h) => [String(h?.name || '').toLowerCase(), h?.value || '']))
      const { fromName, fromEmail } = parseFrom(headers.from || '')

      const out = { plain: [], html: [], detached: 0 }
      collect(j.payload, out)
      const plain = out.plain.join('\n')
      const text = plain.trim() ? plain : stripHtml(out.html.join('\n'))

      return {
        id: j.id,
        subject: headers.subject || '',
        fromName,
        fromEmail,
        sentAt: sentAtFrom(j.internalDate),
        text,
        textInAttachment: out.detached > 0,
      }
    },
  }
}
