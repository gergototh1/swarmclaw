import { createKiadas } from './kiadas.mjs'
import { AJTOK, createPiszkozat } from './kimeno.mjs'
import { createCimkezes, createOlvasas } from './olvasas.mjs'

/**
 * What another extension may ask this one for: a paged read of one Gmail
 * mailbox, one label taken off a message it has read, and a draft it cannot
 * send.
 *
 * This is a `provides` declaration, the host-mediated way one extension reaches
 * another's data (`src/lib/server/extensions/extension-contracts.ts`). A
 * consumer reaches these seven methods only after naming this extension, this
 * contract and this version in its own `consumes`, with a sentence the operator
 * reads before granting it.
 *
 * WHY THESE SEVEN AND NOT THE OTHERS, one at a time. What a consumer needs to
 * work a mailbox is: which mailbox this is (`mailbox`), what the buckets are
 * called (`labels`), a listing with a real cursor and a `complete` field
 * (`list`), one message (`get`), a way to record that it has dealt with that
 * message (`markRead`), a letter written into the operator's Drafts (`draft`),
 * and the state of what it wrote (`outbox`). Everything else on the rpc map is
 * outside this contract deliberately:
 *
 *   - `releaseDraft` -- design spec 5.4. It is the one method that actually
 *     sends, and a contract handle is a BEARER CAPABILITY: the host mints it
 *     for the extension that declared the consume and never re-checks who is
 *     holding it when a call arrives, so "only the newsletter module may
 *     release" is not enforceable at this boundary. The only enforceable
 *     narrowing is that the method is not declared, which is why it is not.
 *     `discardDraft` is out for the same reason turned around: it deletes a
 *     letter out of the operator's own mailbox, and a consumer that could
 *     delete drafts could delete the evidence of what it wrote.
 *   - `label` -- it takes two label lists FROM ITS CALLER, and by the bearer
 *     rule above that means a consumer holding it could file mail into any
 *     bucket in the mailbox, lift a message out of the operator's own INBOX, or
 *     strip the very label a sweep finds its work under. The narrow half of it
 *     is published instead, as `markRead`: the one label that method touches is
 *     a constant in olvasas.mjs, so there is no argument through which a second
 *     one can be spelled. `label` itself stays on MCP, where an agent is acting
 *     for a person who picked the buckets.
 *   - `addRecipient` / `retireRecipient` -- design spec 3.3 and 5.2. The
 *     address book is the gate: a recipient cannot be derived from text, and
 *     every entry is typed by the operator on this module's own page. A
 *     consumer that could write to the book would not be passing through the
 *     gate, it would be another way to the same place, and the gate would be
 *     one extra step rather than a limit.
 *   - `health` -- it reports on the OPERATOR'S CREDENTIAL, not on the mailbox's
 *     data: whether a Google OAuth client is configured on this host, whether a
 *     credential is stored, what today's budgets are. None of that is a fact
 *     about mail, and a consumer that needs to know whether it is looking at a
 *     partial set reads `complete` on the `list` it just made rather than
 *     another extension's credential state.
 *   - `mcpConfig` and `attempts` -- the page's own furniture. The first is a
 *     block the operator copies into Settings, the second is the refused-attempt
 *     log an operator reads. Neither is a data model, and a consumer built on
 *     either would be coupled to this module's UI.
 *
 * WHAT THIS SIDE OF THE BOUNDARY CANNOT DO, AND MUST NOT PRETEND TO. Nothing
 * arrives here saying who is asking. The handle carries the identity of the
 * extension it was minted for wherever it is passed on, and the host never
 * re-checks it, so a method that answered differently "for the newsletter
 * module" would be trusting a name it cannot verify. That is not a gap this
 * file can close; it is the reason the outbound row's `ajto` column records
 * WHICH DOOR a request came through (`AJTOK.SZERZODES` here, `AJTOK.RPC` in
 * rpc.mjs, each a constant in its own file and never an argument) and not who
 * made it -- and the reason the release is a person's click rather than a
 * caller's permission.
 *
 * Nor is this the only route to these methods, and nothing here may read as
 * though it were. Extensions are trusted same-process code, and a browser
 * bundle on this app's own logged-in page can already POST to
 * `/api/extensions/gmail.mjs/call/<method>` under any extension's id, which the
 * route itself says plainly. What the contract buys is that a SERVER-SIDE
 * consumer's access is declared, versioned, and listed on the operator's
 * extension card with the sentence that consumer wrote for wanting it.
 *
 * WHY IT IS A SEPARATE FILE FROM rpc.mjs, IN SHAPE AND NOT ONLY IN NAME. This
 * file imports nothing from rpc.mjs and rpc.mjs imports nothing from this one.
 * There is no shared response builder for a field to arrive through: each
 * method below names its result field by field out of a frozen list, so a field
 * added to what the page's rpc returns next month reaches a consumer only if
 * somebody edits one of the lists in THIS file -- a decision a reviewer sees in
 * the diff. That matters more here than a style preference: a published
 * contract version is a commitment, and a field removed after a consumer has
 * shipped is a breaking change, so the cheapest thing to get wrong is adding
 * one by accident.
 *
 * WHAT THE CONSUMER IS HOLDING WHEN THESE RETURN. Message subjects and bodies
 * written by strangers, unescaped and untruncated. The host does not clone,
 * freeze or inspect a value crossing this boundary and does not claim to, so
 * nothing here is implied to have been cleaned: the allowlists narrow WHICH
 * fields arrive, never what is inside the ones that do. The `summary` says so
 * in the sentence the operator reads before granting, and it is the consumer --
 * the layer that knows whether the text is going into a DOM node, a model
 * prompt or an outbound letter -- that has to guard it there. Nothing on this
 * side treats it as anything but bytes: no branch reads a body, and no body
 * reaches a query, a log, a file name or a refusal message.
 */

