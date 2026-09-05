import { readArray, readEnum, readString } from './args.mjs'
import { clientFor } from './client.mjs'
import { refuse } from './hibak.mjs'

/**
 * The reading surface of the gmail extension, and the projection that decides
 * what a caller gets back.
 *
 * WHY THE PROJECTION IS THIS MODULE'S DECISION AND NOT THE HOST'S.
 * The host does not clone, freeze or inspect a value crossing a contract, and
 * that is deliberate: cleaning it there would let every provider believe its
 * data had been handled when nothing had. So which fields cross is the
 * provider's choice, and this file is where this extension makes it --
 * `extensions/aisignal/src/contract.mjs` and its `SIGNAL_CONTRACT_COLUMNS`
 * settled the same question for signals, and two facts drove it there and both
 * apply harder here:
 *
 *   - A consumer's contract handle is a BEARER CAPABILITY. The host mints it
 *     for the extension that declared `consumes`, never re-checks who actually
 *     calls, and passes nothing to this side that says who is asking. So the
 *     audience of a field is not the consumer named on the operator's extension
 *     card; it is whoever that consumer hands the handle to. Nothing below acts
 *     as though a caller identity had arrived, because none does.
 *   - A published contract version is a commitment. Adding a field is cheap and
 *     removing one after a consumer has shipped is a breaking change, so a field
 *     that should not have crossed cannot simply be taken back later.
 *
 * And this module carries more than any provider on this branch: WHOLE MESSAGE
 * BODIES, written by strangers. So the gate is an explicit allowlist,
 * `UZENET_MEZOK`, and `projectUzenet` copies field by field out of it. Nothing
 * here spreads a client result into an answer.
 *
 * THAT MATTERS TODAY, NOT HYPOTHETICALLY. `client.mjs`'s own `projectMessage`
 * already takes a `withTo` option, because the outbound release check has to
 * compare the addresses standing in a Gmail draft against the ones the row
 * recorded. A field added there for the draft path -- `to` is already one --
 * would ride into every read the moment this layer handed the client's object
 * straight back. It cannot, because `projectUzenet` names its ten fields and
 * copies only those; a test feeds a client double that returns `to`, `raw`,
 * `snippet`, `headers` and `historyId` and pins that none of them arrive.
 *
 * WHAT IS OUT, AND WHY EACH ONE -- an allowlist is only a gate if the omissions
 * are accounted for (design spec 4.3):
 *
 *   - THE RAW MIME (`format: 'raw'`). Whoever holds it recovers every header
 *     below with one `Buffer.from`, and every rule here is then one line away
 *     from being bypassed. `get`'s `format` therefore accepts `'text'` alone: a
 *     present `'raw'`, `'full'` or `'metadata'` is refused BY NAME with
 *     `gmail_formatum_nem_kuldheto`, never quietly swapped for the one format
 *     that is on offer.
 *   - THE HEADER TABLE AS A WHOLE -- `Reply-To`, `Return-Path`,
 *     `List-Unsubscribe`, `Authentication-Results`. Each is a string a stranger
 *     wrote, and the worst of them is `Authentication-Results`: it reads as
 *     though the mailbox were saying "this passed SPF", a consumer would use it
 *     as a verdict, and it cannot even say which hop wrote it without the
 *     receiving domain's own rules, which this module does not have.
 *   - `to`, `cc`, `bcc`. Whoever holds an incoming message's recipient list is
 *     one step from building an outgoing one out of it, and that step is
 *     exactly what the outbound half of this extension exists to forbid: a
 *     recipient comes from the operator's address book or from the envelope
 *     `From` of the message being replied to, never from text. The reply path
 *     does not need these to cross -- it reads the envelope on this side and
 *     does not hand the address back.
 *   - ATTACHMENT BYTES AND `attachmentId`s. This version does not read
 *     attachments. `textInAttachment` is a report that the text is somewhere
 *     else, not a door to it.
 *   - `snippet`. A second copy of the same stranger's prose, cut to a different
 *     length. One copy is enough.
 *   - `historyId`. The cursor of a different listing model
 *     (`users.history.list`) that this version does not offer. Handing out a
 *     cursor for an API nobody here calls is a promise nobody keeps.
 *
 * WHAT THIS LAYER DOES NOT DO: SANITISE. `subject` and `text` leave here
 * exactly as the sender wrote them -- not escaped, not truncated, not stripped.
 * Cleaning them would be worse than doing nothing, because the caller would
 * believe the text had been cleaned when only this one path had touched it, and
 * the caller is the side that knows where the text is going: a DOM node, a
 * model prompt, an outbound letter. What this layer does guarantee is the other
 * half: NOTHING STORED OR FETCHED STEERS ANYTHING HERE. No `if` in this file
 * branches on a `subject` or a `text`; no message content reaches a filename, a
 * shell string (this module spawns nothing), a URL, a query parameter or a
 * refusal message. Every refusal below names an argument, a closed vocabulary
 * or a `typeof`, and never the value it refused.
 *
 * ONE HONESTY FIELD, AND ONE THAT IS NOT THIS LAYER'S. `textInAttachment` is
 * carried so a caller is never told a message was empty when its text was
 * served at the attachments endpoint instead of inline; those two are different
 * facts and must not look alike. Its twin `textTruncated` is NOT in this
 * projection and its absence is not an oversight: this layer does not truncate,
 * so it has nothing to report. That field belongs to the consumer that does cut
 * a body to fit -- `extensions/aisignal/src/sweep.mjs` sets it beside its own
 * `TEXT_LIMIT` -- and inventing a constant `false` here would be this module
 * claiming a guarantee about a cut it never makes.
 */

