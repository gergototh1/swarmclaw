import { readEnum, readString, readWholeNumber } from './args.mjs'
import { clientFor } from './client.mjs'
import { AJTOK as AJTO_SZOTAR, KIMENO_ALLAPOTOK, now, torzsHashOf } from './db.mjs'
import { GmailError, refuse } from './hibak.mjs'
import { napKulcs, naploKiserlet } from './kimeno.mjs'

/**
 * The release: the one path in this extension that actually sends a letter.
 *
 * Everything before this file stops at a draft on purpose. There is no `send`
 * on the contract and no `send` tool on MCP; `releaseDraft` below is an rpc
 * method, the operator's own page calls it, and it carries the hash of the body
 * that page displayed.
 *
 * WHAT THAT BOUNDARY ACTUALLY BUYS, one line per claim, because a comment that
 * claims more than its mechanism gives is a defect here (design spec 5.4):
 *
 *   - an agent's tool loop cannot reach it -- YES. An agent calls a tool or an
 *     MCP method, this module declares no tools, and the shim's allowlist is six
 *     names that do not include this one.
 *   - a server-side contract consumer cannot reach it -- YES. The method is not
 *     on the contract, so a handle holder has no name to call.
 *   - a browser bundle on its own logged-in page cannot reach it -- NO. Any
 *     bundle running on any page of this app can POST
 *     `/api/extensions/<id>/call/<method>` under any extension's id. The access
 *     key says somebody is logged into this app; it does not say which module or
 *     which agent is asking.
 *
 * AND THE `megerosites` HASH DOES NOT CLOSE THAT LAST GAP. A bundle of the same
 * origin can read the draft it is about to confirm and send back a hash that
 * matches. What the hash closes is a different hole and a real one: the STALE OR
 * SWAPPED DRAFT. The body a person read on the page and the bytes that go out
 * are the same byte sequence, or the release fails by name.
 *
 * WHY THE GATE IS A PERSON AT ALL. Neither door into this module carries a
 * caller identity the host re-checks: a contract handle is a bearer capability
 * whose audience is whoever the consumer passed it to, and the rpc sits behind
 * the app's access key rather than behind a session. That is why the `ajto`
 * column records the DOOR and not the caller, and why this module cannot say
 * which agent or which consumer asked for a draft. With nobody to hold
 * responsible for what goes out, a person has to own the output. That is the
 * whole argument. It is not a claim that the credential cannot send -- the
 * granted scope can send. What this module has is no path that sends without a
 * person, which is a smaller and truer sentence.
 *
 * A SEND IS IRREVERSIBLE, so this file is written around the three answers it
 * may have to give about one, and it never collapses them into two: the letter
 * went out, the letter did not go out, and WE CANNOT TELL. The third is real --
 * a timeout or a dropped connection on `drafts.send` leaves nobody able to say
 * -- and it is recorded as its own state (`bizonytalan`), never as a success and
 * never as a failure. See `kiadasBizonytalan` below.
 *
 * WHAT THIS FILE DOES WITH FOREIGN TEXT. The subject, the body and the `To`
 * header it reads back out of Gmail were last touched by a person editing a
 * draft, and on a reply the subject came from a stranger. None of it steers
 * anything here: nothing branches on its content, it reaches no shell string
 * (this module spawns nothing), no filename, no URL and no header, and no
 * refusal message repeats any of it. The live addresses do travel back to the
 * caller in `konyvonKivul` and onto the row, which is the point -- the page has
 * to show the operator which recipients are not in the book.
 */

/**
 * The daily release budget when the operator has no opinion. Matches the
 * settings field's own default in index.mjs.
 *
 * Exported for the same reason as `NAPI_PISZKOZAT_ALAP`: `health.mjs` reports
 * the number this file enforces rather than a copy of it.
 */
export const NAPI_KIADAS_ALAP = 10

