import type { HealthItem, KonyvSor, McpConfig } from './api'

/**
 * The words the page puts next to the facts, kept out of the components so
 * test/ui.test.mjs can pin each phrase against the fact it reports.
 *
 * Everything here returns plain strings for a component to render as text.
 * None of it builds markup, none of it produces a url, and none of it reads a
 * stored row's content for anything but display.
 */

/** The two deploy modes the host's own client lookup distinguishes, and the env pair each one reads. */
const ENV_PAROK: Readonly<Record<string, string>> = Object.freeze({
  desktop: 'GOOGLE_OAUTH_CLIENT_DESKTOP_ID és GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET',
  vps: 'GOOGLE_OAUTH_CLIENT_WEB_ID és GOOGLE_OAUTH_CLIENT_WEB_SECRET',
})

/**
 * Every health code, with the sentence this page says for it and the remedy
 * beside it.
 *
 * ONE ENTRY PER CODE, NEVER FOLDED. The six codes of design spec 7.3 describe
 * six different situations with six different things to do, and a status bar
 * that answered them with one red dot would throw that separation away at the
 * last step. `test/ui.test.mjs` compares these keys against `HEALTH_CODES` in
 * `src/health.mjs` in both directions, so a code the server can send with no
 * sentence here, and a sentence here for a code the server cannot send, are
 * both test failures rather than something a reader has to notice.
 *
 * WHY THIS IS A SECOND TABLE AND NOT THE SERVER'S. `src/health.mjs` carries
 * its own `mondat`/`teendo` pair per code, and neither travels over the wire:
 * `runHealth` answers with codes. Two of the sentences also differ on purpose
 * -- this one names the deploy mode's OWN env pair (see `healthMondat`), where
 * the server's names both pairs because it is not writing for a screen that
 * already knows the mode. The gate against drift is the test, not a shared
 * module: the page cannot import `health.mjs`, which reads `node:fs`.
 *
 * The empty-book sentence says which of the two drafting paths is stopped, not
 * "no draft can be written": `draft({ valaszUzenetId })` resolves its recipient
 * from the replied-to envelope and never touches the book, so a reply draft is
 * written with an empty book. The spec's table overstates it, and a status line
 * that overstates is the same defect as one that understates.
 */
const HEALTH_LAP: Readonly<Record<string, { mondat: string; teendo: string }>> = Object.freeze({
  google_oauth_client_missing: Object.freeze({
    mondat: 'Nincs Google OAuth-kliens konfigurálva ezen a hoston. A bekötés gomb ezért ki van kapcsolva.',
    teendo: 'Hozz létre egy Google Cloud OAuth-klienst, állítsd be a két környezeti változót, majd indítsd újra a hostot.',
  }),
  gmail_hitelesites_hianyzik: Object.freeze({
    mondat: 'A kliens megvan, a postafiók nincs bekötve.',
    teendo: 'Kösd be a postafiókot a Bekötés gombbal.',
  }),
  gmail_scope_missing: Object.freeze({
    mondat: 'A meglévő engedély nem fedi ezt a műveletet.',
    teendo: 'Kösd be újra a postafiókot, hogy az engedély a gmail.modify hatókört is tartalmazza.',
  }),
  gmail_token_revoked: Object.freeze({
    mondat: 'Az engedély lejárt vagy visszavonva. Ha a consent screen Testing módban van, ez 7 naponta ismétlődik.',
    teendo: 'Kösd be újra a postafiókot; tartós használathoz a Google-projekt consent screenje nem maradhat Testing módban.',
  }),
  gmail_cimzettkonyv_ures: Object.freeze({
    mondat: 'Nincs élő címzett a könyvben, tehát könyvbeli handle-re címzett piszkozat nem készíthető. Válasz-piszkozat készíthető, mert annak a címzettje a megválaszolt levél borítékjából jön.',
    teendo: 'Vegyél fel egy címzettet a Címzettek nézetben. Ez az egyetlen hely, ahol e-mail-cím keletkezik ehhez a modulhoz.',
  }),
  gmail_port_fajl_hianyzik: Object.freeze({
    mondat: 'Az MCP-szerver nem találná meg ezt a hostot: a port-fájl hiányzik, nem a várt alakú, vagy a benne álló folyamat nem ebből az indításból való.',
    teendo: 'Ellenőrizd, hogy fut-e a host, és hogy az MCP-bejegyzés SWARMCLAW_PORT_FILE értéke erre az útvonalra mutat.',
  }),
})