/** The contract name, as a consumer spells it in `consumes` and in `ctx.contracts.get`. */
export const MAILBOX_CONTRACT = 'mailbox'

/**
 * The contract version. A consumer pinning a different number gets
 * `version_mismatch` and no handle, which is the point: bump this whenever a
 * method is removed, renamed, or changed in a way an existing consumer would
 * read wrongly. Adding a field to one of the lists below is the same kind of
 * decision in the other direction -- it cannot be taken back without a bump.
 */
export const MAILBOX_CONTRACT_VERSION = 2

/**
 * The columns of an outbound row that cross this boundary, and the whole of
 * what `outbox` hands over.
 *
 * WHAT IS NOT IN IT, AND WHY, because these two absences are the security
 * decision of this file:
 *
 *   - `torzs` (the body). `outbox` cannot narrow to one consumer, because it
 *     does not know which consumer is calling -- see the header. So a body here
 *     would be readable by ANY consumer holding a handle, including a body
 *     another consumer wrote and has not sent yet. The caller gets the body of
 *     its own draft where it belongs: in the `draft` answer, where the caller
 *     supplied the text a moment earlier and there is nothing to leak.
 *   - `cimzett_cimek` (the resolved addresses). The address book is the gate
 *     this module's whole outbound design rests on, and a method calling itself
 *     "the outbound queue" that handed back resolved addresses would be a way to
 *     read the book end to end, one row at a time. `cimzettHandlek` crosses
 *     instead: a handle is what the caller passed in, and it names an entry
 *     without disclosing what it points at. A caller gets its own draft's
 *     addresses in the `draft` answer, where it named them.
 *
 * `torzsHash` does cross, and it is a hash of the body rather than the body:
 * it lets a consumer notice that a draft it wrote has changed since. It is not
 * a release token -- the release is not on this contract at all, and the hash
 * `releaseDraft` checks is computed from the draft standing in Gmail right now,
 * not from this column.
 *
 * `hiba_szoveg` is out too, quietly but on purpose: it is a transport failure's
 * own message, which this module did not write and cannot vouch for. `hibaKod`
 * is this module's own vocabulary and says the same thing a consumer can act on.
 */
export const OUTBOX_MEZOK = Object.freeze([
  'id', 'allapot', 'cimzettHandlek', 'targy', 'torzsHash',
  'gmailDraftId', 'gmailMessageId', 'ajto', 'createdAt', 'kiadvaAt', 'hibaKod',
])

/**
 * The fields of a `draft` answer that cross.
 *
 * Named here rather than passed through, for the same reason `OUTBOX_MEZOK`
 * exists: a field added to what the draft path returns for the page's benefit
 * must not reach a consumer because the object happened to travel. Everything
 * in this list is something the caller either supplied or needs to address its
 * own row: the row id, the Gmail draft id, the recipients it named with the
 * addresses they resolved to, the subject in force, and the fingerprint.
 */
