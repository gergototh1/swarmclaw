import { refuse } from './hibak.mjs'

/**
 * The refusal discipline, in one place.
 *
 * ONE RULE: an absent argument means the caller has no opinion and gets the
 * default; anything present that cannot be honoured is refused BY NAME -- the
 * argument's name and the rule it broke -- and never coerced into a value the
 * caller did not send. `Number(x) || 50`, `String(x)`, `[].concat(x)` and
 * silent truncation are what these readers replace. Each of those turns a
 * caller's mistake into a value the caller never asked for, and on this module
 * the caller is often an agent assembling arguments out of text a stranger
 * wrote.
 *
 * "Present" and "absent" are decided the same way in every reader: `undefined`
 * and `null` are absent, and a string that is blank once trimmed is absent too
 * -- a settings field the operator cleared stores '' rather than undefined, and
 * a blank is no opinion rather than the opinion "the empty string".
 * `readString` is the one exception and says so at its own doc comment.
 *
 * THE ONE EXCEPTION TO THE RULE is `readWholeNumber`'s upper bound, which caps
 * rather than refuses. Its doc comment carries the argument for why capping is
 * honest exactly there and nowhere else.
 *
 * WHAT A REFUSAL MESSAGE CARRIES: the argument's name, the rule, and -- for a
 * closed vocabulary -- the whole list of what may be sent, so a caller that
 * misspelt a member can see what it may send. Never the value that was refused.
 * `readArray` names the rejected value's `typeof` rather than the value, which
 * is a word out of a closed set of eight and not a byte of the caller's text.
 *
 * The messages are Hungarian and unaccented, matching the design plan's own
 * spelling of `readArray` below: these strings reach an MCP tool result and an
 * error field, where the module has no say over the encoding of what renders
 * them.
 */

/** No opinion: undefined, null, or a string with nothing but whitespace in it. */
const absent = (raw) => raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')

/**
 * A string argument. `max` is a refusal bound, NOT a truncation point: a text
 * longer than the bound is refused, because a cut text is a different text and
 * the caller would go on as if it had sent the whole one. That matters most for
 * a search query -- `LIKE`-style matching on a shortened query matches a
 * superset of what the full one would have matched -- and it matters for a mail
 * body for a plainer reason: half a letter is not the letter.
 *
 * A blank string is absent for the `required` check and is returned AS SENT
 * otherwise. An optional subject of '' is a subject the caller chose to leave
 * blank, and turning it into undefined would hand the caller its default in
 * place of the choice it made.
 */
export function readString(what, raw, { required = false, max = 4000, code = 'gmail_argumentum_alak' } = {}) {
  if (raw === undefined || raw === null) {
    if (required) refuse(code, `${what} kotelezo`)
    return undefined
  }
  if (typeof raw !== 'string') refuse(code, `${what} szoveg kell legyen, nem ${Array.isArray(raw) ? 'array' : typeof raw}`)
  if (required && raw.trim() === '') refuse(code, `${what} nem lehet ures`)
  if (raw.length > max) refuse(code, `${what} legfeljebb ${max} karakter lehet, ${raw.length} erkezett`)
  return raw
}

/**
 * One value out of a closed vocabulary, or `fallback` when the caller named
 * none. The message names the whole list; it does not echo what was sent.
 *
 * `code` lets a call site give the refusal a name of its own where the design
 * spec assigns one -- `gmail_allapot_ismeretlen` for an outbox filter,
 * `gmail_formatum_nem_kuldheto` for a message format the projection may not
 * hand out. A named refusal is what lets a caller tell "I asked for a format
 * that does not exist" from "I asked for a format this module will not give",
 * and those two are different facts.
 */
export function readEnum(what, raw, allowed, { fallback = undefined, code = 'gmail_argumentum_alak' } = {}) {
  if (absent(raw)) return fallback
  if (typeof raw !== 'string' || !allowed.includes(raw)) refuse(code, `${what} ezek egyike kell legyen: ${allowed.join(', ')}`)
  return raw
}

