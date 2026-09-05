/**
 * The refusal discipline, in one place.
 *
 * A missing argument means the caller has no opinion and gets the default.
 * Anything present that cannot be honoured is refused BY NAME -- the argument's
 * name and what it needed to be -- and never coerced into something the caller
 * did not send. `Number(x) || 5`, `String(x)` and silent capping are what these
 * readers replace: each of those turns a caller's mistake into a value the
 * caller never asked for, and a tool that is handed the wrong scene list or the
 * wrong limit reports on something other than what was asked.
 *
 * "Present" and "absent" are decided the same way in every reader here:
 * `undefined` and `null` are absent, and a string that is blank once trimmed is
 * absent too -- a form field the operator cleared stores '' rather than
 * undefined, and a blank is no opinion, not the opinion "the empty string".
 * `readString` is the one exception and says so: a blank optional string is
 * returned as sent, because there the blank may be the value.
 *
 * What the refusal message carries: the argument's name and the rule it broke,
 * built from this module's own vocabulary and the closed lists the caller
 * passed in. Never the value that was refused. The values that reach these
 * readers are tool arguments an agent assembled from text strangers wrote, and
 * a message that quoted one would carry that text into a log line and into the
 * agent's next prompt as if it were this module's own words.
 */

/**
 * A refusal with a fixed code the caller may branch on and a message it may
 * show. `extra` is spread into the tool's error object beside them (a running
 * render's id, an existing proposal's id), so the caller can act on a refusal
 * rather than only read it.
 */
export class VideoError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'VideoError'
    this.code = code
    this.extra = extra
  }
}

/** Throws a VideoError. A function rather than `throw new` at each site so a refusal reads as one verb. */
export function refuse(code, message, extra = {}) {
  throw new VideoError(code, message, extra)
}

/**
 * An ExtensionContractError, recognised by shape: the host's class lives in
 * `src/lib/server/extensions/extension-contracts.ts`, and an extension may not
 * import from the host's `src/`. The three string fields are the ones the host
 * sets on every such error and on no other.
 */
function isContractError(err) {
  return err instanceof Error && typeof err.code === 'string' && typeof err.extensionId === 'string' && typeof err.consumerId === 'string'
}

/**
 * Runs a tool body and turns its refusals into the answer the spec defines.
 *
 * A VideoError becomes `{ error: { code, message, ...extra } }`: the agent
 * reads it, and the host's tool-failure counter does not see it, because a
 * refusal is the tool working as designed. A contract failure is a refusal
 * too, named after the extension that failed: `szerzodes_hiba` when the
 * provider threw (`provider_threw` is the host's code for that), and
 * `szerzodes_hianyzik` for every other contract code -- the provider is not
 * installed, is disabled, or does not serve the version this module pinned.
 * The provider's own message is appended when it carried one, because that is
 * the text that says which of the provider's own limits was hit.
 *
 * Any other throw is a bug in this module and propagates as one, so the host's
 * failure counter sees it instead of the agent reading it as a refusal and
 * carrying on.
 */
export async function guard(fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof VideoError) return { error: { code: err.code, message: err.message, ...err.extra } }
    if (isContractError(err)) {
      const code = err.code === 'provider_threw' ? 'szerzodes_hiba' : 'szerzodes_hianyzik'
      const cause = err.cause instanceof Error ? err.cause.message : ''
      return { error: { code, message: cause ? `${err.message}: ${cause}` : err.message, extension: err.extensionId } }
    }
    throw err
  }
}

/** No opinion: undefined, null, or a string with nothing but whitespace in it. */
const absent = (raw) => raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')

/**
 * A string argument. `max` is a refusal bound, not a truncation point: a text
 * longer than the caller can store is refused, because a cut text is a
 * different text and the caller would go on as if it had the whole one.
 *
 * A blank string is absent for the `required` check, and is returned as sent
 * otherwise: an optional title of '' is a title the caller chose to leave
 * blank, and turning it into undefined would hand the caller its default in
 * place of the operator's choice.
 */
export function readString(what, raw, { required = false, max = 4000 } = {}) {
  if (raw === undefined || raw === null) {
    if (required) refuse('argumentum_hibas', `${what} kötelező`)
    return undefined
  }
  if (typeof raw !== 'string') refuse('argumentum_hibas', `${what}: szöveg kell`)
  if (required && raw.trim() === '') refuse('argumentum_hibas', `${what} nem lehet üres`)
  if (raw.length > max) refuse('argumentum_hibas', `${what}: legfeljebb ${max} karakter`)
  return raw
}

