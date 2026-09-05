import fs from 'node:fs'
import os from 'node:os'

import { readWholeNumber } from './args.mjs'
import { OAUTH_PURPOSE, clientFor } from './client.mjs'
import { GmailError } from './hibak.mjs'
import { NAPI_KIADAS_ALAP } from './kiadas.mjs'
import { NAPI_PISZKOZAT_ALAP, napKulcs } from './kimeno.mjs'

/**
 * What this module can say about its own readiness, and the one list the page
 * reads its sentences from.
 *
 * THREE FACTS, KEPT APART, because right now this module is all three at once
 * and a single boolean would report them alike:
 *
 *   - A MODULE THAT CANNOT BE ASKED. There is no Google OAuth client on this
 *     host today, so the connect route answers 409 `google_oauth_client_missing`
 *     and there is no credential to have. Nothing reaches Gmail, and the remedy
 *     is two environment variables and a restart. These are `hibak`.
 *   - A MODULE THAT WAS ASKED AND ANSWERED NOTHING. A credential is stored, the
 *     profile read went out, and it timed out or failed transport. That is not
 *     "disconnected" and must never be reported as one: the remedy is to look
 *     again later, not to reconnect an account that may be perfectly well
 *     connected. These are `nemValaszolt`, and they carry WHAT was asked beside
 *     the code we got instead of an answer.
 *   - A MODULE THAT IS SIMPLY IDLE. No recipients in the book, no outbound rows,
 *     nothing sent today. That is a fresh install, not a failure, and it appears
 *     in `szamok` and `keretek` rather than in any of the three lists.
 *
 * WHY `hibak` AND `figyelmeztetesek` SPLIT WHERE THEY DO. A code is a `hiba`
 * when NOTHING this module does reaches the mailbox: no read, no draft, no
 * release. It is a `figyelmeztetes` when the two doors still answer and one
 * capability is narrower than it looks -- an empty address book (a reply draft
 * still works, a draft to a handle has no handle to name) and a missing port
 * file (an agent's MCP shim cannot find this host; code and page are
 * unaffected). Both lists carry `blokkol`, which names the capabilities
 * actually stopped right now, so "warning" is never read as "nothing is
 * stopped".
 *
 * WHAT NEVER LEAVES HERE. No key, no token, no part of one, and no message from
 * a thrown host error (design spec 5.5: "kulcs- es tokenertek soha"). The
 * settings object is never spread into the answer either, so a secret field
 * added to `ui.settingsFields` later cannot ride out of here: the two budget
 * numbers are read by name, and nothing else in settings is read at all.
 *
 * NO NUMBER IS GUESSED. A budget setting that is present and unreadable answers
 * `keret: null` with `olvashatatlan: true`, never the default -- showing the
 * default would tell the operator a limit that the next draft will refuse to
 * honour, by name.
 */

/**
 * What this module can be stopped from doing, as the vocabulary `blokkol`
 * draws from.
 *
 * `piszkozat_konyvbol` and `piszkozat_valasz` are two entries rather than one
 * because exactly one condition tells them apart: an empty address book stops
 * the first and leaves the second working. Folding them into one "piszkozat"
 * would make the empty-book sentence claim more than it can.
 */
export const KEPESSEGEK = Object.freeze(['olvasas', 'piszkozat_konyvbol', 'piszkozat_valasz', 'kiadas', 'mcp'])

/** Everything the mailbox credential is behind: read, both drafting paths, release. */
const MINDEN_GMAIL = Object.freeze(['olvasas', 'piszkozat_konyvbol', 'piszkozat_valasz', 'kiadas'])

/**
 * Every health code, with the sentence the page shows for it and what it stops.
 *
 * ONE PLACE, so the code list and the page's sentences cannot drift. `HEALTH_CODES`
 * below is derived from these keys rather than typed a second time, which is
 * what makes "every code has a sentence, and every sentence has a code" a
 * property of the file instead of a promise a test has to police across two
 * lists. The page renders `mondat` and `teendo` as text children; neither is
 * built from anything a caller sent.
 *
 * WHERE THIS DEPARTS FROM THE SPEC'S TABLE (design spec 7.3), and why: the spec
 * writes the empty-book sentence as "tehat piszkozat sem keszitheto", and that
 * is more than the code does. `draft({ valaszUzenetId })` resolves its one
 * recipient from the replied-to message's envelope and never touches the book,
 * so a reply draft is written with an empty book. The sentence here says which
 * of the two is stopped, because a status line that overstates is the same
 * defect as one that understates.
 */