/**
 * The complete set of fields a message crosses this boundary with. Frozen, and
 * read as a closed set: a field not named here does not reach a caller, whoever
 * added it to the client's projection and for whichever path.
 *
 * Each one, and what a reader needs it for:
 *
 *   id                what everything else is addressed by, and what a caller
 *                     dedups on across runs
 *   threadId          which conversation this belongs to, so a caller can group
 *                     without a second fetch. It is an opaque Gmail id, not
 *                     content
 *   labelIds          which mailbox buckets it is in; the only way a caller can
 *                     tell an unread from a read one, or find it again
 *   subject           what the message is about. Stranger-written text
 *   fromName          the display name the sender chose. Stranger-written text,
 *                     and NOT an identity: it is whatever was typed
 *   fromEmail         the envelope address Gmail recorded, which is the one
 *                     durable handle on the sender and the only address the
 *                     reply path will use
 *   sentAt            when it was sent, as an ISO instant, or null when Gmail's
 *                     `internalDate` was not a usable one -- null rather than
 *                     an epoch guess
 *   text              the body, in plain text. This is the whole reason to be
 *                     careful about everything above, and it crosses because a
 *                     mailbox reader that cannot read the message is not one
 *   textInAttachment  whether a text part existed but was served detached, so
 *                     an empty `text` is never mistaken for an empty message
 *   sizeEstimate      how big the message is, so a caller can budget before it
 *                     fetches or forwards. A number Gmail computed, or null
 */
export const UZENET_MEZOK = Object.freeze([
  'id', 'threadId', 'labelIds', 'subject', 'fromName', 'fromEmail',
  'sentAt', 'text', 'textInAttachment', 'sizeEstimate',
])

/**
 * Projects one client message down to `UZENET_MEZOK`.
 *
 * Field by field out of the frozen list, never a spread and never a delete of
 * the fields that must not travel. The difference is the whole point: a spread
 * with deletions leaks whatever was added after the deletions were written,
 * while a copy out of an allowlist leaks nothing that is not typed into
 * `UZENET_MEZOK` above. Adding a field to the client's projection for one
 * caller therefore does not put it on this boundary; editing that array does,
 * and editing it is a decision somebody makes and a reviewer sees.
 *
 * It is not a completeness check and does not pretend to be one. Whether Gmail
 * answered with the documented shape is settled one layer down, where
 * `client.mjs` fails an undocumented reply with `gmail_unexpected` rather than
 * passing a half message on; a second, weaker copy of that check here would
 * only be another place to disagree with it.
 */
export function projectUzenet(row) {
  const uzenet = {}
  for (const mezo of UZENET_MEZOK) uzenet[mezo] = row[mezo]
  return uzenet
}

/**
 * The bound on `q`, as a refusal and not a truncation point: a shortened query
 * names a different set, and the caller would go on believing it had asked the
 * question it wrote. Wide enough that no window an operator or an agent means
 * to express runs into it, and narrow enough that a `q` past it is an assembled
 * string rather than a search.
 */
const Q_MAX = 2000

/**
 * The bound on a message id. Gmail's are short hex strings; this is a bound on
 * nonsense, not a safety measure. The safety is that the id is
 * percent-encoded into the path by its call site in `client.mjs`, which is
 * where that claim can actually be checked.
 */
const ID_MAX = 256

