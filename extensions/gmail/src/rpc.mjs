import path from 'node:path'

import { readString, readWholeNumber } from './args.mjs'
import { createCimzettek } from './cimzettek.mjs'
import { clientFor } from './client.mjs'
import { runHealth } from './health.mjs'
import { guard, refuse } from './hibak.mjs'
import { KIMENO_ID_RE, createKiadas, eloHashOf } from './kiadas.mjs'
import { AJTOK, createPiszkozat } from './kimeno.mjs'
import { createCimkezes, createOlvasas } from './olvasas.mjs'

/**
 * What this extension's own page and its MCP shim may call, over
 * `POST /api/extensions/gmail.mjs/call/<method>`, and nothing else.
 *
 * The `gmail.mjs` in that path is not a typo. The host keys the route on the
 * extension's FILE id (`src/app/api/extensions/[id]/call/[method]/route.ts`
 * looks the handler up by the same id the loader registered), and
 * scripts/install.mjs writes this extension as `<DATA_DIR>/extensions/gmail.mjs`.
 * `/api/extensions/gmail/call/...` is a 404, so this is the one spelling to
 * copy.
 *
 * THIS IS NOT THE CONTRACT, AND CANNOT BECOME IT. `contract.mjs` declares six
 * methods over explicit field lists and imports nothing from this file; this
 * file imports nothing from that one. Adding a method here, or a field to what
 * `board` or `outbox` returns, adds nothing a consumer extension can read:
 * there is no shared response builder for a field to arrive through, and the
 * contract copies its answers out of its own lists. That separation is the
 * whole reason the two are different files with different shapes rather than
 * one map the contract re-exports a slice of. It has to hold under the
 * pressure that will actually come -- the page needs a field next month -- and
 * the only thing that makes it hold is that the two shapes have no code in
 * common.
 *
 * WHY THIS ONE IS THE WIDER OF THE TWO. Behind this route there is the app's
 * access-key check, and on the far side of it only this extension's own bundle
 * and the MCP shim the operator registered by hand. So it carries what those
 * two need, INCLUDING THE ONE METHOD THAT WRITES FROM THE OPERATOR'S HAND:
 * `releaseDraft`, the only path in this module that actually sends a letter.
 *
 * WHAT THAT PLACEMENT BUYS, one line per claim, because a comment claiming more
 * than its mechanism gives is a defect (design spec 5.4):
 *
 *   - an agent's tool loop cannot reach it -- YES. This extension declares no
 *     tools, an agent calls tools or MCP, and the shim's allowlist is six names
 *     that do not include this one.
 *   - a server-side contract consumer cannot reach it -- YES. It is not
 *     declared on the contract, and a handle only reaches declared methods.
 *   - a browser bundle on this app's own logged-in page cannot reach it -- NO.
 *     Any bundle on any page of this app can POST to this route under any
 *     extension's id; the route says so itself. The access key identifies a
 *     logged-in session, not an agent and not a module.
 *
 * The confirmation hash does not close that last gap either -- a bundle of the
 * same origin can read the draft it then confirms. What the hash closes is a
 * stale or swapped draft: the body a person looked at and the body that goes
 * out are the same bytes, or the release fails by name.
 *
 * REFUSALS ARE VALUES HERE, not throws: every method below runs inside `guard`
 * (hibak.mjs), which answers a `GmailError` as `{ error: { code, message,
 * ... } }`. The route turns a throw into a 500 whose body carries only the
 * message, so the code would be lost and the shim could not tell an exhausted
 * daily budget from a broken socket. Anything that is NOT a `GmailError` still
 * throws, because that one is this module's bug and a 500 is the truth about
 * it. This is the opposite choice from `contract.mjs`, which throws, and the
 * reason is the wire: a contract call is a function call, an rpc call is HTTP.
 *
 * WHAT THIS FILE DOES TO THE STORED TEXT: NOTHING. Subjects, bodies, recipient
 * addresses and the `mit` column of a refused attempt are handed on as the
 * repository read them, for the page to render as React text children -- the
 * attempts view under an "idegen szöveg" label, because those are the words of
 * whoever tried. No branch here reads any of it, none of it reaches a query, a
 * file name, a URL or a refusal message, and this module spawns nothing, so
 * there is no shell for it to reach.
 */

/** The outbound rows and book entries one `board` carries, and the ceiling on the attempts list. */
const BOARD_KIMENO_LIMIT = 100
const ATTEMPTS_ALAP_LIMIT = 50
const ATTEMPTS_MAX_LIMIT = 500

