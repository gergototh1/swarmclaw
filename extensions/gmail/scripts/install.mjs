import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { portFajlAllapot } from '../src/health.mjs'

/**
 * Installs this extension into a SwarmClaw data directory from the repo.
 *
 * The host normally writes an extension into a managed workspace itself
 * (saveExtensionSource), generating the top-level shim as it goes. That path
 * starts from source pasted into the UI; this one starts from the repo, so the
 * same layout is produced by hand:
 *
 *   <DATA_DIR>/extensions/gmail.mjs                 -- shim the loader requires
 *   <DATA_DIR>/extensions/.workspaces/gmail_mjs/    -- the actual module tree
 *
 * The workspace key is the extension filename with every character outside
 * [a-zA-Z0-9_-] replaced by '_', which is what extensionWorkspaceKey computes
 * for 'gmail.mjs'. Get it wrong and the host builds a different workspace
 * path, finds no index.js there, and loads the shim's target from nowhere.
 *
 * index.mjs lands in the workspace as index.js because that is the entry name
 * the host looks for. It stays ESM: the copied package.json carries
 * "type": "module", and its relative './src/...' imports resolve inside the
 * workspace.
 *
 * THIS EXTENSION SHIPS NO SKILLS, so there is no skills/ directory, no
 * shipped-skills.json manifest beside the workspace, and no removal pass over
 * <home>/skills. The tts and video installers carry one because they declare
 * managed agents that name skills; this module declares no agent and no
 * schedule at all (design spec 11.10), so there is nothing for a skill layer
 * to serve. The absence is the reason this script never joins an unvalidated
 * name onto a path and never deletes a directory.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// Where the desktop app keeps its home on this machine (electron/paths.ts:
// userData + '/home'), when this is a machine that has one. Only the macOS
// location is known here; on any other platform, or when the directory does
// not exist, this is null and the host's own fallbacks below apply.
function desktopHome() {
  if (process.platform !== 'darwin') return null
  const candidate = path.join(process.env.HOME || '', 'Library/Application Support/@swarmclawai/swarmclaw/home')
  return fs.existsSync(candidate) ? candidate : null
}

// Follows the host's own resolution order (src/lib/server/data-dir.ts): an
// explicit DATA_DIR wins, then SWARMCLAW_HOME/data, then the desktop app's
// home when this machine has one, and otherwise <cwd>/data -- which is what
// the host itself uses when started without either variable, in the container
// (WORKDIR /app, so /app/data, the compose volume) as much as from a checkout.
const explicitHome = process.env.SWARMCLAW_HOME || null
const desktop = explicitHome ? null : desktopHome()
const dataDir = process.env.DATA_DIR
  || (explicitHome ? path.join(explicitHome, 'data') : null)
  || (desktop ? path.join(desktop, 'data') : null)
  || path.join(process.cwd(), 'data')
const extDir = path.join(dataDir, 'extensions')
const wsDir = path.join(extDir, '.workspaces', 'gmail_mjs')

fs.mkdirSync(wsDir, { recursive: true })
// `mcp/` is the MCP server's own tree, which the host does not load: the
// operator points an MCP Servers entry at the copy in the workspace, and the
// shim there runs from it. It is copied like source because it is source.
const copied = []
for (const d of ['src', 'dist', 'mcp']) {
  const src = path.join(root, d)
  if (!fs.existsSync(src)) continue
  // Replace rather than merge: cpSync leaves a file that was renamed or deleted
  // in the repo sitting in the workspace, where it keeps being imported.
  fs.rmSync(path.join(wsDir, d), { recursive: true, force: true })
  fs.cpSync(src, path.join(wsDir, d), { recursive: true })
  copied.push(d)
}
fs.copyFileSync(path.join(root, 'index.mjs'), path.join(wsDir, 'index.js'))
fs.copyFileSync(path.join(root, 'package.json'), path.join(wsDir, 'package.json'))
fs.writeFileSync(path.join(extDir, 'gmail.mjs'), "export { default } from './.workspaces/gmail_mjs/index.js'\n")

console.log(`gmail installed: ${extDir}/gmail.mjs, workspace ${wsDir}`)
// The host does not register MCP servers on an extension's behalf, so the
// entry is the operator's to add. The exact JSON comes from the extension's
// own page once it is shipped; a checkout with no mcp/ has no server to
// register yet, and says so rather than pointing at a page that cannot show it.
if (copied.includes('mcp')) {
  console.log('A MCP-bejegyzést kézzel kell felvenni: Settings → MCP Servers; a pontos JSON a /x/gmail lapon.')
} else {
  console.log('Ez a kiadás még nem szállít MCP-szervert (nincs mcp/ könyvtár); MCP-bejegyzést nem kell felvenni.')
}

/**
 * Where a host started from THIS environment would write `run/port.json`.
 *
 * The rule is `resolvePortFile` in index.mjs -- SWARMCLAW_HOME wins and puts
 * `run/` beside `data/`, otherwise `run/` sits under the data directory -- with
 * the installer's own desktop-home fallback in front of it, because the desktop
 * app sets SWARMCLAW_HOME for itself and this terminal does not have it. That
 * fallback is the one difference from index.mjs and it exists so that an
 * install run by hand against the desktop app checks the file the desktop app
 * actually writes rather than a `data/run/port.json` under the current
 * directory that nothing ever creates.
 *
 * IT IS STILL A GUESS ABOUT ANOTHER PROCESS. A host started with a different
 * DATA_DIR or SWARMCLAW_HOME writes somewhere else, and nothing here can see
 * that host's environment. So the row below prints the path it looked at, and
 * the page's status bar -- which runs inside the host and computes the same
 * path from the host's own environment -- is the answer that counts.
 */
