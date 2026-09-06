import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Installs this extension into a SwarmClaw data directory from the repo.
 *
 * The host normally writes an extension into a managed workspace itself
 * (saveExtensionSource), generating the top-level shim as it goes. That path
 * starts from source pasted into the UI; this one starts from the repo, so the
 * same layout is produced by hand:
 *
 *   <DATA_DIR>/extensions/video.mjs                    -- shim the loader requires
 *   <DATA_DIR>/extensions/.workspaces/video_mjs/       -- the actual module tree
 *
 * The workspace key is the extension filename with every character outside
 * [a-zA-Z0-9_-] replaced by '_', which is what extensionWorkspaceKey computes
 * for 'video.mjs'. Get it wrong and the host builds a different workspace
 * path, finds no index.js there, and loads the shim's target from nowhere.
 *
 * index.mjs lands in the workspace as index.js because that is the entry name
 * the host looks for. It stays ESM: the copied package.json carries
 * "type": "module", and its relative './src/...' imports resolve inside the
 * workspace.
 *
 * Nothing here touches the Remotion project: the extension reads it at run
 * time from the `remotionDir` setting, and this script has no business knowing
 * where it is.
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

// Follows the host's own resolution order. Data (src/lib/server/data-dir.ts):
// an explicit DATA_DIR wins, then SWARMCLAW_HOME/data, then the desktop app's
// home when this machine has one, and otherwise <cwd>/data -- which is what the
// host itself uses when started without either variable, in the container
// (WORKDIR /app, so /app/data, the compose volume) as much as from a checkout.
const explicitHome = process.env.SWARMCLAW_HOME || null
const desktop = explicitHome ? null : desktopHome()
const dataDir = process.env.DATA_DIR
  || (explicitHome ? path.join(explicitHome, 'data') : null)
  || (desktop ? path.join(desktop, 'data') : null)
  || path.join(process.cwd(), 'data')
// Skills go to the layer discoverSkills() scans (skill-discovery.ts,
// resolveWorkspaceSkillsDir): SWARMCLAW_HOME/skills, else ~/.swarmclaw/skills.
// The desktop app sets SWARMCLAW_HOME to its home, so that home's skills
// directory is the same layer when installing against the desktop app by hand.
const home = explicitHome || desktop || path.join(process.env.HOME || '', '.swarmclaw')
const extDir = path.join(dataDir, 'extensions')
const wsDir = path.join(extDir, '.workspaces', 'video_mjs')

fs.mkdirSync(wsDir, { recursive: true })
// `mcp/` is the MCP server's own tree, which the host does not load: the
// operator points an MCP Servers entry at the copy in the workspace, and the
// shim there runs from it. It has to live here rather than in the repo
// checkout so that it survives a rebuild of the tree it was installed from.
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
fs.writeFileSync(path.join(extDir, 'video.mjs'), "export { default } from './.workspaces/video_mjs/index.js'\n")

// The skills the managed agents will name in their declarations. They are
// copied into <home>/skills, which is the workspace layer discoverSkills()
// scans -- an extension's own directory is not a layer it looks in, so a skill
// left in the repo tree is a skill the agent that names it never sees. A pin
// matches on the SKILL.md's frontmatter `name`, not on the directory, so the
// two have to agree. This block is live, not a no-op waiting on a directory:
// extensions/video/skills/ exists and holds the two skills the managed agents
// name.
//
// A copy alone is not an upgrade. cpSync never removes anything, so after a
// skill is renamed the old directory stays under <home>/skills, discovery
// still lists it, and any pin that still names it still matches it. The host
// drops the old pin from the managed agent on its next reconcile (the marker
// records what each reconcile declared); what it cannot do is remove the file,
// which is this script's business. So the directory names shipped by each
// install are written to a manifest beside the workspace, and the next install
// removes from <home>/skills every name the previous install shipped that the
// repo no longer has. Only names from the manifest are touched: a skill the
// operator put there by hand is not this script's to remove, and the very
// first install after this manifest existed has nothing to compare against,
// so a rename that happened before that leaves its directory in place.