const HEALTH_LAP = Object.freeze({
  google_oauth_client_missing: Object.freeze({
    fal: true,
    blokkol: MINDEN_GMAIL,
    mondat: 'Nincs Google OAuth-kliens konfigurálva ezen a hoston. A bekötés gomb ezért ki van kapcsolva.',
    teendo: 'Állítsd be a módhoz tartozó két környezeti változót (desktop: GOOGLE_OAUTH_CLIENT_DESKTOP_ID és GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET; vps: GOOGLE_OAUTH_CLIENT_WEB_ID és GOOGLE_OAUTH_CLIENT_WEB_SECRET), majd indítsd újra a hostot.',
  }),
  gmail_hitelesites_hianyzik: Object.freeze({
    fal: true,
    blokkol: MINDEN_GMAIL,
    mondat: 'A kliens megvan, a postafiók nincs bekötve.',
    teendo: 'Kösd be a postafiókot a Bekötés gombbal.',
  }),
  gmail_scope_missing: Object.freeze({
    fal: true,
    blokkol: MINDEN_GMAIL,
    mondat: 'A meglévő engedély nem fedi ezt a műveletet.',
    teendo: 'Kösd be újra a postafiókot, hogy az engedély a gmail.modify hatókört is tartalmazza.',
  }),
  gmail_token_revoked: Object.freeze({
    fal: true,
    blokkol: MINDEN_GMAIL,
    mondat: 'Az engedély lejárt vagy visszavonva. Ha a consent screen Testing módban van, ez 7 naponta ismétlődik.',
    teendo: 'Kösd be újra a postafiókot; tartós használathoz a Google-projekt consent screenje nem maradhat Testing módban.',
  }),
  gmail_cimzettkonyv_ures: Object.freeze({
    fal: false,
    blokkol: Object.freeze(['piszkozat_konyvbol']),
    mondat: 'Nincs élő címzett a könyvben, tehát könyvbeli handle-re címzett piszkozat nem készíthető. Válasz-piszkozat készíthető, mert annak a címzettje a megválaszolt levél borítékjából jön.',
    teendo: 'Vegyél fel egy címzettet a Címzettek nézetben. Ez az egyetlen hely, ahol e-mail-cím keletkezik ehhez a modulhoz.',
  }),
  gmail_port_fajl_hianyzik: Object.freeze({
    fal: false,
    blokkol: Object.freeze(['mcp']),
    mondat: 'Az MCP-szerver nem találná meg ezt a hostot: a port-fájl hiányzik, nem a várt alakú, vagy a benne álló folyamat nem ebből az indításból való.',
    teendo: 'Ellenőrizd, hogy fut-e a host, és hogy az MCP-bejegyzés SWARMCLAW_PORT_FILE értéke erre az útvonalra mutat.',
  }),
})

/**
 * The health vocabulary, in the order the page shows it: the first wall first.
 *
 * These are not refusals and nothing throws them; they describe a state
 * (`hibak.mjs` says the same from the other side). `google_oauth_client_missing`
 * appears in both lists because it is both a state and a refusal, and it keeps
 * the host's own spelling in each.
 */
export const HEALTH_CODES = Object.freeze(Object.keys(HEALTH_LAP))

/** The sentence and the remedy for one code, for the page. Returns null for anything outside the vocabulary. */
export function healthLap(kod) {
  return Object.prototype.hasOwnProperty.call(HEALTH_LAP, kod) ? HEALTH_LAP[kod] : null
}

/**
 * The codes a failed profile read maps onto, and the one translation in this
 * file.
 *
 * `gmail_token_missing` becomes `gmail_hitelesites_hianyzik` because they are
 * one fact seen from two sides: the host has no stored credential. It is
 * reachable despite the `hasGoogleCredential` check above it -- a credential
 * deleted between the check and the call -- and reporting it as "the mailbox
 * did not answer" would send the operator looking at Google for something that
 * is missing here.
 *
 * The other token codes (`gmail_token_unreadable`, `gmail_refresh_failed`) are
 * deliberately NOT mapped: an undecryptable store and a failed refresh are not
 * a revoked grant, and answering `gmail_token_revoked` for them would tell the
 * operator to reconnect an account that may be fine. They land in
 * `nemValaszolt` under their own codes.
 */