/**
 * One of a closed list. The message names the whole list, so a caller that
 * misspelt a member sees what it may send; it does not echo what was sent.
 * `code` lets a caller give the refusal a name of its own (`tipus_ismeretlen`)
 * where the spec assigns one.
 */
export function readEnum(what, raw, allowed, { required = false, fallback = undefined, code = 'argumentum_hibas' } = {}) {
  if (absent(raw)) {
    if (required) refuse(code, `${what} kötelező: ${allowed.join(', ')}`)
    return fallback
  }
  if (typeof raw !== 'string' || !allowed.includes(raw)) refuse(code, `${what}: ${allowed.join(', ')} egyike kell`)
  return raw
}

/**
 * A whole number inside [min, max]. Above `max` is REFUSED, not capped: a
 * capped value is a value the caller did not send, and a limit is the one
 * argument where "more than you asked for" and "less than you asked for" are
 * both wrong answers to a question that was asked precisely.
 *
 * A number or a numeric string is considered; anything else is refused before
 * `Number()` sees it, because `Number(true)` is 1 and `Number([5])` is 5, and
 * a caller that sent either made a mistake this reader would otherwise hide.
 * "Numeric string" is what `Number()` parses -- `'0x10'`, `'1e3'` and `' 5 '`
 * included -- and is not narrowed to decimal digits: each of those names a
 * whole number inside the caller's bounds, and refusing the spelling would
 * refuse an honest value for a cosmetic reason. `Number.isSafeInteger` rather
 * than `isInteger`, so `1e21` cannot pass as a whole number and reach SQLite.
 *
 * `min` and `max` are the caller's bounds and both are required whenever a
 * value is present: a reader with no bounds would pass any safe integer, and
 * this module's promise is that every number that gets through was checked
 * against a bound somebody chose. Missing bounds are a bug at the call site,
 * so they throw a plain Error rather than refusing the caller.
 */
export function readWholeNumber(what, raw, { min, max, fallback, code = 'argumentum_hibas' }) {
  if (absent(raw)) return fallback
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error(`readWholeNumber(${what}) needs numeric min and max bounds`)
  if (typeof raw !== 'number' && typeof raw !== 'string') refuse(code, `${what}: egész szám kell ${min} és ${max} között`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) refuse(code, `${what}: egész szám kell ${min} és ${max} között`)
  return n
}

/**
 * A list. `max` is a refusal bound for the same reason `readString`'s is: a
 * scene list cut to its first N entries is a different video.
 */
export function readArray(what, raw, { required = false, max = 1000 } = {}) {
  if (absent(raw)) {
    if (required) refuse('argumentum_hibas', `${what} kötelező`)
    return undefined
  }
  if (!Array.isArray(raw)) refuse('argumentum_hibas', `${what}: lista kell`)
  if (raw.length > max) refuse('argumentum_hibas', `${what}: legfeljebb ${max} elem`)
  return raw
}

/**
 * A boolean, and only a boolean: `'true'`, `1` and `'yes'` are refused, not
 * read as true, because a caller that sent a string did not send a flag.
 */
export function readBoolean(what, raw, { fallback }) {
  if (absent(raw)) return fallback
  if (typeof raw !== 'boolean') refuse('argumentum_hibas', `${what}: true vagy false kell`)
  return raw
}

/**
 * The calling agent, from the session the host hands the tool; '' when the
 * session has none. Never from an argument: the self-review gate and the
 * author columns are keyed on this, and an id the agent could type is an id
 * the agent could choose.
 *
 * The host's `Session.agentId` is `string | null`, so '' is a real answer
 * here, not a default: it says the session carries no agent. A tool whose
 * gate needs an agent refuses on '' by name (`agent_hianyzik`) rather than
 * comparing two blanks and letting a self-review through.
 */
export function agentIdOf(ctx) {
  const id = ctx && ctx.session ? ctx.session.agentId : null
  return typeof id === 'string' && id !== '' ? id : ''
}

/** The session id the host hands the tool, or '' when there is none. Recorded beside the agent id; gates nothing. */
export function sessionIdOf(ctx) {
  const id = ctx && ctx.session ? ctx.session.id : null
  return typeof id === 'string' ? id : ''
}