/**
 * A manifest entry this script will put after `<home>/skills/` and delete
 * recursively, or null.
 *
 * THE MANIFEST IS A FILE ON DISK AND THIS IS A DELETE. It survives across
 * installs inside the data directory, it is JSON, and nothing signs it. An
 * entry of `""` makes `path.join(home, 'skills', '')` the skills directory
 * itself; `".."` makes it `<home>`, which with SWARMCLAW_HOME set holds the
 * data directory, the database and every extension. Both would then be
 * removed with `recursive: true, force: true` and no message.
 *
 * So a name has to be a plain directory name: non-empty, no separator, not
 * `.` and not `..`. The host applies exactly this rule where it removes the
 * same directories on uninstall (`removeShippedSkillDirs` in
 * src/lib/server/extensions/extension-managed-teardown.ts, and the non-empty
 * part in `readShippedSkillNames` beside it); the two are one rule, and this
 * copy is here because an install script may not import the host's `src/`.
 * Anything refused is reported and left alone: a name this script cannot
 * place is not a name it may delete.
 */
function plainDirectoryName(name) {
  if (typeof name !== 'string') return null
  if (name === '' || name === '.' || name === '..') return null
  if (name !== path.basename(name)) return null
  return name
}

const skillsRoot = path.join(root, 'skills')
const shippedManifest = path.join(wsDir, 'shipped-skills.json')
const shipped = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot) : []
let previouslyShipped = []
try {
  const parsed = JSON.parse(fs.readFileSync(shippedManifest, 'utf8'))
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    const name = plainDirectoryName(entry)
    if (name === null) {
      console.error(`figyelmen kívül hagyott manifest-bejegyzés (nem egyszerű könyvtárnév): ${JSON.stringify(entry)}`)
      continue
    }
    previouslyShipped.push(name)
  }
} catch {
  // No manifest, or not one this script wrote: nothing was shipped that this run knows about.
}
for (const stale of previouslyShipped.filter((name) => !shipped.includes(name))) {
  fs.rmSync(path.join(home, 'skills', stale), { recursive: true, force: true })
}
for (const skill of shipped) {
  fs.cpSync(path.join(skillsRoot, skill), path.join(home, 'skills', skill), { recursive: true })
}
fs.writeFileSync(shippedManifest, `${JSON.stringify(shipped, null, 2)}\n`)

console.log(`video installed: ${extDir}/video.mjs, workspace ${wsDir}`)