/**
 * The runtime an MCP client has to spawn to run the shim, and what that spawn
 * needs in its environment.
 *
 * `process.execPath` rather than the word `node`, and the reason is the tts
 * module's own (extensions/tts/src/rpc.mjs, where this was first paid for): the
 * host spawns an MCP server with its own `process.env`, so a bare `node` is
 * resolved against the HOST's PATH, and a packaged desktop app is launched by
 * launchd with `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. No Node
 * installation puts a binary there. `process.execPath` needs no lookup and
 * cannot name a runtime that is absent, because the host is running on it; in
 * an Electron build that binary runs as Node only when `ELECTRON_RUN_AS_NODE`
 * is set, so the variable goes in the entry exactly when the host is Electron.
 *
 * WHAT IT DOES NOT PROMISE: an absolute path is a path, and MCP entries are
 * stored once by the operator. Moving or replacing the app changes
 * `process.execPath`, and the stored entry then names a runtime that is gone.
 * The page says to copy the block again after moving or updating the app,
 * because nothing here can rewrite a setting the host owns.
 *
 * The two arguments exist for the tests, which need both branches without
 * writing to `process`; nothing else passes them.
 */
export function shimRuntime({ execPath = process.execPath, electronVersion = process.versions.electron } = {}) {
  return {
    command: execPath,
    env: electronVersion ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  }
}

/**
 * One outbound row as the PAGE reads it, which is the whole row.
 *
 * DELIBERATELY WIDER THAN `OUTBOX_MEZOK` in contract.mjs, and written out here
 * rather than shared with it. The body is here because the operator has to read
 * what they are about to send before they send it, and the resolved addresses
 * are here because they have to see who it goes to and which of them the book
 * does not know. Neither may cross the contract, where the caller cannot be
 * identified: see that file's own accounting. Two projections in two files is
 * the point, not a duplication to tidy up -- one shared builder is exactly how
 * the page's next field would reach a consumer for free.
 *
 * The three JSON columns are this module's own writes; a row whose JSON is
 * broken throws rather than reporting an empty list, because "addressed to
 * nobody" is a false report about a letter that names people.
 */
function kimenoLapSor(sor) {
  return {
    id: sor.id,
    allapot: sor.allapot,
    ajto: sor.ajto,
    cimzettHandlek: JSON.parse(sor.cimzett_handlek),
    cimzettCimek: JSON.parse(sor.cimzett_cimek),
    valaszUzenetId: sor.valasz_uzenet_id,
    targy: sor.targy,
    torzs: sor.torzs,
    torzsHash: sor.torzs_hash,
    gmailDraftId: sor.gmail_draft_id,
    gmailMessageId: sor.gmail_message_id,
    szerkesztveAt: sor.szerkesztve_at,
    konyvonKivul: JSON.parse(sor.cimzett_konyvon_kivul),
    kiadvaAt: sor.kiadva_at,
    hibaKod: sor.hiba_kod,
    hibaSzoveg: sor.hiba_szoveg,
    createdAt: sor.created_at,
    updatedAt: sor.updated_at,
  }
}

/** One refused attempt as the page shows it. `mit` is somebody else's text and travels as text. */
function kiserletSor(sor) {
  return { id: sor.id, ajto: sor.ajto, kod: sor.kod, mit: sor.mit, at: sor.at }
}

/**
 * Builds the `rpc` map index.mjs declares.
 *
 * `workspaceDir` and `portFile` arrive from index.mjs: the workspace is where
 * the shim lives, and the port file path repeats the host's own rule there
 * because extension code cannot import `data-dir.ts`. Both are reported by
 * `health` and `mcpConfig` so the operator can check them against what the host
 * actually wrote -- nothing on this side can check it for them.
 */
