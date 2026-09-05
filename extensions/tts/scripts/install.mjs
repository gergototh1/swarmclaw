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
 *   <DATA_DIR>/extensions/tts.mjs                 -- shim the loader requires
 *   <DATA_DIR>/extensions/.workspaces/tts_mjs/    -- the actual module tree
 *
 * The workspace key is the extension filename with every character outside
 * [a-zA-Z0-9_-] replaced by '_', which is what extensionWorkspaceKey computes
 * for 'tts.mjs'. Get it wrong and the host builds a different workspace
 * path, finds no index.js there, and loads the shim's target from nowhere.
 *
 * index.mjs lands in the workspace as index.js because that is the entry name
 * the host looks for. It stays ESM: the copied package.json carries
 * "type": "module", and its relative './src/...' imports resolve inside the
 * workspace.
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
// The earlier version fell back to the macOS desktop home unconditionally, so
// in a Linux container it installed under a path the host never reads.
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
const wsDir = path.join(extDir, '.workspaces', 'tts_mjs')

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
fs.writeFileSync(path.join(extDir, 'tts.mjs'), "export { default } from './.workspaces/tts_mjs/index.js'\n")

// Skills a managed agent would name in its declaration. They are copied into
// <home>/skills, which is the workspace layer discoverSkills() scans -- an
// extension's own directory is not a layer it looks in, so a skill left in the
// repo tree is a skill the agent that names it never sees. This extension
// ships no skills today and declares no agents, so the copy loop below does
// nothing on this checkout. The removal is not idle in the same way: it reads
// a manifest that is a file on disk and deletes what the manifest names,
// which is why every name is checked before it is joined onto a path.
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

console.log(`tts installed: ${extDir}/tts.mjs, workspace ${wsDir}`)
// The host does not register MCP servers on an extension's behalf, so the
// entry is the operator's to add. The exact JSON comes from the extension's
// own page once it is shipped; a checkout with no mcp/ has no server to
// register yet, and says so rather than pointing at a page that cannot show it.
if (copied.includes('mcp')) {
  console.log('A MCP-bejegyzést kézzel kell felvenni: Settings → MCP Servers; a pontos JSON a /x/tts lapon.')
} else {
  console.log('Ez a kiadás még nem szállít MCP-szervert (nincs mcp/ könyvtár); MCP-bejegyzést nem kell felvenni.')
}