/**
 * The closing report: what an install produces, what is still missing, and
 * what the operator has to do next.
 *
 * WHY IT IS HERE AND NOT ONLY ON THE PAGE. Copying the files is not an
 * install. Until the operator presses Reconcile there is no agent and no
 * schedule; until the two contracts have their providers the narration and
 * the signal source refuse by name; until three binaries are findable the
 * render refuses. Every one of those is silent from here: this script exits 0
 * either way. An install that did nothing and an install that worked must not
 * look the same, so this prints the difference.
 *
 * WHAT IT CAN AND CANNOT MEASURE. There is no running host at this point, so
 * `health` cannot be called: everything the host answers -- whether tts is
 * installed and keyed, whether aisignal is enabled, whether Reconcile has been
 * pressed -- is printed as `[ ? ]` with where to look, never as a pass. The
 * `remotionDir` setting is one of those: the host keeps extension settings in
 * its own database (`loadSettings()` in src/lib/server/storage.ts, under
 * `extensionSettings['video.mjs']`), not in a file this script can read, so
 * the project's four required files are checked only when REMOTION_DIR is
 * given on this command line's environment, and reported as unchecked when it
 * is not. What is measured here is measured for real: the three binaries are
 * run.
 *
 * WHAT A MEASURED BINARY PROVES. This script runs in a terminal, with the
 * operator's login PATH. The host resolves the same three names through a
 * login shell and the well-known install directories (`ctx.resolveBinary`), so
 * a tool found here is very nearly always a tool the host finds too -- but the
 * two are separate lookups on possibly different accounts, and the page's
 * `health` is the one that speaks for the running host.
 */
{
  const remotionDir = typeof process.env.REMOTION_DIR === 'string' ? process.env.REMOTION_DIR.trim() : ''
  const KOTELEZO = ['package.json', 'src/index.ts', 'src/FosVideo.tsx', 'src/kit/katalogus.generated.json']
  const projectFilesPresent = () => {
    try {
      return KOTELEZO.every((f) => fs.existsSync(path.join(remotionDir, f)))
    } catch {
      return false
    }
  }
  // Runs the tool with the argument that makes it print a version and exit 0.
  // The three names are literals in this file; nothing a stranger wrote goes
  // near this call, and `shell: false` is spawnSync's default.
  const tool = (name, args) => {
    try {
      return spawnSync(name, args, { stdio: 'ignore' }).status === 0
    } catch {
      return false
    }
  }

  const lepesek = [
    ['tts extension telepítve, engedélyezve, apiKey beállítva', 'a /x/tts lapon látszik; nélküle a videoNarrate tts_szerzodes_hianyzik-kal utasít el', null],
    ['a tts hangGyoker beállítása lefedi a narráció útját', 'a /x/tts lapon látszik; a videoNarrate a Remotion-projekt public/narracio/swarmclaw/... alá kér fájlt, és a tts csak a saját gyökere alá ír. A gyökér legyen maga a public/narracio/swarmclaw -- nem a public/narracio, mert abban az operátor saját, újra el nem készíthető narrációi vannak. Rossz gyökérrel a videoNarrate tts_visszautasitva / tts_celfajl_ervenytelen kóddal áll meg', null],
    ['aisignal telepítve és engedélyezve', 'nélküle a videoOpen csak kezi forrással megy; ez nem állít meg mást', null],
    [
      'remotionDir beállítva és benne a négy kötelező fájl',
      remotionDir === ''
        ? 'itt nem mérhető: a beállítás a host adatbázisában él, nem fájlban. Add meg az Extensions kártyán, és ha itt is ellenőriznéd, futtasd újra REMOTION_DIR=/út/a/_remotion mellett'
        : `${remotionDir} (${KOTELEZO.join(', ')})`,
      remotionDir === '' ? null : projectFilesPresent(),
    ],
    ['ffmpeg a PATH-on', 'brew install ffmpeg', tool('ffmpeg', ['-version'])],
    ['ffprobe a PATH-on', 'az ffmpeg csomag része', tool('ffprobe', ['-version'])],
    ['npx a PATH-on', 'a Node telepítéssel jön', tool('npx', ['--version'])],
    [
      'Chrome Headless Shell a projektben',
      remotionDir === ''
        ? 'itt nem mérhető remotionDir nélkül; az első render lefuttatja a npx remotion browser ensure-t'
        : `${path.join(remotionDir, 'node_modules', '.remotion')} (npx remotion browser ensure a projektben, vagy az első render)`,
      remotionDir === '' ? null : fs.existsSync(path.join(remotionDir, 'node_modules', '.remotion')),
    ],
    ['Reconcile: Extensions → a Videó kártyán a Reconcile gomb, vagy swarmclaw extensions reconcile --extension-id video.mjs', 'nélküle nincs ügynök és nincs ütemezés; a /x/video lap állapotsávja mondja, hogy „nincs ütemezés — Reconcile kell”', null],
  ]

  console.log('\nA telepítés akkor fut, ha az alábbi mind igaz:')
  for (const [mit, hogyan, ok] of lepesek) {
    const jel = ok === null ? '[ ? ]' : ok ? '[ ok]' : '[ ! ]'
    console.log(`${jel} ${mit}${ok === false ? ` -- HIÁNYZIK: ${hogyan}` : ok === null ? ` -- ${hogyan}` : ''}`)
  }

  console.log(`
A lap: /x/video. Ha a menüben nem jelenik meg közvetlenül a telepítés után, töltsd
újra a böngészőlapot. A szerver oldalon már minden kész -- az extension betöltött,
az assetek kiszolgálva, a /x/video 200-zal válaszol --, de a már megnyitott kliens
a lapok listáját a betöltéskor kapta meg, és magától nem kérdezi újra.

Hiba, betöltés közben és futás közben:
  - A betöltésnek 30 másodperce van. Az entry modulban ezért nincs top-level await,
    fájlolvasás és hálózati hívás: egy soha be nem teljesülő top-level await nem
    lassú betöltés, hanem a host indulását tartja fel a teljes határidőig.
  - Egy hibás extension nem viszi magával a hostot: a betöltés hibája a kártyára
    kerül (load.import_timeout, load.setup és a többi), a többi extension fut.
  - Három egymást követő hook- vagy tool-hiba után a host magától letiltja a
    modult. Ez az ütemezéseket nem törli, csak kihagyatja (lásd lent).
  - Render-hibák a render sorára kerülnek kóddal és a log útjával; a lap mutatja.

Letiltás (Extensions → a Videó kártya kapcsolója, vagy az automatikus letiltás):
  - a config-bejegyzést írja és újratölt; a modul nem lesz betöltve, a tooljai
    eltűnnek, a lapja eltűnik;
  - a managed ügynökök és ütemezések a helyükön MARADNAK, a host nem törli őket;
  - de a scheduler egy letiltott vagy be nem töltött extension managed
    ütemezését kihagyja és lépteti (skipped, extension_disabled /
    extension_not_loaded), tehát nem indul feladat és nem megy ki modellhívás.
    Ez a különbség pénzben mérhető: enélkül egy letiltott modul három ütemezése
    naponta tovább fizetett fordulókat indítana olyan ügynökkel, amelynek a
    tooljai már nincsenek meg.
  - Az újbóli engedélyezés után a következő tick tüzel; nincs mit visszaállítani.

Eltávolítás (Extensions → törlés). Előtte, a lap „Uninstall előtt” szakasza szerint:
  1. Állítsd le a futó rendert (Leállít / cancelRender). A hostnak nincs
     uninstall-hookja, és a pid-et tartó táblát az eltávolítás eldobja: a
     folyamat különben egy olyan könyvtárba fejezi be a fájlt, amit már senki
     nem olvas.
  2. Tisztítás: a sorhoz kötött fájlok törlése a Remotion-projekt
     out/swarmclaw/ és public/narracio/swarmclaw/ névtere alól. Utána már nem
     lesz sor, amihez a törlés kötődhetne.
  Amit az eltávolítás elvégez: a fájl és a workspace, a managed ütemezések
  törlése, a managed ügynökök kukába tétele, a manifest szerinti skill-könyvtárak,
  az ext_video_ táblák és a migrációs sorok, a beállítások.
  Ami TÚLÉLI: a Remotion-projekt alatti mp3-ak és mp4-ek (más repó, az operátoré),
  a Settings → MCP Servers alatti tts-bejegyzés, és a <home>/skills alatt kézzel
  odatett skillek.
  Ami PÉNZBE KERÜLNE, ha túlélné: egyetlen ilyen sincs -- az eltávolítás a három
  ütemezést tényleg törli. A letiltás nem törli őket, ott a scheduler kihagyása a
  védelem.
`)
}