/**
 * The codes this page has a sentence for.
 *
 * The test holds this equal to the server's own `HEALTH_CODES`, in both
 * directions. It is also read at runtime, by the one branch that has to admit
 * ignorance: a code with no sentence here prints this list beside it, so an
 * operator looking at an unfamiliar code can see what this bundle does know
 * and tell "the page is older than the module" from "the module is broken".
 */
export const LAP_HEALTH_CODES: readonly string[] = Object.freeze(Object.keys(HEALTH_LAP))

export interface HealthMondat {
  kod: string
  mondat: string
  teendo: string
  /** False for a code this page has no sentence for. The code is still shown; it is never dropped and never given another code's words. */
  ismert: boolean
}

/**
 * The sentence and the remedy for one health item.
 *
 * `google_oauth_client_missing` is the one code whose remedy depends on
 * something the item carries: the host resolves a desktop client and a web
 * client from different environment variables, and naming the wrong pair sends
 * the operator to set two variables that will not be read. So the mode is
 * printed and its own pair named; a mode this page does not recognise names
 * both pairs and says the mode was not reported, rather than guessing one.
 *
 * A code with no sentence here is shown AS THE CODE, with a line saying this
 * page has no sentence for it. That is the honest answer for a server newer
 * than its own bundle, and it is the opposite of dropping the item -- which
 * would turn a condition the server is reporting into a page that looks calm.
 */
export function healthMondat(item: HealthItem): HealthMondat {
  const kod = typeof item?.kod === 'string' ? item.kod : ''
  const lap = Object.prototype.hasOwnProperty.call(HEALTH_LAP, kod) ? HEALTH_LAP[kod] : null
  if (!lap) {
    return {
      kod,
      mondat: kod === '' ? 'A health egy kódot küldött, aminek nincs neve.' : kod,
      teendo: `Ehhez a kódhoz ezen a lapon nincs mondat; a modul újabb, mint ez a bundle. Ez a lap ezeket a kódokat ismeri: ${LAP_HEALTH_CODES.join(', ')}.`,
      ismert: false,
    }
  }
  if (kod !== 'google_oauth_client_missing') return { kod, mondat: lap.mondat, teendo: lap.teendo, ismert: true }

  const mode = typeof item.mode === 'string' ? item.mode : ''
  const par = Object.prototype.hasOwnProperty.call(ENV_PAROK, mode) ? ENV_PAROK[mode] : null
  const modMondat = par === null
    ? 'A host nem mondta meg, melyik módban fut, ezért mindkét változópár itt van.'
    : `Mód: ${mode}.`
  const parMondat = par === null
    ? `desktop módban ${ENV_PAROK.desktop}, vps módban ${ENV_PAROK.vps}`
    : par
  return {
    kod,
    mondat: `${lap.mondat} ${modMondat}`,
    teendo: `${lap.teendo} A két változó: ${parMondat}.`,
    ismert: true,
  }
}

/**
 * Whether the connect button may be pressed at all.
 *
 * FALSE MEANS DISABLED, NOT HIDDEN. With no OAuth client on this host the
 * consent flow cannot start, and the route answers 409 rather than a consent
 * screen. A button that vanished would leave the operator looking for the one
 * control the sentence beside it is telling them about; a button that stayed
 * live would send them to a JSON body on a blank tab. So it stays, disabled,
 * with the sentence.
 */
export function bekothetoE(hibak: readonly HealthItem[]): boolean {
  return !hibak.some((item) => item?.kod === 'google_oauth_client_missing')
}