/**
 * Reads `q`: a string, at most `Q_MAX` characters, absent means no query at all.
 *
 * `readString` carries ONE code for both rules it enforces, and the two rules
 * are different facts a caller branches on differently: `q: 5` is the wrong
 * shape (`gmail_argumentum_alak`), and a very long `q` is the right shape and
 * too long (`gmail_lekerdezes_tul_hosszu`). So the shape is read with the
 * readers' own default code, with `readString`'s length bound lifted out of the
 * way, and the length is checked after under its own name.
 */
function readQuery(raw) {
  const q = readString('q', raw, { max: Number.MAX_SAFE_INTEGER })
  if (q !== undefined && q.length > Q_MAX) {
    refuse('gmail_lekerdezes_tul_hosszu', `q legfeljebb ${Q_MAX} karakter lehet, ${q.length} erkezett`)
  }
  return q
}

/**
 * A list of label ids, checked one element at a time.
 *
 * `readArray` refuses a value that is not an array and refuses a list longer
 * than the bound; it says nothing about what is IN the list, and here that is
 * not enough. A label id goes two places, and a non-string reaches both as
 * whatever `String()` makes of it: `URLSearchParams.append` turns `{}` into
 * `labelIds=%5Bobject+Object%5D` and Gmail answers a listing of something else,
 * and the modify body carries it to a write. Neither is a failure a caller
 * could read, so an element that is not a non-empty string is refused by name
 * before either happens.
 *
 * The message names the INDEX and the `typeof`, never the element: `typeof` is
 * a word out of a closed set of eight, and a caller's own bytes have no
 * business in a refusal that is going to be logged and put in front of a model.
 */
function readLabelIds(what, raw) {
  const list = readArray(what, raw)
  list.forEach((id, index) => {
    if (typeof id !== 'string') refuse('gmail_argumentum_alak', `${what}[${index}] szoveg kell legyen, nem ${Array.isArray(id) ? 'array' : typeof id}`)
    if (id === '') refuse('gmail_argumentum_alak', `${what}[${index}] nem lehet ures`)
  })
  return list
}

/**
 * The four reads: the mailbox address, the label list, one page of ids, one
 * message.
 *
 * `state` is the shared object `index.mjs` fills in `setup()`, and the client is
 * built through `clientFor(state)` on every call rather than captured once:
 * these functions are built at module scope, before `setup()` has run, and the
 * host calls `setup()` again on every reload.
 *
 * These throw their refusals rather than returning them. The contract surface
 * is a throwing one (design spec 6), and the rpc and the MCP shim put `guard`
 * around the same calls to turn a `GmailError` into `{ error: { code, ... } }`
 * for the doors that answer in JSON.
 */
export function createOlvasas(state) {
  return {
    /**
     * The address of the mailbox this credential opens, as `{ address }`.
     *
     * A caller keys its own bookkeeping on this together with a label id,
     * because a user label id is minted per mailbox: the same id in two
     * accounts names two different sources, and disconnecting and reconnecting
     * a different Google account swaps the whole mailbox without anything the
     * operator typed changing.
     */
    async mailbox() {
      return { address: await clientFor(state).mailbox() }
    },

    /**
     * Every label in the mailbox, as `[{ id, name, type }]`.
     *
     * The whole list rather than a lookup by name, because the caller is the
     * only side that knows which name it wants and matching here would have to
     * decide how to compare -- Gmail allows two labels differing only in case,
     * so folding it could hand back the wrong one. Handing over both spellings
     * makes the question the caller's, exactly.
     *
     * Built field by field for the same reason `projectUzenet` is: a label name
     * is operator- or stranger-written text, and this is where it is decided
     * that a name and a type cross and nothing else does.
     */
    async labels() {
      const labels = await clientFor(state).labels()
      return labels.map((label) => ({ id: label.id, name: label.name, type: label.type }))
    },

    /**
     * One page of message ids: `{ ids, nextCursor, complete, stoppedOn }`.
     *
     * The three names carry three different facts and none of them may be
     * flattened into the others: `complete` says whether Gmail told us there was
     * nothing after the last page it answered, `nextCursor` is Gmail's own
     * `nextPageToken` passed back untouched, and `stoppedOn` says which bound
     * ended the walk -- `'cap'` (the caller's own `max`) or `'page_ceiling'`
     * (this module's request ceiling), which need different things from the
     * caller next. The invariant, pinned by a test in `client.test.mjs`:
     * `complete === (nextCursor === null) === (stoppedOn === null)`.
     *
     * A mailbox that could not be asked, a mailbox that answered with nothing,
     * and a listing that stopped early are three different facts. The first
     * throws and never returns a list; the second returns `ids: []` with
     * `complete: true`, because the loop one layer down always sends at least
     * one request; the third is what `complete: false` is for.
     *
     * `q` goes to Gmail LITERALLY. No fuzzy threshold, no natural language
     * rewriting, no automatic "enhanced" mode: the same `q` names the same set
     * until the mailbox changes, which is what makes a stored frontier hold.
     *
     * The four fields are named one by one rather than handed on as the client
     * built them, so a fifth field added to the client's result does not reach a
     * contract consumer for free.
     */
    async list({ labelIds, q, max, cursor } = {}) {
      const page = await clientFor(state).list({
        labelIds: readLabelIds('labelIds', labelIds),
        q: readQuery(q),
        max,
        cursor,
      })
      return { ids: page.ids, nextCursor: page.nextCursor, complete: page.complete, stoppedOn: page.stoppedOn }
    },

    /**
     * One message, projected onto `UZENET_MEZOK`.
     *
     * `format` accepts `'text'` and nothing else. A present `'raw'`, `'full'` or
     * `'metadata'` is refused with `gmail_formatum_nem_kuldheto` -- a name of
     * its own, so a caller can tell "I asked for a format that does not exist"
     * from "I asked for a format this module will not hand out" -- and an absent
     * one means the caller had no opinion and gets the one format there is. The
     * read is here for its refusal; there is nothing to branch on with a
     * one-member vocabulary.
     */
    async get({ id, format } = {}) {
      readEnum('format', format, ['text'], { fallback: 'text', code: 'gmail_formatum_nem_kuldheto' })
      const messageId = readString('id', id, { required: true, max: ID_MAX })
      return projectUzenet(await clientFor(state).get(messageId))
    },
  }
}