// The host does not register MCP servers on an extension's behalf. Two of the
// fields below are machine-specific and a wrong one fails silently, so they are
// printed rather than left to be worked out: the shim must run from the
// WORKSPACE copy, and SWARMCLAW_PORT_FILE is how it finds a host whose port
// changes every launch.
//
// ONE ENTRY, NOT ONE PER AGENT, and no agent id pinned in the env. The host
// stamps the caller into the shim's env on every turn
// (addAssignedMcpServers, src/lib/providers/claude-cli.ts), which is what keeps
// `videoVerdict`'s reviewer gate meaningful through MCP: the protocol carries
// no caller identity, and an id written here would be an agent naming itself --
// exactly what spec 3.3 refuses. Assign this one entry to BOTH the producer and
// the reviewer; they stay distinguishable because the host says who they are.
if (copied.includes('mcp')) {
  const entry = {
    name: 'Videó MCP',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(wsDir, 'mcp', 'server.mjs')],
    env: { SWARMCLAW_PORT_FILE: path.join(home, 'run', 'port.json'), SWARMCLAW_ACCESS_KEY: '<a host .env.local ACCESS_KEY értéke>' },
  }
  console.log('\nMCP-bejegyzés (Settings → MCP Servers), majd rendeld hozzá a Gyártóhoz ÉS a Lektorhoz:')
  console.log(JSON.stringify(entry, null, 2))
}
