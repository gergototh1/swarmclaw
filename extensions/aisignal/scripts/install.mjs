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
// Matches the host's own resolution order (src/lib/server/data-dir.ts): an
// explicit DATA_DIR wins, then SWARMCLAW_HOME/data, and the fallback is the
// desktop app's home. A dev server started from a repo checkout without either
// variable uses <repo>/data instead, so pass SWARMCLAW_HOME or DATA_DIR when
// installing against one.
const home = process.env.SWARMCLAW_HOME || path.join(process.env.HOME || '', 'Library/Application Support/@swarmclawai/swarmclaw/home')
const dataDir = process.env.DATA_DIR || path.join(home, 'data')
const extDir = path.join(dataDir, 'extensions')
const wsDir = path.join(extDir, '.workspaces', 'aisignal_mjs')

fs.mkdirSync(wsDir, { recursive: true })
for (const d of ['src', 'dist']) {
  const src = path.join(root, d)
  if (!fs.existsSync(src)) continue
  // Replace rather than merge: cpSync leaves a file that was renamed or deleted
  // in the repo sitting in the workspace, where it keeps being imported.
  fs.rmSync(path.join(wsDir, d), { recursive: true, force: true })
  fs.cpSync(src, path.join(wsDir, d), { recursive: true })
}
fs.copyFileSync(path.join(root, 'index.mjs'), path.join(wsDir, 'index.js'))
fs.copyFileSync(path.join(root, 'package.json'), path.join(wsDir, 'package.json'))
// research.mjs reads this at load, from the workspace root beside src/. It is
// data rather than code, so the src/ copy above does not carry it and it has to
// be named here; without it an installed extension loads with no topics and the
// research tool refuses every call.
fs.copyFileSync(path.join(root, 'research_topics.json'), path.join(wsDir, 'research_topics.json'))
fs.writeFileSync(path.join(extDir, 'aisignal.mjs'), "export { default } from './.workspaces/aisignal_mjs/index.js'\n")

// Skills ship alongside the extension once there are any; there are none yet.
const skillsRoot = path.join(root, 'skills')
if (fs.existsSync(skillsRoot)) {
  for (const skill of fs.readdirSync(skillsRoot)) {
    fs.cpSync(path.join(skillsRoot, skill), path.join(home, 'skills', skill), { recursive: true })
  }
}

console.log(`aisignal installed: ${extDir}/aisignal.mjs, workspace ${wsDir}`)
