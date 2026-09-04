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
 *   gmail_label_missing     no Gmail label has that exact name
 *   gmail_list_failed       listing labels or messages failed
 *   gmail_fetch_failed      fetching one message failed
 *   gmail_unexpected        transport error, or a reply that is not JSON
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
 * How many list pages one `listIds` call will ever request.
 *
 * Gmail may answer with an empty `messages` array and a `nextPageToken` when a
 * page of the label holds nothing matching `q`. A loop that only stops once it
 * has collected `max` ids never terminates on that reply, so the page count is
 * the real bound. Hitting it truncates the result rather than emptying it: the
 * ids collected so far were genuinely found.
 */
const MAX_PAGES = 25

export class GmailError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'GmailError'
    this.code = code
  }
}

/**
 * The Gmail search term for "not older than this". Gmail's `after:` takes a
 * date, not an instant, so the time of day is dropped; the day is read in UTC
 * for a stable result regardless of where the host runs. The consequence is
 * that a sweep near local midnight may re-see a message it already has, which
 * is why the caller keeps its own list of fetched ids.
 *
 * An absent `since` yields an empty string, and the caller then sends no `q` at
 * all rather than a query that matches nothing.
 */
export function sinceQuery(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `after:${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
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

/** Gather the text bodies out of a payload tree, however deeply it nests. */
function collect(part, out) {
  if (!part) return
  if (Array.isArray(part.parts)) for (const p of part.parts) collect(p, out)
  if (part.mimeType === 'text/plain' && part.body?.data) out.plain.push(decode(part.body.data))
  if (part.mimeType === 'text/html' && part.body?.data) out.html.push(decode(part.body.data))
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
  const ms = Number(internalDate)
  if (!internalDate || !Number.isFinite(ms)) return null
  const d = new Date(ms)
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

    try {
      return await res.json()
    } catch (e) {
      // A proxy or sign-in interstitial answering 200 with HTML. Left unwrapped
      // this rejects with a bare SyntaxError whose `code` is undefined, and a
      // caller switching on the code would file the run as "nothing found".
      throw new GmailError('gmail_unexpected', `Gmail returned a body that is not JSON: ${e?.message || e}`)
    }
  }

  return {
    /**
     * The id of the label with exactly this name. The comparison is exact:
     * Gmail allows two labels differing only in case, so folding the case could
     * silently sweep the wrong mailbox. A name that does not match is
     * `gmail_label_missing`, never an empty sweep.
     */
    async labelId(name) {
      const j = await call('/labels', 'gmail_list_failed')
      const hit = (j.labels || []).find((l) => l.name === name)
      if (!hit) throw new GmailError('gmail_label_missing', `no Gmail label named "${name}"`)
      return hit.id
    },

    /**
     * Message ids under a label, newest first, at most `max` of them.
     *
     * A `max` of zero or less means the caller asked for nothing, so this
     * returns an empty list without a request. That is the one empty result
     * here that does not mean "looked and found nothing" -- every other empty
     * list came back from Gmail.
     */
    async listIds({ labelId, since, max }) {
      const limit = Number(max)
      if (!Number.isFinite(limit) || limit <= 0) return []

      const ids = []
      let pageToken = ''
      for (let page = 0; page < MAX_PAGES && ids.length < limit; page += 1) {
        const q = new URLSearchParams({ labelIds: labelId, maxResults: String(Math.min(100, limit - ids.length)) })
        const sq = sinceQuery(since)
        if (sq) q.set('q', sq)
        if (pageToken) q.set('pageToken', pageToken)

        const j = await call(`/messages?${q}`, 'gmail_list_failed')
        for (const m of j.messages || []) if (m?.id) ids.push(m.id)
        pageToken = j.nextPageToken || ''
        if (!pageToken) break
      }
      // Gmail treats maxResults as a hint, so trim rather than trust it.
      return ids.slice(0, limit)
    },

    /**
     * One message as plain text plus the few headers a signal needs.
     *
     * `text/plain` wins where a message carries both, because it is what the
     * sender wrote; the HTML branch is a rendering of it. A message with no
     * text part at all yields an empty `text`, which is a true statement about
     * that message rather than a failure of the fetch.
     */
    async getMessage(id) {
      const j = await call(`/messages/${encodeURIComponent(id)}?format=full`, 'gmail_fetch_failed')

      const headers = Object.fromEntries((j.payload?.headers || []).map((h) => [String(h?.name || '').toLowerCase(), h?.value || '']))
      const { fromName, fromEmail } = parseFrom(headers.from || '')

      const out = { plain: [], html: [] }
      collect(j.payload, out)
      const text = out.plain.length ? out.plain.join('\n') : stripHtml(out.html.join('\n'))

      return {
        id: j.id,
        subject: headers.subject || '',
        fromName,
        fromEmail,
        sentAt: sentAtFrom(j.internalDate),
        text,
      }
    },
  }
}