/**
 * A whole number of at least `min`, capped at `max` when `max` is given.
 *
 * BELOW `min` IS REFUSED, ABOVE `max` IS CAPPED, and the asymmetry is the one
 * exception this module makes to its own rule. A `max` that is a page size can
 * be PARTLY honoured and cannot mislead, because the listing hands back a
 * `complete` field that says whether the page was cut short: a caller that asks
 * for 5000 ids, gets 500 and reads `complete: false` knows exactly what it has.
 * A value below `min` buys nothing by being guessed at -- a limit of 0, of -1 or
 * of 2.5 names no page anybody wanted -- so it is refused with the rest. This
 * is the same split `extensions/aisignal/src/reads.mjs` makes, for the same
 * reason, and it is the only place in this module where a present value is
 * silently changed.
 *
 * Only a number or a numeric string is considered. `Number` alone would accept
 * `true` as 1 and `[5]` as 5, and a caller that sent either did not mean a
 * limit of one or five; it made a mistake this layer would then hide.
 * "Numeric string" is whatever `Number()` parses, which is wider than it sounds
 * -- `'0x10'` reads as 16, `'1e3'` as 1000, `' 5 '` as 5 -- and it is not
 * narrowed to decimal digits, because each of those still names a whole number
 * inside the caller's bounds and refusing the spelling would refuse an honest
 * value for a cosmetic reason.
 *
 * `Number.isSafeInteger`, not `Number.isInteger`: the latter is true for `1e21`
 * and `1e300`, which is how an unbounded argument like an offset reaches
 * `LIMIT ? OFFSET ?` and raises SQLite's own `datatype mismatch` instead of a
 * named refusal here.
 *
 * `min` is required and `max` is optional; a call site that gives neither a
 * number where one is needed has a bug rather than a caller problem, so that
 * throws a plain Error instead of refusing the caller.
 */
export function readWholeNumber(what, raw, { min, max, fallback, code = 'gmail_argumentum_alak' }) {
  if (absent(raw)) return fallback
  if (!Number.isFinite(min)) throw new Error(`readWholeNumber(${what}) needs a numeric min bound`)
  if (max !== undefined && !Number.isFinite(max)) throw new Error(`readWholeNumber(${what}) needs max to be a number when it is given`)
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    refuse(code, `${what} egesz szam kell legyen, legalabb ${min}, nem ${Array.isArray(raw) ? 'array' : typeof raw}`)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min) refuse(code, `${what} egesz szam kell legyen, legalabb ${min}`)
  return max === undefined ? n : Math.min(n, max)
}

/**
 * A list argument. Absent, null or blank means no opinion and yields []; a
 * present value that is not an array is refused rather than wrapped.
 *
 * Wrapping is the tempting shortcut and it is the bug: `labelIds: 'INBOX'`
 * wrapped into `['INBOX']` looks helpful right up to the caller that passes
 * `'INBOX,UNREAD'`, and iterating that string yields its characters. The
 * query then carries one label filter per letter, and Gmail answers an empty
 * list rather than an error.
 *
 * `max` is a refusal bound, like `readString`'s: a recipient list cut to its
 * first N entries is a different letter, and the caller would believe it had
 * addressed everyone it named.
 */
export function readArray(what, raw, { required = false, max = 50, code = 'gmail_argumentum_alak' } = {}) {
  if (raw == null || raw === '') {
    if (required) refuse(code, `${what} kotelezo`)
    return []
  }
  if (!Array.isArray(raw)) refuse(code, `${what} tomb kell legyen, nem ${typeof raw}`)
  if (raw.length > max) refuse(code, `${what} legfeljebb ${max} elem lehet, ${raw.length} erkezett`)
  return raw
}

/**
 * A boolean, and only a boolean: `'true'`, `1`, `'yes'` and `'false'` are all
 * refused rather than read, because a caller that sent a string did not send a
 * flag -- and `'false'` is the one that makes this rule worth having, since it
 * is truthy and the coercion every shortcut reaches for would turn "no" into
 * "yes".
 */
export function readBoolean(what, raw, { fallback, code = 'gmail_argumentum_alak' } = {}) {
  if (absent(raw)) return fallback
  if (typeof raw !== 'boolean') refuse(code, `${what} true vagy false kell legyen, nem ${Array.isArray(raw) ? 'array' : typeof raw}`)
  return raw
}