const portFile = explicitHome || desktop
  ? path.join(path.resolve(explicitHome || desktop), 'run', 'port.json')
  : path.join(dataDir, 'run', 'port.json')

/**
 * The closing report: what an install produces, what is still missing, and what
 * the operator has to do next.
 *
 * WHY IT IS HERE AND NOT ONLY ON THE PAGE. Copying the files is not an install.
 * Until the host has a Google OAuth client there is no button that could
 * connect the mailbox; until the mailbox is connected every read, every draft
 * and every release refuses; until one live recipient exists a draft to a
 * handle has no handle to name; until the host has written a port file the MCP
 * entry an agent would come through cannot find this host. Every one of those
 * is silent from here -- this script exits 0 either way -- so it prints the
 * difference between an install that did nothing and an install that worked.
 *
 * WHAT IT CAN AND CANNOT MEASURE. There is no running host at this point, so
 * `health` cannot be called and nothing that lives in the host's database can
 * be read: whether a Google client is configured, whether the mailbox is
 * connected, and how many recipients the book holds are all `[ ? ]` with where
 * to look, never a pass. Two things are looked at for real, and both are looked
 * at with the module's own code rather than a second copy of its rules: the
 * port file, through `portFajlAllapot` from src/health.mjs, and the four
 * environment variables -- IN THIS PROCESS, which is the misleading half. A
 * host launched by launchd, by Docker or by a desktop app does not inherit this
 * terminal's environment, so a variable set here says nothing about the host
 * and a variable missing here does not mean the host lacks it. That row is
 * therefore `[ ? ]` whatever this process holds, and it says to look at the
 * host.
 *
 * WHAT IS NOT ON THE LIST: RECONCILE. This module declares no managed agent and
 * no managed schedule (design spec 11.10), so there is nothing to reconcile and
 * no button to press. The video and tts modules need one and say so; this one
 * says the opposite out loud, because "did I forget the Reconcile step?" is the
 * question an operator coming from those modules will ask, and silence would
 * read as a missing step rather than as an absent one. The plan's Task 2 is
 * where a future consumer that DOES declare managed resources picks this up.
 */
{
  // The pair the host reads depends on its own deploy mode
  // (`resolveGoogleDeployMode` in src/lib/server/oauth/google.ts): 'desktop'
  // when SWARMCLAW_DEPLOY_MODE says so, 'vps' otherwise. The same rule is in
  // src/health.mjs; here it only decides which pair is named first.
  const mode = process.env.SWARMCLAW_DEPLOY_MODE?.trim() === 'desktop' ? 'desktop' : 'vps'
  const ENV_PAROK = Object.freeze({
    desktop: ['GOOGLE_OAUTH_CLIENT_DESKTOP_ID', 'GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET'],
    vps: ['GOOGLE_OAUTH_CLIENT_WEB_ID', 'GOOGLE_OAUTH_CLIENT_WEB_SECRET'],
  })
  const beallitva = (nev) => typeof process.env[nev] === 'string' && process.env[nev].trim() !== ''
  const parAllapot = (par) => par.map((nev) => `${nev}=${beallitva(nev) ? 'van' : 'nincs'}`).join(', ')
  const ittLatszik = `ebben a folyamatban: ${parAllapot(ENV_PAROK[mode])}; a másik mód párja: ${parAllapot(ENV_PAROK[mode === 'desktop' ? 'vps' : 'desktop'])}`

  const port = portFajlAllapot(portFile)

  // [mit, mit kell tenni / mit látni, mért eredmény vagy null a "nem mérhető innen"-re]
  const lepesek = [
    [
      'a lap két bundle-fájlja a workspace-ben (dist/index.js, dist/style.css)',
      'build nélkül telepítettél: futtasd az extensions/gmail könyvtárban az npm ci && npm run build parancsot, majd ezt a szkriptet újra. E nélkül a modul betölt és a szerződése működik, de a menüben ott álló /x/gmail lap assetjeire a host 404-et ad, és a lap üresen marad -- ami pontosan úgy néz ki, mintha a telepítés nem sikerült volna',
      ['dist/index.js', 'dist/style.css'].every((f) => fs.existsSync(path.join(wsDir, f))),
    ],
    [
      'Google OAuth-kliens a hoston',
      `a hostot kell megnézni, nem ezt a folyamatot: a /x/gmail lap írja ki, ha nincs (google_oauth_client_missing), és a bekötés gomb kikapcsolva marad. Mód: ${mode}; ${ittLatszik}. Ha a hostot launchd, Docker vagy a desktop app indítja, az nem ebből a környezetből örököl`,
      null,
    ],
    [
      'a gmail purpose a host SCOPES mapjában',
      'host-oldali kód, innen nem látszik. Ha a bekötés indítása {"error":"unknown purpose"}-t ad 400-zal, akkor a host régebbi, mint ez a modul',
      null,
    ],
    [
      'a postafiók bekötve (google-oauth:gmail)',
      'a host adatbázisában él, fájlban nem. A /x/gmail lapon látszik; bekötés nélkül minden Gmailt igénylő hívás gmail_hitelesites_hianyzik-kal utasít el',
      null,
    ],
    [
      'legalább egy élő címzett a könyvben',
      'a host adatbázisában él. A /x/gmail Címzettek nézetében vedd fel az elsőt; üres könyv mellett az állapotsáv gmail_cimzettkonyv_ures-t mutat, és a draft minden handle-re gmail_cimzett_ismeretlen-nel utasít el. A válasz-piszkozat viszont megy: annak a címzettje a megválaszolt levél borítékjából jön',
      null,
    ],
    [
      `a run/port.json létezik és élő pidet tart (${portFile})`,
      port.letezik
        ? 'a fájl megvan, de nem a várt alakú, vagy a benne álló folyamat nem ebből az indításból való. Indítsd el a hostot, és nézd meg, hogy ugyanezzel a DATA_DIR/SWARMCLAW_HOME környezettel fut-e'
        : 'a host írja induláskor. Indítsd el a hostot; e nélkül az MCP-bejegyzés nem találná meg ezt a hostot (a lap és a szerződés ettől függetlenül működik)',
      port.elo,
    ],
    [
      'MCP-bejegyzés a Settings → MCP Servers alatt',
      'innen nem ellenőrizhető: a host beállítása, és ez a szkript nem olvassa a host beállításait. A pontos, másolható JSON-t a /x/gmail lap alja adja',
      null,
    ],
  ]

  console.log('\nA telepítés akkor fut, ha az alábbi mind igaz:')
  for (const [mit, hogyan, ok] of lepesek) {
    const jel = ok === null ? '[ ? ]' : ok ? '[ ok]' : '[ ! ]'
    console.log(`${jel} ${mit}${ok === false ? ` -- HIÁNYZIK: ${hogyan}` : ok === null ? ` -- ${hogyan}` : ''}`)
  }

  console.log(`
Reconcile: ennek a modulnak NEM kell. Nincs managed ügynöke és nincs managed
ütemezése, tehát nincs mit összehangolni, és nincs kihagyott lépés sem. (A
videó- és a tts-modulnál van; ha onnan jössz, ez a különbség, nem hiány. Egy
jövőbeli fogyasztó, amelyik managed erőforrást deklarál, a terv Task 2-jéhez
nyúljon.)

A lap: /x/gmail. Ha a menüben nem jelenik meg közvetlenül a telepítés után,
töltsd újra a böngészőlapot. A szerver oldalon már minden kész -- az extension
betöltött, az assetek kiszolgálva, a /x/gmail 200-zal válaszol --, de a már
megnyitott kliens a lapok listáját a betöltéskor kapta meg, és magától nem
kérdezi újra.

Hiba, betöltés közben és futás közben:
  - A betöltésnek 30 másodperce van. Az entry modulban ezért nincs top-level
    await, fájlolvasás és hálózati hívás: egy soha be nem teljesülő top-level
    await nem lassú betöltés, hanem a host indulását tartja fel a teljes
    határidőig. Ezt a test/import-time.test.mjs méri, sima node-dal.
  - Egy hibás extension nem viszi magával a hostot: a betöltés hibája a kártyára
    kerül (load.import_timeout, load.contracts, load.setup és a többi), a többi
    extension fut. A kártyán megjelenő hiba az egyetlen jelzés -- egy betöltési
    hiba után a modul "engedélyezett" marad a listában.
  - Három egymást követő metódus-hiba után a host magától letiltja a modult.
    Ennek itt nincs olyan következménye, mint a videómodulnál: nincs managed
    ütemezés, ami tovább tüzelne, tehát letiltás után nem megy ki fizetős
    modellhívás ebből a modulból. Ami történik: a mailbox szerződés fogyasztói
    (ma: az AI Signal) a következő hívásukon provider_disabled-del, névvel
    buknak, és a frontierük nem mozdul.
  - A hitelesítés hibái NEM betöltési hibák: bekötetlen postafiók mellett a
    modul betölt, a lap él, a könyv szerkeszthető, és minden Gmailt igénylő
    metódus névvel utasít el.

Letiltás (Extensions → a Gmail kártya kapcsolója):
  - a modul nem lesz betöltve, a lapja kikerül a menüből (a /x/gmail URL a host
    shelljét adja, de nem regisztrál rá lap), az rpc-je 404-et ad;
  - az ext_gmail_ táblák, a beállítások és a hitelesítő A HELYÜKÖN MARADNAK;
  - az MCP-shim egy hívásra gmail_extension_hianyzik-kal válaszol, nem csendben;
  - az újbóli engedélyezés után minden ott folytatódik, ahol abbamaradt.

Eltávolítás (Extensions → törlés). Előtte, a lap „Uninstall előtt" szakasza
szerint, és abban a sorrendben:
  1. Adj ki vagy vess el minden nyitott piszkozatot. Az eltávolítás eldobja az
     ext_gmail_ táblákat, és utána a Gmailben álló piszkozatokhoz nem tartozik
     semmilyen sor, amihez a kiadás vagy a törlés kötődhetne: a piszkozatok a
     postafiókban maradnak, listázatlanul.
  2. Másold ki a címzettkönyvet és a bizonytalan sorokat a lap alján lévő két
     szövegdobozból. Mindkettő a táblákkal együtt vész el.
  Amit az eltávolítás elvégez: a fájl és a workspace, az ext_gmail_ táblák és a
  migrációs sorok, a beállítások.
  Ami TÚLÉLI: a google-oauth:gmail hitelesítő (a Credentials képernyőn törölhető
  kézzel), a Gmailben álló piszkozatok, és a Settings → MCP Servers bejegyzés.
  A HITELESÍTŐ TÖRLÉSE NEM VISSZAVONÁS: a refresh token a Google-nál érvényes
  marad, amíg a fiók tulajdonosa a saját Google-fiókbeállításaiban vissza nem
  vonja a hozzáférést.
  Ami PÉNZBE KERÜLNE, ha túlélné: egyetlen ilyen sincs. Ez a modul nem indít
  ütemezett futást és nem hív modellt; az egyetlen művelete, ami küld, egy
  emberi kattintás a lapon, és a lap az eltávolítással eltűnik.
  Az ÚJRATELEPÍTÉS üres táblákkal indul: a címzettkönyv elvész. Ez szándékos --
  a könyv az egyetlen kapu a kimenő oldalon, és egy kapu, ami egy
  újratelepítést túlél anélkül, hogy bárki ránézne, nem kapu.
`)
}
