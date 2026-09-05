/**
 * The closed error set of the gmail extension, and the verbs that use it:
 * `refuse` and `guard`, plus `TOKEN_CODES` at the foot of the file -- the
 * four-code subset the Gmail client passes through from the host untouched.
 *
 * Every refusal this module can produce is named here, in one array, so a
 * reviewer can read the whole vocabulary without walking the module. Two rules
 * govern the spelling, and both are the reason this list is not tidied:
 *
 * 1. A CODE THAT ALREADY STANDS IN A STORED ROW NEVER CHANGES ITS SPELLING.
 *    The twelve `gmail_*_failed` / `gmail_token_*` / `gmail_timeout` /
 *    `gmail_unexpected` / `gmail_scope_missing` / `gmail_label_missing` codes
 *    come over unchanged from the Gmail client this module inherits, which was
 *    `extensions/aisignal/src/gmail.mjs` until AI Signal moved onto this
 *    module's `mailbox` contract and deleted it: AI Signal's stored sweep rows
 *    carry them, its page renders them, and its test suite speaks them. They are
 *    English where the newer codes are Hungarian, and that inconsistency is the
 *    cost of not invalidating rows that are already on disk.
 *
 * 2. `google_oauth_client_missing` IS THE ONE CODE WITHOUT THE `gmail_` PREFIX,
 *    and deliberately so. It is the host's own string
 *    (`src/lib/server/oauth/google.ts`, and the 409 the connect route answers
 *    with), it is what the operator will paste into a search box when the
 *    connect button does not work, and renaming it here would mean the module
 *    and the host describe one situation with two words.
 *
 * The array is the vocabulary, not a runtime check: nothing validates a code
 * against it at call time. `test/args.test.mjs` greps `src/` for every
 * `refuse(` call site and fails on a code that is not in this list, which
 * catches a typo at the moment it is written rather than at the moment a
 * caller tries to branch on it.
 *
 * The health codes do not belong here. Nothing throws those; they describe a
 * state the page renders a sentence for, and they get their own list
 * (`HEALTH_CODES`, arriving with the health method). The two lists will overlap
 * where a state also has a refusal (`google_oauth_client_missing`,
 * `gmail_scope_missing`, `gmail_token_revoked`), and that is not a duplication
 * to collapse: what can be thrown and what a status bar can say are different
 * questions about one module.
 */

/**
 * Every code this module throws. Frozen, and read as a closed set.
 *
 * Grouped by where each code comes from rather than alphabetically, because
 * the group is the fact a reader needs: the first group may not be respelled,
 * the second may.
 */
