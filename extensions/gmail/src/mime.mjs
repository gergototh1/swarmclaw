import { Buffer } from 'node:buffer'

import { readArray, readString } from './args.mjs'
import { refuse } from './hibak.mjs'

/**
 * The outgoing message, as bytes. One shape, one rule, nothing else.
 *
 * THE RULE: A HEADER VALUE MAY NOT CONTAIN `\r` OR `\n`. If a subject, an
 * address or a replied-to Message-ID carries a line break, `buildMime` refuses
 * the whole message with `gmail_mezo_nem_tamogatott`. It does not escape it, it
 * does not strip it and it does not cut the value at the break.
 *
 * This is the only place in the extension where text of foreign origin is put
 * into a structure, so it is the only place an injection could take a shape. A
 * subject that reads
 *
 *     Havi jelentes\r\nBcc: valaki@masholt.example
 *
 * is, in a builder that concatenates, a second recipient nobody chose. Escaping
 * would be the tempting repair and it is the wrong one: an escaped break is a
 * subject the sender did not write, delivered as if they had, and the caller is
 * told the message went out as composed. Refusing is the only answer that is
 * true in both directions -- nothing goes out, and the caller is told why.
 *
 * Cutting at the break has the same defect one step later, which is why
 * `readString` refuses an over-long value rather than truncating it: half a
 * letter is not the letter.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - `From`. Gmail fills it from the authenticated account. A `From` this
 *     module wrote would be a second place an address could come from, and the
 *     outbound section has exactly one (design spec 5.2).
 *   - `Cc` and `Bcc`. The recipient set may not grow anywhere but the book, and
 *     a reply does not inherit one (5.3).
 *   - attachments and `text/html`. A single `text/plain` part is the whole
 *     format this version sends; a caller that asks for either is refused by
 *     name one layer up, under `gmail_mezo_nem_tamogatott`.
 *   - `Message-ID`. Gmail mints it. Writing one would be claiming an identity
 *     for a message that does not have it yet.
 *
 * `buildMime` returns the RFC 5322 message as a string, NOT as the base64url
 * blob Gmail's `raw` field wants: `base64url` is exported beside it and the
 * caller applies it. Two functions rather than one because the plain text is
 * what a test can read and a person can diff, and the encoding is one call.
 */

const CRLF = '\r\n'

/**
 * Backstop bounds, in bytes of the caller's own string.
 *
 * They are NOT the product bounds -- `kimeno.mjs` refuses a subject over 200
 * and a body over 100000 characters, by name, before anything reaches here.
 * These are an order of magnitude above those, so in a working system they
 * never fire; they exist because this function must not be the one place that
 * accepts an unbounded string, and because it is exported and callable by a
 * later file that forgets.
 */
const MAX_CIM = 320
const MAX_TARGY = 2000
const MAX_TORZS = 200000
const MAX_UZENET_ID = 1000

/**
 * How many source bytes one RFC 2047 encoded-word may carry.
 *
 * Two bounds meet here and the tighter one wins. RFC 2047 allows 75 characters
 * per encoded-word; RFC 5322 asks that a whole header LINE stay within 78, and
 * the first line of a folded subject also carries `Subject: `, which is 9. So
 * the budget is 78 - 9 - 12 for `=?UTF-8?B?` and `?=`, leaving 57 characters of
 * base64, which carries 42 source bytes -- base64 of 42 bytes is exactly 56
 * characters, and 43 would need 60.
 *
 * `Subject` is the only header this file ever encodes, so it is the only name
 * that has to fit; the longer names below are fixed ASCII values that are never
 * folded.
 */
const MAX_ENCODED_BYTES = 42

/** Printable US-ASCII, which is what a header line may carry unencoded. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/**
 * A caller string that is about to become a header value.
 *
 * The shape check and the line-break check are separate refusals on purpose: a
 * subject that arrived as a number is a caller assembling the wrong argument,
 * and a subject with a newline in it is the case this file exists for. Neither
 * message repeats the value -- the text was written by a stranger, and an error
 * that quoted it would carry that text into a log line and an agent's next
 * prompt as this module's own words.
 */
