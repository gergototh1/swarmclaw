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
// ships no skills today and declares no agents; the block stays so that the
// day a skill is added, its rename and removal are already handled.
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
const skillsRoot = path.join(root, 'skills')
const shippedManifest = path.join(wsDir, 'shipped-skills.json')
const shipped = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot) : []
let previouslyShipped = []
try {
  const parsed = JSON.parse(fs.readFileSync(shippedManifest, 'utf8'))
  previouslyShipped = Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : []
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