/**
 * The closing report: what an install produces, what is still missing, and
 * what the operator has to do next.
 *
 * Copying the files is not an install. Without the Soniox key every call is
 * refused with `tts_kulcs_hianyzik`, and without the MCP entry the agents have
 * no route to this extension at all -- both silent from here, since this
 * script exits 0 either way. An install that did nothing and an install that
 * worked must not look the same.
 *
 * There is no running host at this point, so `health` cannot be called. The
 * key and the endpoint live in the host's own settings database
 * (`loadSettings()` in src/lib/server/storage.ts, under
 * `extensionSettings['tts.mjs']`), not in a file this script can read, and the
 * MCP registration lives in the host's MCP servers list. Both are printed as
 * `[ ? ]` with where to look, never as a pass. The key's value is not read
 * here and is not printed anywhere.
 */
{
  const tool = (name, args) => {
    try {
      return spawnSync(name, args, { stdio: 'ignore' }).status === 0
    } catch {
      return false
    }
  }

  const lepesek = [
    ['apiKey és endpoint beállítva', 'Extensions → a Narráció (TTS) kártyán; a /x/tts lap mutatja, be van-e állítva (az értéket sehol nem mutatja)', null],
    ['hangGyoker beállítva', 'Extensions → a Narráció (TTS) kártyán, abszolút út: a modul CSAK ez alá ír. Enélkül minden hívás tts_gyoker_hianyzik-kal bukik. A videómodulhoz a Remotion-projekt public/narracio/swarmclaw könyvtára -- nem a public/narracio, mert abban az operátor saját, újra el nem készíthető narrációi vannak', null],
    ['ffprobe a PATH-on', 'az ffmpeg csomag része (brew install ffmpeg); enélkül a szintézis tts_hossz_meres_sikertelen-nel bukik -- a hang elkészül, a lemezen marad és cache-elve lesz, de hossz nélkül', tool('ffprobe', ['-version'])],
    ['MCP-bejegyzés felvéve', 'Settings → MCP Servers; a pontos JSON a /x/tts lapon, a SWARMCLAW_ACCESS_KEY értékét kézzel írd be a host .env.local fájljából', null],
  ]

  console.log('\nA telepítés akkor fut, ha az alábbi mind igaz:')
  for (const [mit, hogyan, ok] of lepesek) {
    const jel = ok === null ? '[ ? ]' : ok ? '[ ok]' : '[ ! ]'
    console.log(`${jel} ${mit}${ok === false ? ` -- HIÁNYZIK: ${hogyan}` : ok === null ? ` -- ${hogyan}` : ''}`)
  }

  console.log(`
A lap: /x/tts. Ha a menüben nem jelenik meg közvetlenül a telepítés után, töltsd
újra a böngészőlapot. A szerver oldalon már minden kész -- az extension betöltött,
az assetek kiszolgálva, a /x/tts 200-zal válaszol --, de a már megnyitott kliens a
lapok listáját a betöltéskor kapta meg, és magától nem kérdezi újra.

Ez az extension nem deklarál se ügynököt, se ütemezést, se toolt: Reconcile-ra
nincs szüksége, és magától egyetlen hívást sem indít. Amit fizet, azt mindig
valaki más kérte: egy másik extension a narration szerződésen át, vagy egy ügynök
az MCP-shimen át.

Hiba, betöltés közben és futás közben:
  - A betöltésnek 30 másodperce van. Az entry modulban ezért nincs top-level await,
    fájlolvasás és hálózati hívás: egy soha be nem teljesülő top-level await nem
    lassú betöltés, hanem a host indulását tartja fel a teljes határidőig.
  - Egy hibás extension nem viszi magával a hostot: a betöltés hibája a kártyára
    kerül, a többi extension fut.
  - Kulcs nélkül, gyökér nélkül, keret felett vagy szolgáltatói hiba esetén a hívás
    névvel bukik (tts_kulcs_hianyzik, tts_gyoker_hianyzik, tts_keret_kimerult és a
    többi), és a napi keret a hívás ELŐTT foglal, tehát egy hibás válasz sem költ a
    kereten túl.
  - A célfájl a hívóé, de nem bármi: abszolút .mp3 a hangGyoker alatt (realpath-tal
    ellenőrizve, symlinken sem lehet kilépni), és meglévő fájlt csak akkor ír felül,
    ha egy ext_tts_kerelmek sor megnevezi (tts_celfajl_ervenytelen,
    tts_celfajl_foglalt).

Letiltás (Extensions → a kártya kapcsolója):
  - a modul nem lesz betöltve, a lapja eltűnik;
  - a narration szerződés fogyasztói a következő hívásukra provider_disabled-et
    kapnak, tehát a videómodul videoNarrate-je névvel utasít el, nem hallgat el;
  - az MCP-shim tts_extension_hianyzik-kal válaszol, nem csendben;
  - ez az extension nem deklarál ütemezést, tehát letiltva sem indít semmit.

Eltávolítás (Extensions → törlés):
  - Előtte: a Settings → MCP Servers alól töröld a tts bejegyzést. A host nem
    veszi ki magától, és amíg ott van, minden ügynöki hívás a shimen át bukik.
  - Az eltávolítás eldobja az ext_tts_ táblákat: a cache és a napi számláló is
    velük megy. A cache-fájlok a hívók könyvtáraiban MARADNAK -- a videómoduléi a
    Remotion-projekt public/narracio/swarmclaw/ alatt --, ez az extension nem
    törli más repó fájljait.
  - Újratelepítés után a táblák üresek: a lemezen álló mp3-ak nem számítanak
    találatnak, amíg az importCache vissza nem tölti őket, tehát a következő
    kérés újra fizet. Ezért van importCache.
  - Ami PÉNZBE KERÜLNE, ha túlélné: semmi. Ez az extension magától nem hív;
    eltávolítva a két útja (a szerződés és a shim) egyszerre szűnik meg.
`)
}
