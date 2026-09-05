import { readArray, readString, readWholeNumber } from './args.mjs'
import { clientFor } from './client.mjs'
import { ervenyesCimAlak, feloldCimzettek } from './cimzettek.mjs'
import { AJTOK as AJTO_SZOTAR, torzsHashOf } from './db.mjs'
import { GmailError, refuse } from './hibak.mjs'
import { base64url, buildMime } from './mime.mjs'

/**
 * The draft: the outbound path, and where it ends.
 *
 * IT ENDS AT A DRAFT. There is no `send` here, none on the contract and none on
 * MCP. A letter leaves this system when a person clicks Release on the
 * `/x/gmail` page, and that step is a later file (`kiadas.mjs`), reachable from
 * the rpc alone.
 *
 * WHY A PERSON, said as narrowly as it is true. Neither door into this module
 * carries a caller identity the host re-checks: a contract handle is a bearer
 * capability whose audience is whoever the consumer passed it to, and the rpc
 * sits behind the app's access key rather than behind a session. So the `ajto`
 * column below records WHICH FILE of this module made the call and not who
 * asked for it, and this module cannot say which agent or which consumer wrote
 * a draft. With nobody to hold responsible for what goes out, a person has to
 * own the output. That is the whole argument; it is not a claim that the
 * credential cannot send. The granted scope can send. What this module has is
 * no path that sends without a person, which is a smaller and truer sentence.
 *
 * WHERE A RECIPIENT MAY COME FROM. Two places, both in this file's reach and
 * neither of them text a stranger wrote: a handle the operator typed into the
 * recipient book (`cimzettek.mjs`), or the envelope `From` Gmail recorded on
 * the message being replied to (`valaszCimzett` below). There is no third, and
 * an address literal where a handle belongs is refused by name AND recorded as
 * an attempt rather than dropped.
 *
 * WHAT THIS FILE DOES WITH UNTRUSTED TEXT. A subject and a body reach it from a
 * caller, and on the reply path a subject reaches it from a stranger. None of
 * it steers anything: no `if` in this file branches on the content of a subject
 * or a body, none of it reaches a filename, a URL, a shell string (this module
 * spawns nothing) or a header it was not meant for, and none of it is repeated
 * into a refusal message. It goes two places, both of them designed for it --
 * `buildMime`, which refuses a header value carrying `\r` or `\n` rather than
 * escaping it, and the `mit` column of an attempt row, which exists so an
 * operator can read what somebody tried.
 */

/**
 * The two doors, as the constants the two calling files pass.
 *
 * `db.mjs` owns the vocabulary as a frozen array and this is the spelling the
 * callers use; `draft` checks its argument against THAT array rather than
 * against this object, so there is one list and this is a view of it. A test
 * pins that the two agree, because two copies of a closed vocabulary is how one
 * of them ends up accepting a value the other does not.
 *
 * IT IS THE DOOR AND NOT THE CALLER. `contract.mjs` will pass `SZERZODES` and
 * `rpc.mjs` will pass `RPC`, each as a constant written in that file, which is
 * what makes this the one field a caller cannot lie about: it is not an
 * argument that reached those files from outside.
 */
export const AJTOK = Object.freeze({ SZERZODES: 'szerzodes', RPC: 'rpc' })

/** How many book handles one draft may name. A letter to eleven people is a mailing, and this module does not do mailings. */
export const MAX_CIMZETT = 10

/** The longest subject, in characters. Refused past it, never cut: a shortened subject is a subject nobody wrote. */
export const MAX_TARGY = 200

/** The longest body, in characters. Same rule, and here it matters most: half a letter is not the letter. */
export const MAX_SZOVEG = 100000

/** The longest `valaszUzenetId`. A bound on nonsense; the safety is that the id is percent-encoded into the path in `client.mjs`. */
const MAX_UZENET_ID = 256