/** `new Date(value)` is only trusted when it parsed; otherwise the stored text is shown as text. */
function dateOf(value: string): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A stored timestamp as a Hungarian date and time, or '' for none, or the raw text when it does not parse. */
export function formatDate(value: string | null | undefined): string {
  if (typeof value !== 'string' || value === '') return ''
  const date = dateOf(value)
  return date ? date.toLocaleString('hu-HU') : value
}

/**
 * One daily budget as two numbers.
 *
 * An unreadable setting prints `?` and says so rather than printing the
 * default: the next draft or release will refuse that setting by name, and a
 * status bar showing 20 would have promised a limit nothing is going to
 * honour.
 */
export function keretSzoveg(nev: string, mai: number, keret: number | null, olvashatatlan: boolean): string {
  const spent = Number.isFinite(mai) ? String(mai) : '?'
  if (olvashatatlan || keret === null) return `${nev} ${spent}/? — a beállítás nem olvasható, a következő kérés névvel fog elutasítani`
  return `${nev} ${spent}/${keret}`
}

/**
 * The five outbound states in words.
 *
 * The stored values are already Hungarian identifiers, so this is not a
 * translation: it is the difference between a heading a person reads and a
 * database value. A state this map has no word for is shown as the raw value
 * and flagged, because "this row is in a state the page does not know" is the
 * fact, and folding it into a state the page does know would be a false report
 * about a letter.
 */
export const ALLAPOT_HU: Readonly<Record<string, string>> = Object.freeze({
  piszkozat: 'Piszkozat',
  kiadva: 'Kiadva',
  elvetve: 'Elvetve',
  hiba: 'Hiba',
  bizonytalan: 'Bizonytalan',
})

export function allapotLabel(allapot: unknown): { label: string; known: boolean } {
  if (typeof allapot === 'string' && Object.prototype.hasOwnProperty.call(ALLAPOT_HU, allapot)) {
    return { label: ALLAPOT_HU[allapot], known: true }
  }
  if (typeof allapot !== 'string' || allapot === '') return { label: '(üres állapot)', known: false }
  return { label: allapot, known: false }
}

/**
 * What `bizonytalan` means, in the one place it is worded.
 *
 * THE FIFTH STATE IS NOT A FAILURE AND NOT A SUCCESS. `drafts.send` was called
 * and did not answer, so nobody on this side can say whether the letter left.
 * It is terminal: this page never offers a release for such a row, because a
 * second send is worse than not knowing, and the only place the answer exists
 * is the mailbox's Sent folder.
 */
export const BIZONYTALAN_MONDAT = 'A küldés elindult, és a Gmail nem válaszolt rá. Nem tudjuk, kiment-e a levél. Ez a sor lezárt: nem adható ki még egyszer, mert egy második küldés rosszabb, mint a bizonytalanság. Nézd meg a postafiók Elküldött mappáját.'

/** The `gmail_kiadas_bizonytalan` refusal is the same fact arriving as a refusal, and it gets the same sentence. */
export const BIZONYTALAN_KOD = 'gmail_kiadas_bizonytalan'

/**
 * Which door a row or an attempt came through.
 *
 * IT IS THE DOOR, NOT THE CALLER, and the labels say so. No verifiable caller
 * identity reaches this module: the rpc sits behind the app's access key and a
 * contract handle is a bearer capability. So `rpc` means "this page or the MCP
 * server" and not "the operator", and `szerzodes` means "some consumer
 * extension" and not which one.
 */
export function ajtoLabel(ajto: unknown): string {
  if (ajto === 'rpc') return 'rpc ajtó (ez a lap vagy az MCP-szerver)'
  if (ajto === 'szerzodes') return 'szerződés-ajtó (egy fogyasztó extension)'
  return typeof ajto === 'string' && ajto !== '' ? ajto : '(ismeretlen ajtó)'
}