export const HIBA_KODOK = Object.freeze([
  // --- Inherited from the Gmail client, spelling frozen by stored AI Signal rows ---
  /** No Google credential is stored for this purpose; the operator has not connected the mailbox. */
  'gmail_token_missing',
  /** The stored grant does not cover the operation that was attempted. */
  'gmail_scope_missing',
  /**
   * A label name the caller asked for is not one this mailbox has.
   *
   * Nothing in this module raises it, and that is deliberate rather than an
   * omission: `labels()` hands the whole list over and only the CALLER knows
   * which name it wanted and how it wants to compare, so the caller is where
   * the refusal is raised -- `extensions/aisignal/src/mailbox.mjs` does exactly
   * that. It is named here because it is the shared vocabulary: AI Signal's
   * stored sweep rows carry this spelling.
   */
  'gmail_label_missing',
  /** `users.messages.list` did not answer with a listing. */
  'gmail_list_failed',
  /** `users.messages.get` did not answer with a message. */
  'gmail_fetch_failed',
  /** `users.getProfile` did not answer with a mailbox address. */
  'gmail_profile_failed',
  /** The request deadline elapsed. Distinct from a transport failure on purpose. */
  'gmail_timeout',
  /** A 200 that parsed but is not the shape Gmail documents, or an unrecognised transport failure. */
  'gmail_unexpected',
  /** The stored credential is not readable as a credential. */
  'gmail_token_invalid',
  /** The stored credential could not be decrypted or parsed. */
  'gmail_token_unreadable',
  /** Google says the grant is gone: revoked, or expired under a Testing consent screen. */
  'gmail_token_revoked',
  /** The refresh round trip failed for a reason the host did not name. */
  'gmail_refresh_failed',

  // --- This module's own codes ---
  /** A `cursor` was present and is not a page token this module can carry. */
  'gmail_kurzor_ervenytelen',
  /** A `q` longer than the bound. Refused rather than shortened: a cut query matches a different set. */
  'gmail_lekerdezes_tul_hosszu',
  /** `format` was present and asked for something the projection may not hand out ('raw', 'full', 'metadata'). */
  'gmail_formatum_nem_kuldheto',
  /** A label the caller may not add or remove (TRASH, SPAM, SENT, DRAFT). */
  'gmail_cimke_tiltott',
  /** A label id that this mailbox does not have. */
  'gmail_cimke_ismeretlen',
  /** A draft was asked for with neither a recipient handle nor a message to reply to. */
  'gmail_cimzett_hianyzik',
  /** A recipient handle that is not in the address book. */
  'gmail_cimzett_ismeretlen',
  /** A recipient that is an address rather than a book handle. The shape a prompt injection takes. */
  'gmail_cimzett_cim_literal',
  /** A recipient handle the operator has retired. */
  'gmail_cimzett_visszavonva',
  /** Both `cimzettHandlek` and `valaszUzenetId` were given; the two name the recipient two different ways. */
  'gmail_cimzett_es_valasz_egyutt',
  /** The replied-to message carries no `From` address this module can parse. It does not guess. */
  'gmail_valasz_cimzett_olvashatatlan',
  /** A field that is present but cannot be honoured: `cc`, `bcc`, `replyTo`, `melleklet`, `html`. */
  'gmail_mezo_nem_tamogatott',
  /** A subject longer than the bound. */
  'gmail_targy_tul_hosszu',
  /** A body longer than the bound. */
  'gmail_szoveg_tul_hosszu',
  /** Today's draft budget is spent. */
  'gmail_piszkozat_keret_kimerult',
  /** Today's release budget is spent. */
  'gmail_kiadas_keret_kimerult',
  /** No outbound row carries that id. */
  'gmail_kimeno_ismeretlen',
  /** The outbound row is not in the state this operation needs. A second release is refused, never answered "already sent". */
  'gmail_kimeno_allapot',
  /** The confirmation hash does not match the draft standing in Gmail: the page showed something that no longer holds. */
  'gmail_lap_elavult',
  /**
   * `drafts.send` was asked for and did not answer, so nobody can say whether
   * the letter left. NOT a synonym for failure: this code exists because
   * reporting a send that may have happened as a failure is a false report, and
   * a send is the one thing in this module that cannot be taken back. The row
   * is closed `bizonytalan`, the cause travels as `okKod`, and the only place
   * the real answer exists is the mailbox's Sent folder.
   */
  'gmail_kiadas_bizonytalan',
  /** An `allapot` filter value outside the closed vocabulary. */
  'gmail_allapot_ismeretlen',
  /** `users.drafts.create` did not answer with a draft. */
  'gmail_draft_failed',
  /** `users.drafts.send` did not answer with a sent message. */
  'gmail_send_failed',
  /** `users.messages.modify` did not apply the label change. */
  'gmail_cimkezes_sikertelen',
  /** An argument is present but not the shape asked for. The default code of the readers in `args.mjs`. */
  'gmail_argumentum_alak',
  /** `guard` maps a host contract failure here, so a contract problem reaches the caller with a code. */
  'gmail_szerzodes_hiba',

  // --- The host's own string, kept verbatim ---
  /** This host has no Google OAuth client id and secret at all, so no consent round trip can start. */
  'google_oauth_client_missing',
])