export function createRpc(state, { workspaceDir, portFile } = {}) {
  if (typeof workspaceDir !== 'string' || workspaceDir === '') throw new Error('createRpc needs workspaceDir: the MCP entry names the shim by absolute path')
  if (typeof portFile !== 'string' || portFile === '') throw new Error('createRpc needs portFile: without it the MCP entry cannot tell the shim where to find this host')
  const shim = path.join(workspaceDir, 'mcp', 'server.mjs')
  const olvasas = createOlvasas(state)
  const cimkezes = createCimkezes(state)
  const cimzettek = createCimzettek(state)
  const piszkozat = createPiszkozat(state)
  const kiadas = createKiadas(state)

  /** One outbound row that is a draft with a draft standing in Gmail, or a refusal. The same two facts and the same two codes the release uses. */
  const piszkozatSor = (kimenoId) => {
    const sor = state.repo.kimeno(kimenoId)
    if (!sor) refuse('gmail_kimeno_ismeretlen', 'nincs ilyen kimeno sor', { kimenoId })
    if (sor.allapot !== 'piszkozat') refuse('gmail_kimeno_allapot', `ez a sor nem piszkozat, hanem ${sor.allapot}`, { kimenoId, allapot: sor.allapot })
    if (sor.gmail_draft_id === '') refuse('gmail_kimeno_allapot', 'ehhez a sorhoz nem tartozik Gmail-piszkozat', { kimenoId, allapot: sor.allapot })
    return sor
  }

  return {
    /**
     * Everything one page load needs: the status, the outbound queue and the
     * address book.
     *
     * The attempts list is NOT here and has its own method: it is one of the
     * page's three views and the only one an operator opens on purpose, so a
     * board that carried it would fetch a log nobody asked for on every reload.
     *
     * `konyv` is the whole book rather than its size, because the Recipients
     * view draws it and there is no other read that could: the book is not on
     * the contract and has no listing method of its own. `szamok.cimzettek` in
     * the health block is the same count from the other side.
     *
     * READS ONLY. It makes the one profile request `health` makes and nothing
     * else; it does not read a draft out of Gmail (that is `liveDraft`, one row
     * at a time, and doing it for every row here would be one request per draft
     * on every page load), it writes no row, and it spends no budget slot.
     */
    async board() {
      return guard(async () => {
        const kimeno = kiadas.outbox({ limit: BOARD_KIMENO_LIMIT })
        return {
          health: await runHealth(state, { portFile }),
          kimeno: { total: kimeno.total, count: kimeno.count, items: kimeno.items.map(kimenoLapSor) },
          kimenoLimit: BOARD_KIMENO_LIMIT,
          konyv: cimzettek.konyv(),
        }
      })
    },

    /**
     * The status bar's facts on their own (health.mjs): which wall is in the
     * way, what did not answer, what is narrowed, the connected address, the
     * day's two budgets and the row counts. No key and no token value, ever.
     */
    async health() {
      return guard(() => runHealth(state, { portFile }))
    },

    /**
     * One page of message ids, with the cursor. The method this module exists
     * for; the shim's `gmail_search` is this call, and `query` reaches Gmail
     * literally.
     */
    async search(body = {}) {
      return guard(() => olvasas.list({ labelIds: body.labelIds, q: body.query, max: body.max, cursor: body.cursor }))
    },

    /** One message, projected onto the ten fields of `UZENET_MEZOK` (olvasas.mjs). */
    async read(body = {}) {
      return guard(() => olvasas.get({ id: body.id, format: body.format }))
    },

    /** Every label in the mailbox, so a caller can pick the id it wants by the name it knows. */
    async labels() {
      return guard(() => olvasas.labels())
    },

    /**
     * Adds and removes labels on one message. `TRASH`, `SPAM`, `SENT` and
     * `DRAFT` are refused by name (olvasas.mjs); permanent deletion is not
     * refused here because it is not reachable at all -- the grant this module
     * asks for does not cover it.
     */
    async label(body = {}) {
      return guard(() => cimkezes.label({ id: body.id, hozzaad: body.hozzaad, elvesz: body.elvesz }))
    },

    /**
     * Writes one draft. `AJTOK.RPC` is the second POSITIONAL argument and a
     * constant in this file, so the row records the door this came through and
     * no caller can spell it.
     */
    async draft(body = {}) {
      return guard(() => piszkozat.draft(body, AJTOK.RPC))
    },

    /** A page of outbound rows for the page, whole rows, with the total behind them. See `kimenoLapSor` for why this is wider than the contract's. */
    async outbox(body = {}) {
      return guard(() => {
        const lap = kiadas.outbox({ allapot: body.allapot, limit: body.limit, offset: body.offset })
        return { total: lap.total, count: lap.count, items: lap.items.map(kimenoLapSor) }
      })
    },

    /**
     * The draft AS IT STANDS IN GMAIL RIGHT NOW, with the fingerprint the
     * release will check against.
     *
     * THE PAGE HAS TO SEND BACK THE HASH OF THE LIVE DRAFT, NOT THE ROW'S, and
     * that is the whole reason this method exists. The release reads the draft
     * fresh out of Gmail and compares `megerosites` against a hash of what is
     * actually there; a page that confirmed the row's stored hash would be
     * refused with `gmail_lap_elavult` for every draft the operator had touched
     * in their own mail client -- and the branch that exists exactly for that
     * case, where the row is brought up to what is there and marked "edited in
     * Gmail", would be unreachable. So `eloHash` here is computed by
     * `eloHashOf`, THE SAME FUNCTION the release uses, over the same draft
     * shape: two implementations of one fingerprint is how a page ends up
     * confirming a hash of something other than what it displayed.
     *
     * `torzs` and `cimek` come back beside it because the page must display the
     * bytes it is confirming. Showing the row's body and confirming the live
     * hash would be the same defect one step over.
     *
     * IT WRITES NOTHING. `szerkesztve` reports that the live draft differs from
     * the row, and the row is deliberately not updated here: bringing it up to
     * date belongs to the release, where a person is acting, and a page load
     * that quietly rewrote what the operator last saw would erase the very
     * difference it is meant to show them.
     *
     * It does not say which recipients are outside the book either, though it
     * has the addresses. The release makes that judgement against the book as
     * it stands at the moment of sending, and a second copy of the rule here
     * could disagree with it -- the page shows the addresses and the book, both
     * of which it already has.
     */
    async liveDraft(body = {}) {
      return guard(async () => {
        const kimenoId = readString('kimenoId', body.kimenoId, { required: true, max: 64 })
        // Held to the id shape before any refusal below repeats it: an id a
        // caller sent is a caller's string, and the refusals name which row was
        // not found. Sixteen hex characters can carry nothing into a log line or
        // an agent's next prompt.
        if (!KIMENO_ID_RE.test(kimenoId)) refuse('gmail_argumentum_alak', `kimenoId csak ezt az alakot veheti fel: ${KIMENO_ID_RE.source}`)
        const sor = piszkozatSor(kimenoId)
        const elo = await clientFor(state).getDraft(sor.gmail_draft_id)
        const eloHash = eloHashOf(elo)
        return {
          kimenoId,
          gmailDraftId: sor.gmail_draft_id,
          cimek: typeof elo.to === 'string' ? elo.to : '',
          targy: typeof elo.subject === 'string' ? elo.subject : '',
          torzs: typeof elo.text === 'string' ? elo.text : '',
          eloHash,
          sorHash: sor.torzs_hash,
          szerkesztve: eloHash !== sor.torzs_hash,
        }
      })
    },

    /**
     * Sends one draft, after checking that the bytes about to go out are the
     * bytes a person looked at. The only method in this module that sends, and
     * the only one that is here and on no other surface.
     *
     * A send that was asked for and did not answer leaves the row
     * `bizonytalan`: neither sent nor failed, terminal, and never offered a
     * release again -- a second send is worse than not knowing, and the answer
     * only exists in the mailbox's Sent folder.
     */
    async releaseDraft(body = {}) {
      return guard(() => kiadas.releaseDraft(body, AJTOK.RPC))
    },

    /** Deletes the Gmail draft, then closes the row. In that order: a visible inconsistency beats a hidden one. */
    async discardDraft(body = {}) {
      return guard(() => kiadas.discardDraft(body, AJTOK.RPC))
    },

    /**
     * Adds one entry to the address book. THE ONLY PLACE AN E-MAIL ADDRESS
     * ENTERS THIS MODULE by being typed, and it is typed by the operator on
     * this module's own page. It is not on the contract, and that is the gate
     * the whole outbound design rests on.
     */
    async addRecipient(body = {}) {
      return guard(() => cimzettek.addRecipient({ handle: body.handle, cim: body.cim, megjegyzes: body.megjegyzes }))
    },

    /** Retires one entry. The row is kept, not deleted: an outbound row that named the handle has to stay readable. */
    async retireRecipient(body = {}) {
      return guard(() => cimzettek.retireRecipient({ handle: body.handle }))
    },

    /**
     * The refused outbound attempts, newest first. This is the view where an
     * injection attempt is visible: a newsletter sentence that tried to address
     * a letter gets no further than a row here with `gmail_cimzett_cim_literal`
     * on it. `mit` is what somebody asked for and the page labels it as such.
     */
    async attempts(body = {}) {
      return guard(() => {
        const hatar = readWholeNumber('limit', body.limit, { min: 1, max: ATTEMPTS_MAX_LIMIT, fallback: ATTEMPTS_ALAP_LIMIT })
        return { items: state.repo.kiserletek(hatar).map(kiserletSor), limit: hatar }
      })
    },

    /**
     * The Settings > MCP Servers entry for the shim, for the page to show as
     * text the operator copies.
     *
     * The access key is named by its variable and never by its value: the
     * operator copies it from the host's own `.env.local`, and nothing on this
     * side reads it.
     */
    async mcpConfig() {
      return guard(() => {
        const runtime = shimRuntime()
        return {
          id: 'gmail',
          name: 'SwarmClaw Gmail (gmail)',
          transport: 'stdio',
          command: runtime.command,
          args: [shim],
          env: {
            ...runtime.env,
            SWARMCLAW_PORT_FILE: portFile,
            SWARMCLAW_ACCESS_KEY: 'az ACCESS_KEY értéke a host .env.local fájljából; ide kézzel',
          },
        }
      })
    },
  }
}
