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
 *   <DATA_DIR>/extensions/aisignal.mjs                 -- shim the loader requires
 *   <DATA_DIR>/extensions/.workspaces/aisignal_mjs/    -- the actual module tree
 *
 * The workspace key is the extension filename with every character outside
 * [a-zA-Z0-9_-] replaced by '_', which is what extensionWorkspaceKey computes
 * for 'aisignal.mjs'. Get it wrong and the host builds a different workspace
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
const wsDir = path.join(extDir, '.workspaces', 'aisignal_mjs')

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
// research.mjs reads this at load, from the workspace root beside src/. It is
// data rather than code, so the src/ copy above does not carry it and it has to
// be named here; without it an installed extension loads with no topics and the
// research tool refuses every call.
fs.copyFileSync(path.join(root, 'research_topics.json'), path.join(wsDir, 'research_topics.json'))
fs.writeFileSync(path.join(extDir, 'aisignal.mjs'), "export { default } from './.workspaces/aisignal_mjs/index.js'\n")

// The skills the two managed agents name in their declarations. They are
// copied into <home>/skills, which is the workspace layer discoverSkills()
// scans -- an extension's own directory is not a layer it looks in, so a skill
// left in the repo tree is a skill the agent that names it never sees.
// `skills: ['ai-hirlevel-kinyeres']` matches on the SKILL.md's frontmatter
// `name`, not on the directory, so the two have to agree; agents.test.mjs pins
// that they do.
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

console.log(`aisignal installed: ${extDir}/aisignal.mjs, workspace ${wsDir}`)

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
    name: 'AI Signal MCP',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(wsDir, 'mcp', 'server.mjs')],
    // No SWARMCLAW_ACCESS_KEY: the host stamps its own, live, into every
    // turn's MCP config (src/lib/server/runtime/mcp-host-binding.ts). A key
    // pasted in here would be a copy that goes stale silently -- and a stale
    // one empties this server's tool list without reporting anything.
    env: { SWARMCLAW_PORT_FILE: path.join(home, 'run', 'port.json') },
  }
  console.log('\nMCP-bejegyzés (Settings → MCP Servers), majd rendeld hozzá az ügynökökhöz:')
  console.log(JSON.stringify(entry, null, 2))
} else {
  console.log('Ez a kiadás nem szállít MCP-szervert (nincs mcp/ könyvtár); MCP-bejegyzést nem kell felvenni.')
}