/**
 * The fields a caller may send that this version cannot honour.
 *
 * PRESENT BUT UNHONOURABLE IS REFUSED BY NAME, never ignored. A caller that
 * sends `bcc` and is told the draft was created believes a person it named will
 * receive the letter. That belief is worse than an error, and `cc` and `bcc`
 * are worse again than the rest: the recipient set may not grow anywhere but
 * the book, so a silently dropped `cc` would look like this module quietly
 * doing the right thing when it had in fact been asked to do the wrong one.
 *
 * `replyTo` is here for the same reason it is not honoured on the way in: a
 * header that redirects a reply is exactly the thing the reply path refuses to
 * follow, and writing one on the way out would be this module handing somebody
 * else the trick.
 */
const NEM_TAMOGATOTT = Object.freeze(['cc', 'bcc', 'replyTo', 'html', 'melleklet', 'attachments'])

/** The daily draft budget when the operator has no opinion. Matches the settings field's own default in index.mjs. */
const NAPI_PISZKOZAT_ALAP = 20

/** The keys an attempt row's `mit` renders, and how much of each. Bounded here so a refused 100 000 character body is not built into a string only to be cut. */
const MIT_KULCSOK = Object.freeze(['cimzettHandlek', 'valaszUzenetId', 'targy', 'szoveg', ...NEM_TAMOGATOTT])
const MIT_MEZO_MAX = 500

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * The key of the day's counter row, as a LOCAL date.
 *
 * Local rather than UTC because the budget is the operator's day: a limit that
 * reset at 01:00 or 02:00 local time would look like the counter had failed to
 * turn over. The cost is that the module's idea of a day follows the host's
 * timezone, so a server that moves timezones moves the boundary; nothing else
 * in the module reads this value, so nothing else is affected.
 *
 * Takes the moment as an argument so the rollover is testable without a clock
 * seam on the shared state.
 */