/**
 * Labels an agent may not touch. TRASH and SPAM move mail somewhere the
 * operator has to go and find it, and in an agent's hands that is near enough
 * to destructive; SENT and DRAFT are Gmail's own bookkeeping and setting them
 * by hand desynchronises the mailbox from itself.
 *
 * Permanent deletion is not on this list because it is not reachable at all:
 * the grant this extension asks for (gmail.modify) does not cover it, and no
 * method here calls users.messages.delete.
 */
export const CIMKE_TILTOTT = Object.freeze(['TRASH', 'SPAM', 'SENT', 'DRAFT'])

/**
 * Finds the forbidden label a caller-supplied id names, or undefined.
 *
 * The comparison folds case, and the refusal names the member of
 * `CIMKE_TILTOTT` it matched rather than the string the caller sent -- so the
 * word that ends up in the message and in the log is this module's own, out of
 * a closed set of four, and not a byte of anybody's text.
 *
 * Folding cannot refuse a legitimate change: Gmail's system label ids are the
 * uppercase words themselves and user label ids are minted as `Label_<n>`, so
 * no real id differs from one of these four by case alone. If that were ever
 * wrong the cost would be a refusal the caller can read, not a message quietly
 * moved to Trash, and this module errs in that direction on purpose.
 */
function tiltottCimke(id) {
  const folded = id.toUpperCase()
  return CIMKE_TILTOTT.find((tiltott) => tiltott === folded)
}

/** The labelling surface: one method, and it is not on the contract (design spec 6.1). */
export function createCimkezes(state) {
  return {
    /**
     * Adds and removes labels on one message.
     *
     * WHAT COMES BACK IS THE OUTCOME, NOT THE REQUEST. The client answers with
     * the labels Gmail says the message now carries, and those are what this
     * hands on. Echoing the two lists the caller sent would be the same false
     * report this module refuses everywhere else: Gmail can apply part of a
     * change, and a caller told its request back has been told nothing.
     *
     * Both lists empty is refused rather than answered. A call that asks for no
     * change is not a change that succeeded, and returning the message's current
     * labels for it would look exactly like a change that had been made.
     */
    async label({ id, hozzaad, elvesz } = {}) {
      const messageId = readString('id', id, { required: true, max: ID_MAX })
      const addLabelIds = readLabelIds('hozzaad', hozzaad)
      const removeLabelIds = readLabelIds('elvesz', elvesz)

      for (const labelId of [...addLabelIds, ...removeLabelIds]) {
        const tiltott = tiltottCimke(labelId)
        if (tiltott) refuse('gmail_cimke_tiltott', `${tiltott} cimke nem adhato es nem veheto el ezen a feluleten`, { cimke: tiltott })
      }
      if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
        refuse('gmail_argumentum_alak', 'hozzaad vagy elvesz kozul legalabb az egyik nem lehet ures')
      }

      const changed = await clientFor(state).modifyLabels(messageId, { addLabelIds, removeLabelIds })
      return { id: changed.id, labelIds: changed.labelIds }
    },
  }
}