/**
 * The shape of an outbound row's id: sixteen hex characters, which is what
 * `uid()` mints.
 *
 * Checked BEFORE anything repeats the value, for the reason `cimzettek.mjs`
 * spells out about a recipient handle: a refusal that names which id failed is
 * worth having, and echoing a caller's string is only safe once the string
 * cannot carry anything but these characters into a log line or an agent's next
 * prompt. An id that fails this shape is named by its rule and never by its
 * bytes.
 *
 * Exported because `rpc.mjs` reads a row by id too and echoes the id in its
 * refusal for the same reason. One constant, one place: two copies is how one
 * of them ends up admitting a byte the other refuses.
 */
export const KIMENO_ID_RE = /^[0-9a-f]{16}$/

/** The shape of a confirmation: SHA-256 as sixty-four hex characters, which is what `torzsHashOf` produces. */
const MEGEROSITES_RE = /^[0-9a-f]{64}$/

/** How much of a transport failure's own message is stored on the row. It is a line an operator reads, not a value anything uses. */
const MAX_HIBA_SZOVEG = 500

/** The outbox page: the default when the caller has no opinion, and the ceiling. Display paging for one operator, not a sweep. */
const OUTBOX_ALAP_LIMIT = 50
const OUTBOX_MAX_LIMIT = 200

/** The keys an attempt row's `mit` renders, and how much of each. Both are short by shape; the cut is the floor, not the bound. */
const MIT_KULCSOK = Object.freeze(['kimenoId', 'megerosites'])
const MIT_MEZO_MAX = 200

/**
 * What the caller asked for, rendered short, for an attempt row.
 *
 * Every value is turned into a string, a number, a boolean, null or a
 * `<typeof>` word before it is serialised, so nothing here can throw on the one
 * path that must not fail: a `BigInt`, a function or a cyclic object would all
 * otherwise take `JSON.stringify` down while it was recording a refusal.
 */
function mitOf(args) {
  const forras = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const mit = {}
  for (const kulcs of MIT_KULCSOK) {
    if (!(kulcs in forras)) continue
    const value = forras[kulcs]
    if (typeof value === 'string') mit[kulcs] = value.slice(0, MIT_MEZO_MAX)
    else if (value === null || value === undefined) mit[kulcs] = null
    else if (typeof value === 'number' || typeof value === 'boolean') mit[kulcs] = value
    else mit[kulcs] = `<${typeof value}>`
  }
  return JSON.stringify(mit)
}

/**
 * The addresses in a `To` header, as the bare address of each entry.
 *
 * A draft this module wrote carries `To: a@example.test, b@example.test`, so it
 * round trips exactly. A draft the operator edited in their own client may come
 * back as `Dorina Kis <dorina@example.test>, "Kis, Peter" <peter@example.test>`,
 * and both of those have to reduce to the same addresses the row stored, or
 * every edited draft would read as a recipient change that was never made.
 *
 * So the split respects quotes and angle brackets rather than cutting on every
 * comma: a display name is allowed to contain one, and splitting inside it would
 * invent two recipients out of one. The address is what is inside `<>` when
 * there is a pair, and the whole trimmed entry otherwise -- the same reading
 * `parseFrom` makes of a `From` header one file over.
 *
 * THIS IS NOT AN ADDRESS PARSER AND NOTHING IS SENT TO WHAT IT RETURNS. The
 * values it produces are hashed, compared against the address book and shown to
 * the operator. The bytes that actually go out are the ones already standing in
 * the draft in Gmail, which this module does not rewrite.
 */
export function cimekFejlecbol(fejlec) {
  const fejlecSzoveg = typeof fejlec === 'string' ? fejlec : ''
  const darabok = []
  let darab = ''
  let idezojelben = false
  let szogletesben = false
  for (const ch of fejlecSzoveg) {
    if (ch === '"') idezojelben = !idezojelben
    else if (!idezojelben && ch === '<') szogletesben = true
    else if (!idezojelben && ch === '>') szogletesben = false
    if (ch === ',' && !idezojelben && !szogletesben) {
      darabok.push(darab)
      darab = ''
      continue
    }
    darab += ch
  }
  darabok.push(darab)

  return darabok
    .map((entry) => {
      const zart = entry.match(/<([^>]*)>/)
      return (zart ? zart[1] : entry).trim()
    })
    .filter((cim) => cim !== '')
}