function headerValue(what, raw, max) {
  const value = readString(what, raw, { required: true, max })
  if (value.includes('\r') || value.includes('\n')) {
    refuse('gmail_mezo_nem_tamogatott', `${what} nem tartalmazhat sortorest`)
  }
  return value
}

/**
 * A subject as a header value: as written when it is printable ASCII, and RFC
 * 2047 base64 encoded-words when it is not.
 *
 * Hungarian subjects are not ASCII, and a raw UTF-8 subject line is not
 * something Gmail accepts. Encoding only when it is needed keeps an English
 * subject readable in the bytes, which is what a person diffing a draft wants.
 *
 * Long subjects are folded into several encoded-words joined by CRLF and a
 * space, which is RFC 5322 folding white space rather than a line break in the
 * value: a decoder concatenates adjacent encoded-words back into one subject.
 * The split is taken on a code point boundary, so no multi-byte character is
 * cut in half.
 */
function encodeSubject(targy) {
  if (PRINTABLE_ASCII.test(targy)) return targy
  const chunks = []
  let chunk = ''
  let bytes = 0
  for (const ch of targy) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > MAX_ENCODED_BYTES) {
      chunks.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += ch
    bytes += size
  }
  if (chunk !== '') chunks.push(chunk)
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join(`${CRLF} `)
}

/**
 * The replied-to message's own `Message-ID`, angle-bracketed if it is not
 * already.
 *
 * This string was written by whoever sent the message being answered, so it is
 * foreign text on the same footing as a subject, and it goes through the same
 * line-break refusal. Nothing else in it can end a header line, so nothing else
 * in it can start one.
 */
function referenceId(raw) {
  const id = headerValue('valaszUzenetId', raw, MAX_UZENET_ID)
  return id.startsWith('<') && id.endsWith('>') ? id : `<${id}>`
}

/** Gmail's `raw` field wants base64url. A non-string is a bug at the call site, not a caller's refusal. */
export function base64url(s) {
  if (typeof s !== 'string') throw new TypeError('base64url takes a string')
  return Buffer.from(s, 'utf8').toString('base64url')
}

/**
 * One `text/plain; charset=UTF-8` message, RFC 5322 headers and a base64 body.
 *
 * `cimek` are addresses, already resolved from the recipient book by
 * `cimzettek.mjs` -- this function never sees a handle and never sees the text
 * that asked for one. An empty list is refused rather than sent: a message with
 * no `To` header goes nowhere, and answering "created" for it would be a false
 * report.
 *
 * `inReplyTo` is absent for a new message and is the replied-to `Message-ID`
 * for an answer. When it is present both `In-Reply-To` and `References` carry
 * it, which is what threads the reply in the recipient's client.
 *
 * The body is base64 rather than quoted-printable or 8bit because a Hungarian
 * body is not ASCII and base64 is the encoding with no line-length trap in it;
 * the lines are wrapped at 76 characters, which is what RFC 2045 asks for.
 */
export function buildMime({ cimek, targy, torzs, inReplyTo }) {
  const addresses = readArray('cimek', cimek, { required: true })
  if (addresses.length === 0) refuse('gmail_cimzett_hianyzik', 'a levelnek nincs cimzettje')
  const to = addresses.map((cim, i) => headerValue(`cimek[${i}]`, cim, MAX_CIM))

  const subject = encodeSubject(headerValue('targy', targy, MAX_TARGY))
  const body = readString('torzs', torzs, { required: true, max: MAX_TORZS })
  const reference = inReplyTo === undefined || inReplyTo === null ? null : referenceId(inReplyTo)

  const headers = [
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    ...(reference === null ? [] : [`In-Reply-To: ${reference}`, `References: ${reference}`]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]

  const encoded = Buffer.from(body, 'utf8').toString('base64')
  const lines = encoded.match(/.{1,76}/g) || ['']
  return `${headers.join(CRLF)}${CRLF}${CRLF}${lines.join(CRLF)}${CRLF}`
}