export function napKulcs(at = new Date()) {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/**
 * Writes one refused outbound request to `ext_gmail_kiserletek`.
 *
 * CALLED BEFORE THE REFUSAL REACHES THE CALLER, so a throw cannot take the
 * trace with it. That is the whole point of the table: an injection attempt
 * that gets no further than a refusal is still the most interesting thing that
 * happened today, and the operator only ever learns about it from this row.
 *
 * It does not swallow a storage failure. If this write throws, the module
 * cannot record attempts at all, and replacing that with a quiet refusal would
 * hide a broken audit log behind a working-looking refusal -- which is the one
 * failure this table exists to prevent.
 *
 * `mit` is somebody else's text and is stored as such: `db.mjs` cuts it to
 * 2 000 characters, binds it as a parameter, and nothing branches on it.
 */
export function naploKiserlet(state, { ajto, kod, mit = '' }) {
  return state.repo.insertKiserlet({ ajto, kod, mit })
}

/**
 * What the caller asked for, rendered short, for the attempt row.
 *
 * Only the argument names this module knows, each value cut before it is
 * rendered rather than after: a refused request may carry a very long body, and
 * building the whole thing into a string only for the column to cut it is work
 * done on the failure path for nothing. Every value is turned into a string, a
 * number, a boolean, null or a `<typeof>` word first, so nothing here can throw
 * -- a `BigInt`, a function or a cyclic object would all otherwise take
 * `JSON.stringify` down on the one path that must not fail.
 */
function rovidit(value) {
  if (typeof value === 'string') return value.slice(0, MIT_MEZO_MAX)
  if (Array.isArray(value)) return value.slice(0, MAX_CIMZETT).map(rovidit)
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return `<${typeof value}>`
}

function mitOf(args) {
  const forras = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const mit = {}
  for (const kulcs of MIT_KULCSOK) if (kulcs in forras) mit[kulcs] = rovidit(forras[kulcs])
  return JSON.stringify(mit)
}

/** Whether an argument carries an opinion. The readers' own rule: undefined, null and a blank string are all "no opinion". */
const jelenVan = (raw) => raw !== undefined && raw !== null && !(typeof raw === 'string' && raw.trim() === '')

/**
 * A reply's recipient comes out of the envelope, not out of the message.
 *
 * The `From` address Gmail parsed is the sole recipient. Reply-To is
 * deliberately not honoured: the sender wrote that header, and following it is
 * exactly "a recipient derived from untrusted text" -- the one thing this whole
 * outbound design exists to prevent. Cc is not carried over either, so the
 * circle of recipients cannot grow because a message went to many people.
 *
 * The cost is real and small: someone who set a Reply-To gets the reply at
 * their From address instead. That is less bad than a header that redirects our
 * mail.
 *
 * The address is held to the same shape a typed one is, and an unusable one is
 * refused rather than guessed at. `client.mjs` reports a `From` it could not
 * split as the whole header string, so "no angle brackets and no `@`" arrives
 * here as a value that fails the shape check, which is the refusal the design
 * asks for.
 */
function valaszCimzett(fromEmail) {
  if (!ervenyesCimAlak(fromEmail)) {
    // The header is not repeated. It was written by whoever sent the message
    // being answered, and a refusal that quoted it would carry that text into a
    // log line and into an agent's next prompt as this module's own words.
    refuse('gmail_valasz_cimzett_olvashatatlan', 'a megvalaszolt uzenet From fejleceben nincs olvashato cim')
  }
  return fromEmail
}

/**
 * The original subject with one `Re: ` in front of it.
 *
 * ONE PREFIX, NOT A STACK. The comparison folds case and looks only at the
 * start, so a thread that has been answered four times does not accumulate
 * `Re: Re: Re: Re:`. A subject that already opens with one is passed through
 * exactly as the sender wrote it -- not trimmed, not normalised -- because the
 * outgoing subject should be the bytes that were on the message, and this
 * module has no business tidying somebody else's words.
 */
function valaszTargy(eredeti) {
  const targy = typeof eredeti === 'string' ? eredeti : ''
  return /^\s*re\s*:/i.test(targy) ? targy : `Re: ${targy}`
}

/**
 * The daily draft budget.
 *
 * TAKEN BEFORE THE DRAFT EXISTS, NOT COUNTED AFTER IT. `bumpNapi` raises the
 * counter and answers the day as it now stands, and this compares that answer
 * against the cap -- so the slot is reserved before the `await` that creates the
 * draft rather than counted after it. The other order reads the counter, awaits
 * Gmail and then increments, which lets twenty concurrent calls all read
 * nineteen and all create; that is precisely the runaway consumer this budget
 * exists to stop, so the order is not a detail.
 *
 * THE COST, OWNED: the counter measures SLOTS TAKEN, not drafts created. A call
 * whose Gmail request then fails has spent a slot and produced no draft. That
 * is the safe direction -- the cap can only under-deliver, never over-deliver
 * -- and it is why the read below comes first: a caller that is already at the
 * cap is refused without taking a slot, so a run of refusals cannot drive the
 * day's number past the cap and make the page's remaining count nonsense.
 *
 * WHERE THIS SITS IN THE SEQUENCE, and this is a deliberate departure from the
 * plan's numbering: the budget is taken AFTER every purely local check has
 * passed and immediately before the row is written. The plan puts it earlier,
 * ahead of resolving recipients. Taken there, ten malformed requests out of a
 * newsletter would spend half the operator's day, which hands untrusted text a
 * way to shut the outbound path without ever addressing anybody. Nothing before
 * this point costs a Gmail request except the reply fetch, and no refusal
 * before it costs the operator anything at all.
 *
 * NOT A CROSS-PROCESS LOCK. Two processes on one database can both pass this.
 * Nothing in this extension runs two, and the counter does not pretend
 * otherwise.
 */
function keretetVesz(state) {
  const keret = readWholeNumber('napiPiszkozat', state.settings().napiPiszkozat, { min: 0, fallback: NAPI_PISZKOZAT_ALAP })
  const nap = napKulcs()
  const elotte = state.repo.napi(nap)
  if (elotte.piszkozat >= keret) {
    refuse('gmail_piszkozat_keret_kimerult', `a mai piszkozat-keret betelt: ${elotte.piszkozat}/${keret}`, { nap, keret, mai: elotte.piszkozat })
  }
  const utana = state.repo.bumpNapi(nap, 'piszkozat')
  if (utana.piszkozat > keret) {
    refuse('gmail_piszkozat_keret_kimerult', `a mai piszkozat-keret betelt: ${utana.piszkozat}/${keret}`, { nap, keret, mai: utana.piszkozat })
  }
}

export function createPiszkozat(state) {
  return {
    /**
     * Writes one draft into the operator's Gmail and one row into this module's
     * outbound table.
     *
     * `ajto` is the SECOND POSITIONAL ARGUMENT and never a field of the first,
     * so it cannot arrive from a caller. A value outside the vocabulary is a bug
     * in the file that called this, not a caller's mistake, so it throws a plain
     * Error rather than being refused with a code -- the same split `bumpNapi`
     * makes for a column name.
     *
     * THE ORDER OF THE WRITES IS THE POINT (design spec 12.2): the row is
     * inserted with an empty `gmail_draft_id`, THEN Gmail is asked for the
     * draft, THEN the id is written back. The other way round, a Gmail call that
     * succeeded followed by a row write that failed would leave a draft standing
     * in the mailbox that this module does not know about, cannot show, cannot
     * discard and cannot count -- invisible, and invisible to the operator too.
     * This way the worst case is a row with no draft id, which the page shows as
     * an error and the operator can clear. A visible inconsistency beats a
     * hidden one.
     *
     * The message bytes are built BEFORE the row and before the budget, because
     * `buildMime` refuses a subject carrying a header break and that refusal
     * should cost neither a row nor a slot.
     */
    async draft(args, ajto) {
      if (!AJTO_SZOTAR.includes(ajto)) throw new Error(`draft: unknown door ${JSON.stringify(ajto)}`)
      let sorId = null
      try {
        const kert = args === undefined || args === null ? {} : args
        if (typeof kert !== 'object' || Array.isArray(kert)) refuse('gmail_argumentum_alak', 'a draft argumentuma egy objektum kell legyen')

        const handlek = readArray('cimzettHandlek', kert.cimzettHandlek, { max: MAX_CIMZETT })
        const valaszUzenetId = readString('valaszUzenetId', kert.valaszUzenetId, { max: MAX_UZENET_ID })
        const valasz = jelenVan(valaszUzenetId)

        // 1. Exactly one of the two ways to name a recipient. Both is a caller
        //    that meant two different things; neither is a caller that named
        //    nobody, and a letter with no recipient goes nowhere.
        if (handlek.length > 0 && valasz) {
          refuse('gmail_cimzett_es_valasz_egyutt', 'cimzettHandlek es valaszUzenetId kozul pontosan egy adhato meg')
        }
        if (handlek.length === 0 && !valasz) {
          refuse('gmail_cimzett_hianyzik', 'cimzettHandlek vagy valaszUzenetId kozul az egyik kotelezo')
        }

        // 2. Present but unhonourable, by name. See NEM_TAMOGATOTT.
        for (const mezo of NEM_TAMOGATOTT) {
          if (jelenVan(kert[mezo])) refuse('gmail_mezo_nem_tamogatott', `${mezo} ezen a feluleten nem teljesitheto`, { mezo })
        }

        // 3. The two lengths, each under its own name and neither of them cut.
        //    The shape is read with the reader's own code and the bound lifted
        //    out of the way, so "wrong type" and "too long" stay two facts a
        //    caller can branch on differently.
        const targyNyers = readString('targy', kert.targy, { max: Number.MAX_SAFE_INTEGER })
        if (targyNyers !== undefined && targyNyers.length > MAX_TARGY) {
          refuse('gmail_targy_tul_hosszu', `targy legfeljebb ${MAX_TARGY} karakter lehet, ${targyNyers.length} erkezett`)
        }
        const szoveg = readString('szoveg', kert.szoveg, { required: true, max: Number.MAX_SAFE_INTEGER })
        if (szoveg.length > MAX_SZOVEG) {
          refuse('gmail_szoveg_tul_hosszu', `szoveg legfeljebb ${MAX_SZOVEG} karakter lehet, ${szoveg.length} erkezett`)
        }
        // A new letter has no subject to inherit, so an absent one is a caller
        // that forgot rather than a caller with no opinion. On a reply there IS
        // one to inherit, and the inheritance happens below.
        if (!valasz && !jelenVan(targyNyers)) refuse('gmail_argumentum_alak', 'targy kotelezo, ha nincs valaszUzenetId')

        // 4. The recipients, and on the reply path the subject and the thread
        //    headers with them. This is the only Gmail read the draft path makes.
        let cimzettek
        let inReplyTo
        let targy
        if (valasz) {
          // The CLIENT's `get`, not the reading layer's projection: this needs
          // the `From` and the `Message-ID` header, and the ten-field projection
          // hands out neither the header nor anything a reply is threaded by.
          // It is the one place in this module where a raw header reaches code,
          // and both values are treated as what they are -- the address is held
          // to a shape and the header is refused a line break by `buildMime`.
          const eredeti = await clientFor(state).get(valaszUzenetId, { withRfcMessageId: true })
          cimzettek = [{ handle: '', cim: valaszCimzett(eredeti.fromEmail) }]
          // A message with no Message-ID cannot be threaded by anybody. The
          // reply is still written, without the two headers, rather than
          // refused: the letter is the point and the threading is a courtesy.
          inReplyTo = jelenVan(eredeti.rfcMessageId) ? eredeti.rfcMessageId : undefined
          // A caller's own subject is honoured where it is sent, because a
          // subject is a value this module CAN honour and the rule only refuses
          // what it cannot. Absent, the original's is inherited with one `Re: `.
          targy = jelenVan(targyNyers) ? targyNyers : valaszTargy(eredeti.subject)
        } else {
          cimzettek = feloldCimzettek(state.repo, handlek)
          inReplyTo = undefined
          targy = targyNyers
        }

        const cimek = cimzettek.map((cimzett) => cimzett.cim)
        const raw = base64url(buildMime({ cimek, targy, torzs: szoveg, inReplyTo }))

        keretetVesz(state)

        const torzsHash = torzsHashOf({ cimek, targy, torzs: szoveg })
        const sor = state.repo.insertKimeno({
          allapot: 'piszkozat',
          ajto,
          cimzettHandlek: cimzettek.map((cimzett) => cimzett.handle).filter((handle) => handle !== ''),
          cimzettCimek: cimek,
          valaszUzenetId: valasz ? valaszUzenetId : '',
          targy,
          torzs: szoveg,
          torzsHash,
        })
        sorId = sor.id

        let draftId
        try {
          ({ draftId } = await clientFor(state).createDraft({ raw }))
        } catch (err) {
          // The row is the trace from here on, so the failure is written onto
          // it instead of into the attempts table: one fact, one place. The
          // page groups by state, so a row left reading `piszkozat` would offer
          // a Release button for a draft that does not exist.
          state.repo.setKimenoHiba(sorId, err instanceof GmailError ? err.code : 'gmail_unexpected', String(err?.message || ''))
          throw err
        }
        // Deliberately outside the catch above. A draft that WAS created and
        // whose id could not be stored must not be recorded as a failure -- that
        // would be a false report in the other direction, and the letter is
        // standing in the mailbox either way.
        state.repo.setKimenoDraftId(sorId, draftId)

        return { kimenoId: sorId, gmailDraftId: draftId, cimzettek, targy, torzsHash }
      } catch (err) {
        // Every refusal that happened BEFORE a row existed leaves an attempt
        // row, written before the error reaches the caller. Once a row exists
        // it is the record, and writing both would be one event counted twice.
        // A throw that is not a `GmailError` is a bug in this module rather than
        // a refused request, and it is not filed as one.
        if (err instanceof GmailError && sorId === null) naploKiserlet(state, { ajto, kod: err.code, mit: mitOf(args) })
        throw err
      }
    },
  }
}