/**
 * The three values a confirmation is computed over, out of a draft as Gmail
 * hands it back.
 *
 * Exactly the triple `kimeno.mjs` hashed when it wrote the row -- the recipient
 * addresses, the subject and the body -- so the two numbers are comparable at
 * all. An absent field reads as empty rather than as `undefined`: a draft with
 * no subject is a draft with an empty subject, and letting `undefined` into
 * `canonicalJson` would hash a fourth thing that is neither.
 */
function eloMezok(elo) {
  return {
    cimek: cimekFejlecbol(elo?.to),
    targy: typeof elo?.subject === 'string' ? elo.subject : '',
    torzs: typeof elo?.text === 'string' ? elo.text : '',
  }
}

/**
 * The fingerprint of a draft as it stands in Gmail right now.
 *
 * Exported because the surface that shows a draft to the operator has to send
 * this same number back as `megerosites`, and it must be THIS function that
 * produces it: two implementations of one fingerprint is how a page ends up
 * confirming a hash of something other than what it displayed. `torzsHashOf`
 * does the rest, so the release compares a number computed exactly the way the
 * row's own was.
 */
export function eloHashOf(elo) {
  return torzsHashOf(eloMezok(elo))
}

/**
 * The live recipients that are not in the address book, lowercased for the
 * comparison only.
 *
 * NOT A REFUSAL, and the reason is that this module cannot tell the two cases
 * apart. An address the operator typed into their own mail client is a
 * decision; an address that appeared without one is precisely what this whole
 * outbound design exists to prevent, and only a person looking at the letter
 * knows which happened. So both are handed to that person -- named in the
 * answer and stored on the row -- and neither stops the send.
 *
 * A RETIRED ENTRY COUNTS AS OUTSIDE THE BOOK. The operator took that address
 * away, and a draft still carrying it is exactly the thing worth a second look
 * rather than something to wave through on the strength of a row that has been
 * withdrawn.
 *
 * The case fold is on the comparison and never on the stored or returned value.
 * Two addresses differing only in case are one mailbox in practice, and folding
 * would only ever move an entry off a list a person reads; the bytes that go out
 * are untouched by any of this, and the confirmation hash is byte-exact
 * separately.
 */
function konyvonKivuliek(state, cimek) {
  const konyv = new Set(state.repo.cimzettek({ elo: true }).map((sor) => String(sor.cim).toLowerCase()))
  return cimek.filter((cim) => !konyv.has(cim.toLowerCase()))
}

/**
 * The daily release budget, taken the same way and in the same order as the
 * draft budget in `kimeno.mjs`.
 *
 * THE SLOT IS RESERVED BEFORE THE SEND, not counted after it: `bumpNapi` raises
 * the counter and answers the day as it now stands, so the reservation happens
 * on this side of the `await` rather than after it. The other order lets ten
 * concurrent releases all read nine and all send, which is the runaway this
 * budget exists to stop.
 *
 * THE COST, OWNED: the counter measures SLOTS TAKEN. A release whose send then
 * fails, or whose outcome is unknown, has spent one and may have sent nothing.
 * That is the safe direction -- the cap can only under-deliver -- and the read
 * before the increment is why a caller already at the cap is refused without
 * taking a slot, so a run of refusals cannot drive the day's number past it.
 */
function keretetVesz(state) {
  const keret = readWholeNumber('napiKiadas', state.settings().napiKiadas, { min: 0, fallback: NAPI_KIADAS_ALAP })
  const nap = napKulcs()
  const elotte = state.repo.napi(nap)
  if (elotte.kiadas >= keret) {
    refuse('gmail_kiadas_keret_kimerult', `a mai kiadasi keret betelt: ${elotte.kiadas}/${keret}`, { nap, keret, mai: elotte.kiadas })
  }
  const utana = state.repo.bumpNapi(nap, 'kiadas')
  if (utana.kiadas > keret) {
    refuse('gmail_kiadas_keret_kimerult', `a mai kiadasi keret betelt: ${utana.kiadas}/${keret}`, { nap, keret, mai: utana.kiadas })
  }
}