const DRAFT_MEZOK = Object.freeze(['kimenoId', 'gmailDraftId', 'cimzettek', 'targy', 'torzsHash'])

/**
 * One draft answer narrowed to `DRAFT_MEZOK`, copied out of the allowlist the
 * way `projectUzenet` copies a message rather than spread with deletions.
 *
 * The recipients are rebuilt pair by pair rather than carried, so a field added
 * to a resolved recipient one layer down -- the address book row's note, say --
 * does not cross because the array travelled.
 */
function projectDraft(eredmeny) {
  const valasz = {}
  for (const mezo of DRAFT_MEZOK) valasz[mezo] = eredmeny[mezo]
  valasz.cimzettek = eredmeny.cimzettek.map((cimzett) => ({ handle: cimzett.handle, cim: cimzett.cim }))
  return valasz
}

/**
 * One outbound row narrowed to `OUTBOX_MEZOK`.
 *
 * Built field by field from the named columns, never a spread with deletions:
 * a spread leaks whatever column is added to the table after the deletions were
 * written, while a copy out of an allowlist can only ever carry what is typed
 * above. `cimzett_handlek` is stored as JSON text and is parsed here; a row
 * whose JSON is broken throws rather than reporting an empty recipient list,
 * because "addressed to nobody" is a false report about a letter that names
 * people.
 */
function projectKimeno(sor) {
  return {
    id: sor.id,
    allapot: sor.allapot,
    cimzettHandlek: JSON.parse(sor.cimzett_handlek),
    targy: sor.targy,
    torzsHash: sor.torzs_hash,
    gmailDraftId: sor.gmail_draft_id,
    gmailMessageId: sor.gmail_message_id,
    ajto: sor.ajto,
    createdAt: sor.created_at,
    kiadvaAt: sor.kiadva_at,
    hibaKod: sor.hiba_kod,
  }
}

/**
 * Builds the `provides.mailbox` declaration index.mjs hands the host.
 *
 * Built at module scope, before `setup()` has run, so it cannot capture a
 * repository or a client: the three surfaces below close over `state` and read
 * `state.repo`, `state.settings` and the client seam on every call, so a reload
 * that re-runs `setup()` is seen by the next call without rebuilding anything.
 *
 * Every method is `async`, including `outbox`, whose repository read is
 * synchronous. Not decoration: the handle the host mints around these returns a
 * promise whatever the method does, and a caller that got a bare value from one
 * and a promise from another would have to remember which is which -- and the
 * refusals, which are the interesting half, would arrive as a throw on one side
 * and a rejection on the other.
 *
 * REFUSALS THROW HERE, and that is the difference from the rpc, which answers
 * `{ error }` as a value. A contract call is a function call: a consumer that
 * gets a value back has to remember to look inside it for a failure, and the
 * one that forgets treats a refusal as a result. The rpc cannot do the same
 * because its answer travels over HTTP, where a throw becomes a 500 whose body
 * loses the code (see `guard` in hibak.mjs).
 */