const PROFIL_KOD = Object.freeze({
  gmail_token_missing: 'gmail_hitelesites_hianyzik',
  gmail_token_revoked: 'gmail_token_revoked',
  gmail_scope_missing: 'gmail_scope_missing',
})

/**
 * Mirrors BOOT_TOLERANCE_MS in the host's port-file.ts and in the tts shim: how
 * far before the estimated boot instant `startedAt` may fall and still count as
 * this boot.
 */
const BOOT_TOLERANCE_MS = 60_000

const isWholeNumber = (v) => typeof v === 'number' && Number.isSafeInteger(v)
const isPort = (v) => isWholeNumber(v) && v >= 1 && v <= 65535

/**
 * Whether the host's port file is there, is the shape the shim reads, and names
 * a process from this boot that is still alive.
 *
 * WHAT THIS DOES NOT CLAIM, and the page must not say it does: it is checks 1
 * and 2 of the shim's four (`extensions/tts/mcp/server.mjs`), and checks 3 and
 * 4 -- `GET /api/healthz` answering `service: "swarmclaw"` with the file's own
 * instance token -- are deliberately absent. A status bar must not make an HTTP
 * request to its own host on every page load, and the shim makes both checks on
 * every tool call anyway, where a host that restarted since is caught. So `elo:
 * true` means "a file naming a live pid from this boot is where the MCP entry
 * points", not "the MCP server will connect".
 *
 * The file's contents are never returned. The port and the pid are facts about
 * this host and not secrets, but nothing on the page needs them, and a status
 * line is the wrong place to widen what it prints.
 *
 * EXPORTED FOR scripts/install.mjs, which reports the same fact before there is
 * a host to ask. That script runs in a terminal with no host in the process, so
 * it cannot call `health`; what it can do is look at the file, and it looks at
 * it through this function rather than through a second copy of these checks.
 * A second copy is how the installer's row and the status bar's row come to
 * disagree about the same file.
 */
export function portFajlAllapot(portFile) {
  const out = { utvonal: portFile, letezik: false, elo: false }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(portFile, 'utf8'))
  } catch {
    return out
  }
  out.letezik = true
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  const { port, wsPort, pid, startedAt, instanceId } = parsed
  if (!isPort(port) || !isPort(wsPort)) return out
  if (!isWholeNumber(pid) || pid < 1) return out
  if (!isWholeNumber(startedAt)) return out
  if (typeof instanceId !== 'string' || instanceId === '') return out
  if (startedAt < Date.now() - os.uptime() * 1000 - BOOT_TOLERANCE_MS) return out
  try {
    process.kill(pid, 0)
    out.elo = true
  } catch (err) {
    // EPERM is a process owned by another user, which is still a live pid.
    out.elo = err instanceof Error && err.code === 'EPERM'
  }
  return out
}

/**
 * The deploy mode the host's OAuth client lookup runs in, by the host's own
 * rule in `src/lib/server/oauth/google.ts` (`resolveGoogleDeployMode`),
 * repeated here because an extension may not import that file.
 *
 * A SECOND COPY OF ONE RULE, and it is worth being exact about what rides on
 * it: only WHICH PAIR of environment variables the page names in the remedy.
 * Whether a client is configured at all is the host's own answer through
 * `googleClientConfigured()`, so a drift here cannot make the page claim a
 * client exists or does not. It can only make it name the desktop pair on a
 * VPS, which the operator sees against their own environment.
 */
function deployMode() {
  return process.env.SWARMCLAW_DEPLOY_MODE?.trim() === 'desktop' ? 'desktop' : 'vps'
}

/**
 * One budget as the page shows it: what the operator set, and what has been
 * spent today.
 *
 * The bound and the default are the enforcing layer's own constants, imported
 * rather than repeated, so the number on the status bar and the number the
 * refusal counts against cannot disagree. A setting that is present and cannot
 * be read is `keret: null` with `olvashatatlan: true` and never the default:
 * the next draft or release will refuse that setting by name, and a status bar
 * showing 20 would have promised otherwise.
 */
function keret(state, kulcs, alap, mai) {
  try {
    return { mai, keret: readWholeNumber(kulcs, state.settings()[kulcs], { min: 0, fallback: alap }), olvashatatlan: false }
  } catch {
    return { mai, keret: null, olvashatatlan: true }
  }
}

