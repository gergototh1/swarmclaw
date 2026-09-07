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
 *   <DATA_DIR>/extensions/crm.mjs                 -- shim the loader requires
 *   <DATA_DIR>/extensions/.workspaces/crm_mjs/    -- the actual module tree
 *
 * The workspace key is the extension filename with every character outside
 * [a-zA-Z0-9_-] replaced by '_', which is what extensionWorkspaceKey computes
 * for 'crm.mjs'. Get it wrong and the host builds a different workspace path,
 * finds no index.js there, and loads the shim's target from nowhere.
 *
 * index.mjs lands in the workspace as index.js because that is the entry name
 * the host looks for. It stays ESM: the copied package.json carries
 * "type": "module", and its relative './src/...' imports resolve inside the
 * workspace.
 *
 * THIS EXTENSION SHIPS NO SKILLS, so there is no skills/ directory, no
 * shipped-skills.json manifest beside the workspace, and no removal pass over
 * <home>/skills. It DOES declare a managed project (managedResources.projects
 * in index.mjs) -- the host's own reconcile creates and removes that project
 * on install/uninstall (Task 1-2), so there is nothing for this script to do
 * about it either.
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
// Where the host writes run/port.json, and so where the MCP entry printed below
// points SWARMCLAW_PORT_FILE. This mirrors the host's own `resolveRunDir()`
// (src/lib/server/data-dir.ts), which has exactly two branches:
// `SWARMCLAW_HOME/run` when a home is set, otherwise `DATA_DIR/run`. There is
// no `~/.swarmclaw` branch -- that path exists in `resolveBrowserProfilesDir`,
// not here -- and an earlier version of this script pointed at one, which meant
// that on every install that is neither the desktop app nor a SWARMCLAW_HOME
// install (a checkout, the container) the printed SWARMCLAW_PORT_FILE named a
// file the host never writes. `mcp/server.mjs` has no fallback for a missing
// file, so the shim would refuse every call with `port_fajl_beallitatlan` /
// `port_fajl_hianyzik`, and the Ügyfélkezelő would run its 08:10 routine
// seeing nothing and writing nothing -- silently.
//
// The desktop branch stands in for the host's `SWARMCLAW_HOME`: the desktop app
// sets that variable itself before spawning the server (electron/main.ts), so a
// host started that way resolves its run dir under the desktop home even though
// this script sees no SWARMCLAW_HOME in its own env. `dataDir` above already
// resolves the same three ways, so the third branch just reuses it.
const runDir = explicitHome
  ? path.join(explicitHome, 'run')
  : (desktop ? path.join(desktop, 'run') : path.join(dataDir, 'run'))
const extDir = path.join(dataDir, 'extensions')
const wsDir = path.join(extDir, '.workspaces', 'crm_mjs')

fs.mkdirSync(wsDir, { recursive: true })
// `mcp/` is the MCP server's own tree, which the host does not load: the
// operator points an MCP Servers entry at the copy in the workspace, and the
// shim there runs from it. It is copied like source because it is source, and
// it has to be here rather than in the repo checkout so that it survives a
// rebuild of the tree the operator installed from.
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
fs.writeFileSync(path.join(extDir, 'crm.mjs'), "export { default } from './.workspaces/crm_mjs/index.js'\n")

console.log(`crm installed: ${extDir}/crm.mjs, workspace ${wsDir}`)

/**
 * The one thing worth checking before calling this done: without a build,
 * the module still loads and its contract still works, but the /x/crm page
 * listed in the menu gets a 404 on both of its assets and stays empty -- which
 * looks exactly like a failed install from the host's side.
 */
const distIndex = path.join(root, 'dist/index.js')
const distCss = path.join(root, 'dist/style.css')
if (!fs.existsSync(distIndex) || !fs.existsSync(distCss)) {
  console.log('FIGYELEM: nincs dist/ build. Futtasd előbb: npm run build')
  console.log('Build nélkül a lap sosem regisztrál, és ez a hosztról nézve egy sikertelen telepítéssel azonos.')
} else {
  console.log('A lap két bundle-fájlja (dist/index.js, dist/style.css) a workspace-ben megvan.')
}

console.log(`
A lap: /x/crm. Ha a menüben nem jelenik meg közvetlenül a telepítés után,
töltsd újra a böngészőlapot -- a szerver oldalon már minden kész, de a már
megnyitott kliens a lapok listáját a betöltéskor kapta meg.

Ennek a modulnak nincs setup-lépése ezen a telepítőn túl: nincs hitelesítés,
nincs beállítandó mező.

FONTOS: ez a szkript csak fájlokat másol a data-könyvtárba, semmi mást. A
managedResources alatt deklarált CRM projektet, az Ügyfélkezelő ügynököt és a
napi rutinját a host reconcile-ja hozza létre -- de azt csak a host saját
install/enable/upgrade API route-jai indítják el
(reconcileManagedResourcesForLifecycleChange), amiken ez a szkript nem megy
keresztül. Amíg nem történik ilyen átmenet, se a CRM projekt, se az
Ügyfélkezelő ügynök, se a napi rutinja NEM létezik. Kapcsold ki-be az
extension-t az Extensions lapon (vagy nyomd meg a kártyáján a Reconcile
gombot, esetleg: swarmclaw extensions reconcile --extension-id crm.mjs), és
csak utána jönnek létre.
`)

// The host does not register MCP servers on an extension's behalf, so the
// entry is the operator's to add. The JSON is printed here rather than left to
// be worked out, because two of its four fields are machine-specific and a
// wrong one fails silently: the shim must run from the WORKSPACE copy (a path
// under the repo checkout stops working the moment the tree is rebuilt), and
// SWARMCLAW_PORT_FILE is how it finds a host whose port changes every launch.
//
// SWARMCLAW_AGENT_ID and friends are deliberately absent: the host stamps those
// into the env per turn, and a value pinned here would be an agent naming
// itself. See addAssignedMcpServers in src/lib/providers/claude-cli.ts.
if (copied.includes('mcp')) {
  const entry = {
    name: 'CRM MCP',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(wsDir, 'mcp', 'server.mjs')],
    env: { SWARMCLAW_PORT_FILE: path.join(runDir, 'port.json'), SWARMCLAW_ACCESS_KEY: '<a host .env.local ACCESS_KEY értéke>' },
  }
  console.log('\nMCP-bejegyzés (Settings → MCP Servers), majd rendeld hozzá az ügynökökhöz:')
  console.log(JSON.stringify(entry, null, 2))
  console.log(`
KÖTELEZŐ LÉPÉS, NEM RÁÉRŐS: az Ügyfélkezelő ügynök (crm-ugyfelkezelo)
claude-cli-n fut, tehát az extension "tools" rétegét meg sem kapja -- a CRM
eszközeit KIZÁRÓLAG ezen az MCP-bejegyzésen keresztül éri el. Amíg ezt a
bejegyzést fel nem veszed és hozzá nem rendeled az ügynökhöz, az ügynök a napi
rutinja idején lefut, de semmit nem lát és semmit nem ír -- némán, hibaüzenet
nélkül. Ez nem egy elhagyható finomhangolás, hanem a teljes CRM-3 funkció
előfeltétele.`)
} else {
  console.log('Ez a kiadás nem szállít MCP-szervert (nincs mcp/ könyvtár); MCP-bejegyzést nem kell felvenni.')
}