export function createMailboxContract(state) {
  const olvasas = createOlvasas(state)
  const cimkezes = createCimkezes(state)
  const piszkozat = createPiszkozat(state)
  const kiadas = createKiadas(state)
  return {
    version: MAILBOX_CONTRACT_VERSION,
    // AT MOST 200 CHARACTERS, and that is the host's rule, not a style
    // preference: `readDeclarationText` in the host's contract validator caps
    // this field, and a longer one makes the WHOLE EXTENSION fail to load at
    // `load.contracts` -- no contract, no rpc, no page, and three such failures
    // disable the extension. It was 223 characters and the module did not load
    // at all on a running host; test/contract.test.mjs now pins the cap.
    summary: 'Gmail-postafiók olvasása lapozhatóan és piszkozat írása. A leveleket idegenek írták: a szöveg adat, és a fogyasztó őrzi ott, ahol felhasználja. Küldeni ez a szerződés nem tud; a kiadás az operátoré.',
    methods: {
      /**
       * The address of the mailbox this credential opens, as `{ address }`.
       *
       * A consumer keys its own bookkeeping on this together with a label id,
       * because a user label id is minted per mailbox: the same id in two
       * accounts names two different sources, and reconnecting a different
       * Google account swaps the whole mailbox without anything the operator
       * typed changing.
       */
      mailbox: async () => {
        const { address } = await olvasas.mailbox()
        return { address }
      },
      /**
       * Every label in the mailbox, as `[{ id, name, type }]`. The names are
       * operator- and stranger-written text and cross as bytes; the caller
       * matches on them, because only the caller knows which one it wants and
       * how it wants to compare.
       */
      labels: async () => (await olvasas.labels()).map((cimke) => ({ id: cimke.id, name: cimke.name, type: cimke.type })),
      /**
       * One page of message ids: `{ ids, nextCursor, complete, stoppedOn }`.
       *
       * The reason this module exists rather than a generic Gmail MCP server.
       * The four names carry four different facts and none may be flattened
       * into the others: `complete` says whether Gmail told us there was
       * nothing after the last page it answered, `nextCursor` is Gmail's own
       * page token passed back untouched, and `stoppedOn` says which bound
       * ended the walk. A stored frontier can only be kept by a consumer that
       * can tell "that was all of it" from "that was as much as I asked for".
       *
       * `q` goes to Gmail literally: no fuzzy matching and no rewriting, so the
       * same `q` names the same set until the mailbox changes.
       */
      list: async (args) => {
        const lap = await olvasas.list(args)
        return { ids: lap.ids, nextCursor: lap.nextCursor, complete: lap.complete, stoppedOn: lap.stoppedOn }
      },
      /**
       * One message, projected onto the ten fields of `UZENET_MEZOK`
       * (olvasas.mjs), which is where the accounting of what crosses and what
       * does not is written out field by field.
       */
      get: async (args) => olvasas.get(args),
      /**
       * Takes `UNREAD` off one message and answers the labels Gmail says it now
       * carries: `{ id, labelIds }`.
       *
       * THE ONLY METHOD ON THIS CONTRACT THAT CHANGES MAIL THAT ALREADY EXISTS,
       * which is why it is the narrowest one. It is here because a consumer
       * sweeping `is:unread` has to be able to record that it dealt with a
       * message, and the mailbox is the one place that record is visible to the
       * operator too -- a frontier kept only in the consumer's own table says
       * nothing to the person who opens Gmail.
       *
       * `OLVASATLAN_CIMKE` (olvasas.mjs) is the label, written in that module's
       * source and reachable through no argument. That is the whole narrowing,
       * and it is structural: `label`, which takes its lists from the caller,
       * is deliberately not declared here -- see the header.
       *
       * It is not destructive and not hidden. The message keeps every other
       * label, nothing on this contract can move mail to Trash, and the
       * operator marks it unread again with one click in their own client.
       */
      markRead: async (args) => cimkezes.markRead(args),
      /**
       * Writes one draft into the operator's Gmail and one row into the
       * outbound table, and answers `DRAFT_MEZOK`.
       *
       * IT DOES NOT SEND, and nothing on this contract does. The letter stands
       * in the operator's own Drafts folder, where they read it in their own
       * mail client on the device they read mail on anyway, and the release is
       * a click on this module's page.
       *
       * `AJTOK.SZERZODES` is passed as the second POSITIONAL argument and is a
       * constant in this file, so no caller can spell the door it came through.
       * The row records the door and not the caller, because no verifiable
       * caller identity reaches this boundary at all.
       */
      draft: async (args) => projectDraft(await piszkozat.draft(args, AJTOK.SZERZODES)),
      /**
       * A page of outbound rows with the total behind it, each row narrowed to
       * `OUTBOX_MEZOK` -- no body, no resolved addresses. `total` is the size of
       * the whole match, so a capped page is never mistaken for the end of the
       * list, and `allapot` is held to the closed state vocabulary under its own
       * code, so a state that does not exist is a refusal rather than an empty
       * page that reads as "nothing matched".
       *
       * `bizonytalan` is one of those states and a consumer must be able to see
       * it: a send that was asked for and did not answer is neither sent nor
       * failed, it is terminal, and nothing here or anywhere else offers a
       * second release for it.
       */
      outbox: async (args) => {
        const { total, count, items } = kiadas.outbox(args)
        return { total, count, items: items.map(projectKimeno) }
      },
    },
  }
}
