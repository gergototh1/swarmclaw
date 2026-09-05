import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Copies this workspace into the extensions directory of a running SwarmClaw.
 *
 * The host loads `<data>/extensions/docs.mjs`, which is a one-line shim
 * re-exporting `.workspaces/docs_mjs/index.js`. Everything the module needs at
 * runtime is `src/` and `dist/`, so those two directories and the two files
 * beside them are what get copied. `node_modules` is not: the module imports
 * nothing outside Node's own library at runtime -- TipTap and the markdown
 * converters are bundled into `dist/index.js` at build time, which is why the
 * build has to have run before this does.
 *
 * This module ships no skills and declares no managed agents, so unlike the
 * video module's installer there is nothing here to reconcile or to clean up
 * beyond the workspace itself.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/**
 * Where the desktop app keeps its home on this machine (`electron/paths.ts`:
 * userData + '/home'), when this is a machine that has one. Only the macOS
 * location is known here; anywhere else this is null and the fallbacks apply.
 */
function desktopHome() {
  if (process.platform !== 'darwin') return null
  const candidate = path.join(process.env.HOME || '', 'Library/Application Support/@swarmclawai/swarmclaw/home')
  return fs.existsSync(candidate) ? candidate : null
}

// The host's own resolution order (src/lib/server/data-dir.ts): an explicit
// DATA_DIR wins, then SWARMCLAW_HOME/data, then the desktop app's home when
// this machine has one, and otherwise <cwd>/data.
const explicitHome = process.env.SWARMCLAW_HOME || null
const desktop = explicitHome ? null : desktopHome()
const dataDir = process.env.DATA_DIR
  || (explicitHome ? path.join(explicitHome, 'data') : null)
  || (desktop ? path.join(desktop, 'data') : null)
  || path.join(process.cwd(), 'data')

const extDir = path.join(dataDir, 'extensions')
const wsDir = path.join(extDir, '.workspaces', 'docs_mjs')

if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
  console.error('Nincs meg a dist/index.js. Futtasd előbb: npm run build')
  process.exit(1)
}

fs.mkdirSync(wsDir, { recursive: true })
for (const dir of ['src', 'dist']) {
  const src = path.join(root, dir)
  if (!fs.existsSync(src)) continue
  // Replace rather than merge: cpSync leaves a file that was renamed or deleted
  // in the repo sitting in the workspace, where it keeps being imported.
  fs.rmSync(path.join(wsDir, dir), { recursive: true, force: true })
  fs.cpSync(src, path.join(wsDir, dir), { recursive: true })
}
fs.copyFileSync(path.join(root, 'index.mjs'), path.join(wsDir, 'index.js'))
fs.copyFileSync(path.join(root, 'package.json'), path.join(wsDir, 'package.json'))
fs.writeFileSync(path.join(extDir, 'docs.mjs'), "export { default } from './.workspaces/docs_mjs/index.js'\n")

console.log(`Telepítve ide: ${extDir}/docs.mjs`)
console.log('Kapcsold be a SwarmClaw Extensions listájában, és állítsd be a doksi-gyökeret.')