/**
 * The live recipients the live book does not know, as a display aid and
 * nothing more.
 *
 * WHAT THIS IS NOT: the judgement the release makes. `releaseDraft` compares
 * the draft's addresses against the book AT THE MOMENT OF SENDING and stores
 * what it found on the row; that answer is the record. This one is computed
 * here so the operator can see the same thing BEFORE they press anything --
 * `liveDraft` deliberately does not make it, because a second copy of the rule
 * on the server could disagree with the first.
 *
 * A RETIRED ENTRY COUNTS AS OUTSIDE THE BOOK, exactly as in `kiadas.mjs`: the
 * operator took that address away, and a draft still carrying it is the thing
 * worth a second look. The case fold is on the comparison only; the addresses
 * are shown as they stand.
 */
export function konyvonKivuliek(cimek: readonly string[], konyv: readonly KonyvSor[]): string[] {
  const elo = new Set(
    konyv.filter((sor) => sor.visszavontAt === null).map((sor) => String(sor.cim).toLowerCase()),
  )
  return cimek.filter((cim) => !elo.has(String(cim).toLowerCase()))
}

/**
 * The addresses in a `To` header, split for display.
 *
 * A LOOSER SPLIT THAN THE SERVER'S, ON PURPOSE, and it decides nothing. The
 * release compares `cimekFejlecbol`'s reading of this same header against the
 * book and hashes the result; this one only decides where the page puts a line
 * break and which chip gets highlighted. It respects quotes and angle brackets
 * for the same reason -- a display name may contain a comma, and splitting
 * inside one would show two recipients where there is one -- and it hands back
 * the whole entry rather than the bare address, so a display name the operator
 * needs to recognise is not thrown away before they see it.
 */
export function cimekFejlecbol(fejlec: string): string[] {
  const darabok: string[] = []
  let darab = ''
  let idezojelben = false
  let szogletesben = false
  for (const ch of typeof fejlec === 'string' ? fejlec : '') {
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
  return darabok.map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/** The bare address inside a display-name entry, for the book comparison. The whole entry when there are no angle brackets. */
export function cimEntrybol(entry: string): string {
  const zart = typeof entry === 'string' ? entry.match(/<([^>]*)>/) : null
  return (zart ? zart[1] : String(entry ?? '')).trim()
}

/**
 * The MCP entry as the operator copies it.
 *
 * `JSON.stringify` with two spaces, into a `<pre>` as a text child. The access
 * key is named by its variable and never by its value; `mcpConfig` on the
 * server puts the instruction in the value's place, and this function does not
 * know the difference -- it prints what it was given.
 */
export function mcpJson(config: McpConfig): string {
  return JSON.stringify(config, null, 2)
}

/**
 * The address book in a form the operator can copy out before uninstalling.
 *
 * A REINSTALL STARTS WITH EMPTY TABLES AND THE BOOK IS GONE (design spec
 * 12.3). That is a deliberate consequence rather than a defect -- the book is
 * the only gate on the outbound side, and a gate that survives a reinstall
 * without anybody looking at it is not a gate -- so the page's job is to make
 * the loss visible in advance, not to prevent it.
 *
 * Retired entries are included and marked as retired: the operator decides
 * what to carry over, and silently dropping a row from a listing they are
 * about to rely on would decide it for them.
 *
 * A book that could not be READ is `null`, and it is never printed as an empty
 * one: "there is nothing to copy" and "nobody could say what there is to copy"
 * are different facts, and the second one is the one where the operator must
 * not start deleting.
 */
export function konyvKiiras(konyv: readonly KonyvSor[] | null): string {
  if (konyv === null) return '(a címzettkönyvet nem sikerült betölteni, tehát nem tudni, mi van benne)'
  if (konyv.length === 0) return '(a címzettkönyv üres)'
  return konyv
    .map((sor) => {
      const jegyzet = sor.megjegyzes === '' ? '' : `\t${sor.megjegyzes}`
      const allapot = sor.visszavontAt === null ? '' : `\t[visszavonva: ${sor.visszavontAt}]`
      return `${sor.handle}\t${sor.cim}${jegyzet}${allapot}`
    })
    .join('\n')
}