/** The `kimenoId` argument, read and held to the id shape before anything repeats it. */
function olvasKimenoId(raw) {
  const kimenoId = readString('kimenoId', raw, { required: true, max: 64 })
  // The value is not repeated: an id a caller sent is a caller's string, and the
  // rule it broke is what tells the caller what to fix.
  if (!KIMENO_ID_RE.test(kimenoId)) refuse('gmail_argumentum_alak', `kimenoId csak ezt az alakot veheti fel: ${KIMENO_ID_RE.source}`)
  return kimenoId
}

/** The first argument of a release or a discard: an object, and nothing else. */
function olvasArgumentum(args, metodus) {
  const kert = args === undefined || args === null ? {} : args
  if (typeof kert !== 'object' || Array.isArray(kert)) refuse('gmail_argumentum_alak', `a ${metodus} argumentuma egy objektum kell legyen`)
  return kert
}

export function createKiadas(state) {
  /**
   * One outbound row that is ready for the operation named, or a refusal.
   *
   * "No such row" and "a row in the wrong state" are two facts with two codes,
   * and the second is NEVER answered with an idempotent "it already went out,
   * fine". After a second click the operator has to know whether the letter went
   * once or twice, and only a refusal that names the state it found says which.
   */
  const piszkozatSor = (kimenoId) => {
    const sor = state.repo.kimeno(kimenoId)
    if (!sor) refuse('gmail_kimeno_ismeretlen', 'nincs ilyen kimeno sor', { kimenoId })
    if (sor.allapot !== 'piszkozat') {
      refuse('gmail_kimeno_allapot', `ez a sor nem piszkozat, hanem ${sor.allapot}`, { kimenoId, allapot: sor.allapot })
    }
    return sor
  }

  return {
    /**
     * Sends one draft, after checking that the bytes about to go out are the
     * bytes a person looked at.
     *
     * `ajto` is the SECOND POSITIONAL ARGUMENT and never a field of the first,
     * exactly as in `draft`, so it cannot arrive from a caller. Only `rpc.mjs`
     * may call this -- the method is not on the contract -- but it is written
     * this way rather than with a constant in this file so that the row would
     * still say the truth if a later step ever wired a second door to it. A
     * value outside the vocabulary is a bug in the calling file, so it throws a
     * plain Error rather than being refused with a code.
     *
     * THE ORDER IS THE DESIGN (spec 5.4), and two places in it are load-bearing:
     *
     *   - the draft is read FRESH OUT OF GMAIL, never from the row. The whole
     *     point of the confirmation is that it is checked against what is
     *     actually there, and the row is a copy of what was there when it was
     *     written.
     *   - a mismatched confirmation stops here. Nothing further runs: no budget
     *     is spent, no row is touched and `drafts.send` is not called.
     */
    async releaseDraft(args, ajto) {
      if (!AJTO_SZOTAR.includes(ajto)) throw new Error(`releaseDraft: unknown door ${JSON.stringify(ajto)}`)
      // Once the row is claimed it is the record of what happened, and an
      // attempt row beside it would be one event counted twice. Every refusal
      // before that point leaves the row untouched, so the attempts table is the
      // only place those can be seen at all -- `gmail_lap_elavult` above all,
      // which is the most interesting thing this module can refuse.
      let foglalt = false
      try {
        const kert = olvasArgumentum(args, 'releaseDraft')
        const kimenoId = olvasKimenoId(kert.kimenoId)
        const megerosites = readString('megerosites', kert.megerosites, { required: true, max: 64 })
        // "Not a hash at all" and "a hash that no longer holds" are different
        // mistakes, and a caller can act on the first by rebuilding its request.
        if (!MEGEROSITES_RE.test(megerosites)) refuse('gmail_argumentum_alak', `megerosites csak ezt az alakot veheti fel: ${MEGEROSITES_RE.source}`)

        // 1-2. The row, and the state that gates a second release.
        const sor = piszkozatSor(kimenoId)
        // A draft row whose Gmail id never got written back (see `draft`'s own
        // comment on the write order) names no draft anybody can send. It is the
        // same fact the state check reports -- this row is not ready for this
        // operation -- so it gets that code rather than a new one.
        if (sor.gmail_draft_id === '') {
          refuse('gmail_kimeno_allapot', 'ehhez a sorhoz nem tartozik Gmail-piszkozat', { kimenoId, allapot: sor.allapot })
        }

        const client = clientFor(state)
        // 3. The fresh read. A draft the operator deleted or already sent from
        //    their own client fails here with the client's own code, and the row
        //    is deliberately NOT written: a failed read cannot tell "gone" from
        //    "unreadable right now", and closing a row on a guess would be this
        //    module reporting something it does not know.
        const elo = await client.getDraft(sor.gmail_draft_id)

        // 4-5. The confirmation, against the draft that is actually there.
        const mezok = eloMezok(elo)
        const eloHash = torzsHashOf(mezok)
        if (megerosites !== eloHash) {
          // The message names neither hash and quotes none of the draft: what
          // the caller needs is that the page it rendered no longer holds, and
          // the body it would otherwise carry was written by somebody else.
          refuse('gmail_lap_elavult', 'a megerosites nem a Gmailben allo piszkozathoz tartozik; olvasd ujra a piszkozatot', { kimenoId })
        }

        // 6. Edited in Gmail. NOT a refusal: the credential lives only in this
        //    module, so the only hand that can have changed that draft is the
        //    operator's own, in their own client. The row is brought up to what
        //    is actually there and the answer says it happened.
        const szerkesztve = eloHash !== sor.torzs_hash
        if (szerkesztve) {
          state.repo.markSzerkesztve(kimenoId, { targy: mezok.targy, torzs: mezok.torzs, cimzettCimek: mezok.cimek, torzsHash: eloHash })
        }

        // 7. The live recipients the book does not know. Reported, not refused.
        const konyvonKivul = konyvonKivuliek(state, mezok.cimek)

        // 8. The budget, the claim and the send. Everything from here to the
        //    `await` below is synchronous, so no second release can slip between
        //    the state check and the write that takes the row out of
        //    `piszkozat`; a release that got as far as its own draft read while
        //    this one was awaiting finds `bizonytalan` here and is refused.
        keretetVesz(state)
        const ujra = state.repo.kimeno(kimenoId)
        if (!ujra || ujra.allapot !== 'piszkozat') {
          refuse('gmail_kimeno_allapot', `ez a sor mar nem piszkozat, hanem ${ujra ? ujra.allapot : 'torolve'}`, { kimenoId, allapot: ujra ? ujra.allapot : '' })
        }
        // The claim, written BEFORE the send with no cause on it, because from
        // this instant nobody can say whether the letter left. A process that
        // dies during the request leaves exactly this row.
        state.repo.markBizonytalan(kimenoId)
        foglalt = true

        let messageId
        try {
          ({ messageId } = await client.sendDraft(sor.gmail_draft_id))
        } catch (err) {
          // EVERY failure of the send is recorded as unknown, including the ones
          // that certainly sent nothing. The client reports a timeout, a
          // transport failure and a refused status under codes that do not say
          // which side of the send they happened on, and inventing that
          // distinction here would be a guess dressed as a fact. Over-reporting
          // uncertainty costs the operator a look in Sent; under-reporting it
          // costs a letter nobody knows went out.
          const kod = err instanceof GmailError ? err.code : 'gmail_unexpected'
          state.repo.markBizonytalan(kimenoId, { kod, szoveg: String(err?.message || '').slice(0, MAX_HIBA_SZOVEG) })
          refuse('gmail_kiadas_bizonytalan', 'a Gmail nem valaszolt a kuldesre, tehat nem tudjuk, kiment-e; nezd meg a postafiok Elkuldott mappajat', { kimenoId, okKod: kod })
        }

        const kiadvaAt = now()
        // Deliberately after the send and not guarded by the block above: a
        // letter that WENT OUT and whose row could not be updated must not be
        // recorded as a failure or as unknown. If this write throws, the storage
        // is broken and the error is the honest answer; the letter is in
        // somebody's inbox either way.
        state.repo.markKiadva(kimenoId, { gmailMessageId: messageId, konyvonKivul, kiadvaAt })

        return { kimenoId, gmailMessageId: messageId, kiadvaAt, szerkesztve, konyvonKivul, torzsHash: eloHash }
      } catch (err) {
        if (err instanceof GmailError && !foglalt) naploKiserlet(state, { ajto, kod: err.code, mit: mitOf(args) })
        throw err
      }
    },

    /**
     * Deletes the Gmail draft, then closes the row.
     *
     * IN THAT ORDER, and the order is the whole method. A deleted draft beside a
     * row that still reads `piszkozat` is visible: the next release of it fails
     * with `gmail_draft_failed` and the operator sees it on the page. The other
     * way round leaves a row reading `elvetve` next to a live draft standing in
     * the mailbox that nothing in this module lists, counts or ever looks at
     * again. A visible inconsistency beats a hidden one.
     *
     * A row that never got a draft id has nothing in Gmail to delete, so the
     * call is skipped rather than made with an empty id. Skipping it is not the
     * same as pretending it succeeded: there is genuinely nothing there.
     */
    async discardDraft(args, ajto) {
      if (!AJTO_SZOTAR.includes(ajto)) throw new Error(`discardDraft: unknown door ${JSON.stringify(ajto)}`)
      try {
        const kert = olvasArgumentum(args, 'discardDraft')
        const kimenoId = olvasKimenoId(kert.kimenoId)
        const sor = piszkozatSor(kimenoId)

        if (sor.gmail_draft_id !== '') await clientFor(state).deleteDraft(sor.gmail_draft_id)

        // The state is read again on this side of the await for the same reason
        // the release claims its row: a release that started while this one was
        // deleting has already moved the row, and writing `elvetve` over it
        // would erase the record of a send whose outcome is not known.
        const ujra = state.repo.kimeno(kimenoId)
        if (!ujra || ujra.allapot !== 'piszkozat') {
          refuse('gmail_kimeno_allapot', `ez a sor mar nem piszkozat, hanem ${ujra ? ujra.allapot : 'torolve'}`, { kimenoId, allapot: ujra ? ujra.allapot : '' })
        }
        state.repo.markElvetve(kimenoId)
        return { kimenoId, allapot: 'elvetve' }
      } catch (err) {
        if (err instanceof GmailError) naploKiserlet(state, { ajto, kod: err.code, mit: mitOf(args) })
        throw err
      }
    },

    /**
     * A page of outbound rows with the total beside it.
     *
     * THE WHOLE ROW GOES BACK HERE. The narrowing belongs to the surfaces that
     * know who is on the other end: the contract's projection is deliberately
     * narrower than the page's, because a contract consumer cannot be identified
     * and a full row would hand any of them another consumer's body and the
     * resolved addresses of the recipient book. That projection is Task 8's; this
     * method is what both of them read from.
     *
     * `allapot` is held to the closed vocabulary under its own code, so "a state
     * that does not exist" is a fact a caller can act on rather than an empty
     * page that looks like "nothing matched".
     */
    outbox({ allapot, limit, offset } = {}) {
      const szurt = readEnum('allapot', allapot, KIMENO_ALLAPOTOK, { fallback: '', code: 'gmail_allapot_ismeretlen' })
      const hatar = readWholeNumber('limit', limit, { min: 1, max: OUTBOX_MAX_LIMIT, fallback: OUTBOX_ALAP_LIMIT })
      const eltolas = readWholeNumber('offset', offset, { min: 0, fallback: 0 })
      const items = state.repo.kimenok({ allapot: szurt, limit: hatar, offset: eltolas })
      // `total` is read after the page rather than before it, so a row written
      // between the two can only make the total look one too high -- never make
      // the page claim there are fewer rows than it just handed back.
      return { total: state.repo.countKimeno({ allapot: szurt }), count: items.length, items }
    },
  }
}