/**
 * A refusal with a fixed code the caller may branch on and a message it may
 * show. `extra` is spread into the error object beside them (the outbound row's
 * id, the handle that was not in the book), so a caller can act on a refusal
 * rather than only read it.
 *
 * WHAT A MESSAGE MAY CARRY: this module's own words, the argument's name, and
 * the closed vocabulary it broke. Not the value that was refused. Message
 * subjects and bodies here were written by strangers, and a message that quoted
 * one would carry that text into a log line, into an error page and into an
 * agent's next prompt as if it were this module's own words.
 *
 * This class enforces none of that: it stores whatever message it is handed.
 * The rule lives at the call sites, and there is one place it will have to be
 * bent -- a recipient handle, because naming WHICH handle failed is the whole
 * point of refusing a draft as a unit rather than partially. A handle is a
 * caller-supplied string like any other, so the file that names one back owes
 * the check that it matches the address book's own `[a-z0-9-]{1,40}` shape
 * before it repeats it.
 */
export class GmailError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'GmailError'
    this.code = code
    this.extra = extra
  }
}

/** Throws a GmailError. A function rather than `throw new` at each site so a refusal reads as one verb. */
export function refuse(code, message, extra = {}) {
  throw new GmailError(code, message, extra)
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
 * Runs a method body and turns its refusals into the answer the rpc and the
 * MCP shim hand back.
 *
 * A `GmailError` is RETURNED as `{ error: { code, message, ...extra } }` rather
 * than thrown: the caller reads it, and the host's failure counter -- which
 * counts what a method throws -- does not see it, because a refusal is the
 * method working as designed. Any other throw is a bug in this module and
 * propagates as one, so the counter does see that instead of an agent reading a
 * crash as a refusal and carrying on.
 *
 * WHAT THE CONTRACT BRANCH IS AND IS NOT. This module declares no `consumes`
 * (design spec 9.1): it is the bottom of the chain, it takes its credential
 * from the host and its data from Gmail, and it holds no contract handle to
 * call. So on this checkout NOTHING REACHES THAT BRANCH -- it is not covering a
 * failure that happens today. It is here because the alternative to a code is
 * an uncoded throw: if this module ever consumes a contract, the day it does is
 * the day a `provider_missing` would otherwise leave the rpc without an `error`
 * object at all. It maps every contract code to one name rather than the two
 * the video module splits them into, because a single sentence -- "a contract
 * this module depends on did not answer" -- is all a caller here could act on;
 * the host's `reason` travels as `why` so the operator still gets the fact that
 * differs (`provider_missing` and `provider_disabled` have different remedies).
 */
export async function guard(fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof GmailError) return { error: { code: err.code, message: err.message, ...err.extra } }
    if (isContractError(err)) {
      const cause = err.cause instanceof Error ? err.cause.message : ''
      const why = typeof err.reason === 'string' && err.reason !== '' ? { why: err.reason } : {}
      return {
        error: {
          code: 'gmail_szerzodes_hiba',
          message: cause ? `${err.message}: ${cause}` : err.message,
          extension: err.extensionId,
          ...why,
        },
      }
    }
    throw err
  }
}

/**
 * The four codes the host's `getGoogleAccessToken` throws, as a set the client
 * checks a caught message against.
 *
 * They pass through the client untouched because each one tells the operator a
 * different thing to do -- connect the mailbox, re-enter the encryption key,
 * reconnect a revoked grant, try again -- and only the host knows which
 * applies. Anything the host throws that is NOT in this set is still a failure
 * of the token stage, so it lands on `gmail_refresh_failed` rather than on a
 * code that blames Gmail for a request Gmail never received.
 *
 * A subset of `HIBA_KODOK` rather than four fresh literals, and derived from it
 * by name so a respelling in one place cannot leave the other behind: a code
 * listed here that is not in the closed set would be a code no caller could
 * enumerate.
 */
export const TOKEN_CODES = new Set(
  HIBA_KODOK.filter((code) => code === 'gmail_token_missing' || code === 'gmail_token_unreadable' || code === 'gmail_token_revoked' || code === 'gmail_refresh_failed'),
)