/**
 * Every condition this module can answer, answered now.
 *
 * THE ORDER OF THE CREDENTIAL CHAIN IS THE POINT (plan Task 8): client, then
 * credential, then the mailbox itself, and each one stops the chain. "The
 * mailbox is not connected" under a host that has no OAuth client at all is a
 * true sentence that sends the operator to the wrong place -- there is no
 * button that could connect it -- so the first wall is the only one reported.
 *
 * The address book and the port file are NOT part of that chain and are
 * answered whatever it said: an empty book and a missing port file mean exactly
 * the same thing with or without a credential, and dropping them while the
 * credential is missing would make them appear only after the operator fixed
 * something else.
 *
 * ONE NETWORK CALL, and only when there is a credential to make it with: the
 * profile read that answers `postafiok`. It doubles as the only probe that can
 * tell a stored credential Google still honours from one it does not, which is
 * where `gmail_scope_missing` and `gmail_token_revoked` come from; there is no
 * way to learn either without asking. A failure that is neither is reported as
 * a question that did not answer, never as a disconnected mailbox.
 *
 * NOTHING HERE WRITES. No row, no counter, no budget slot: `napi` reads the
 * day, `bumpNapi` is not called, and opening a page must not spend anything.
 */
export async function runHealth(state, { portFile } = {}) {
  if (typeof portFile !== 'string' || portFile === '') {
    throw new Error('runHealth needs the portFile path: index.mjs computes it, and a health that computed its own would be a third copy of the host rule')
  }
  const hibak = []
  const figyelmeztetesek = []
  const nemValaszolt = []
  const jelent = (kod, extra = {}) => {
    const lap = healthLap(kod)
    if (!lap) throw new Error(`runHealth: unknown health code ${JSON.stringify(kod)}`)
    ;(lap.fal ? hibak : figyelmeztetesek).push({ kod, ...extra })
  }

  let postafiok = null
  const oauth = state.oauth
  if (typeof oauth?.googleClientConfigured !== 'function' || typeof oauth?.hasGoogleCredential !== 'function') {
    // A host old enough not to carry these cannot be asked the question at all,
    // and guessing either way would be a false report in one direction or the
    // other. It is reported as unanswered rather than crashing the status bar.
    nemValaszolt.push({ mit: 'kliens', kod: null })
  } else if (!oauth.googleClientConfigured()) {
    jelent('google_oauth_client_missing', { mode: deployMode() })
  } else {
    let vanHitelesito = false
    try {
      vanHitelesito = oauth.hasGoogleCredential(OAUTH_PURPOSE) === true
    } catch (err) {
      // The host reads the stored credential off disk to answer this, so it can
      // fail rather than answer. Saying "not connected" for a check that blew up
      // sends the operator to reconnect an account that may be fine.
      state.log?.warn?.('gmail: could not check the Google credential', { message: err instanceof Error ? err.message : String(err) })
      nemValaszolt.push({ mit: 'hitelesites', kod: null })
      vanHitelesito = null
    }
    if (vanHitelesito === false) {
      jelent('gmail_hitelesites_hianyzik')
    } else if (vanHitelesito === true) {
      try {
        postafiok = await clientFor(state).mailbox()
      } catch (err) {
        const kod = err instanceof GmailError ? err.code : null
        const lapKod = kod === null ? null : PROFIL_KOD[kod]
        if (lapKod) jelent(lapKod)
        else nemValaszolt.push({ mit: 'postafiok', kod })
      }
    }
  }

  if (state.repo.eloCimzettCount() === 0) jelent('gmail_cimzettkonyv_ures')

  const portFajl = portFajlAllapot(portFile)
  if (!portFajl.elo) jelent('gmail_port_fajl_hianyzik')

  const nap = napKulcs()
  const napi = state.repo.napi(nap)
  const blokkolt = [...new Set([...hibak, ...figyelmeztetesek].flatMap((h) => [...healthLap(h.kod).blokkol]))].sort()
  return {
    ok: hibak.length === 0,
    hibak,
    figyelmeztetesek,
    nemValaszolt,
    blokkolt,
    postafiok,
    keretek: {
      nap,
      piszkozat: keret(state, 'napiPiszkozat', NAPI_PISZKOZAT_ALAP, napi.piszkozat),
      kiadas: keret(state, 'napiKiadas', NAPI_KIADAS_ALAP, napi.kiadas),
    },
    szamok: state.repo.counts(),
    portFajl,
  }
}
