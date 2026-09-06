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
 * THIS EXTENSION SHIPS NO SKILLS AND NO MCP SERVER, so there is no skills/
 * directory, no shipped-skills.json manifest beside the workspace, no mcp/
 * tree to copy, and no removal pass over <home>/skills. It DOES declare a
 * managed project (managedResources.projects in index.mjs) -- the host's own
 * reconcile creates and removes that project on install/uninstall (Task 1-2),
 * so there is nothing for this script to do about it either.
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
const wsDir = path.join(extDir, '.workspaces', 'crm_mjs')

fs.mkdirSync(wsDir, { recursive: true })
const copied = []
for (const d of ['src', 'dist']) {
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
nincs MCP-bejegyzés, nincs beállítandó mező. A managedResources.projects alatt
deklarált CRM projektet a host reconcile-ja hozza létre az engedélyezéskor és
viszi el a törléskor -- ez a szkript nem nyúl hozzá.
`)
