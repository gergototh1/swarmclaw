import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

/**
 * Builds the page bundle the host serves from `<workspace>/dist`.
 *
 * Copied from `extensions/crm/scripts/build.mjs`, the same rule and the same
 * reason: `react`, `react-dom` and `react/jsx-runtime` must not be bundled --
 * the host renders this page inside its own React tree and a second copy of
 * React makes every hook throw. Each of the three is resolved by
 * `hostModules` below into a one-line module that reads
 * `window.swarmclaw.modules[<name>]` at execution time -- the table
 * `components/layout/extension-host.tsx` publishes -- so the built file
 * carries no React source, only lookups into the host's table.
 *
 * ONE DIFFERENCE FROM THE CRM COPY: this task builds the module's skeleton
 * before its calendar page exists (spec 10 lists `ui/` as a later task's
 * file). There is no `ui/` directory yet, and `bundle()` would throw
 * esbuild's own "could not resolve entry point" if it were called against a
 * path that is not on disk. `buildTerv()` below decides between three
 * different facts, because they are three different facts:
 *
 *   no `ui/` at all       -- the page task has not run. Skip, exit 0.
 *   `ui/` but no ENTRY    -- the page task ran and this script cannot see its
 *                            entry point. HARD FAIL, non-zero exit.
 *   `ui/` and ENTRY       -- build.
 *
 * The middle branch is the whole point. An exit-0 skip keyed on one exact
 * path is a gate that can only ever pass: name the entry `ui/index.tsx`, or
 * move it under `ui/src/`, and this script goes on reporting "no page yet",
 * goes on exiting 0, and goes on writing nothing -- while the page task's own
 * gate goes green and the served page 404s on both assets, which from the
 * host's side is indistinguishable from a broken install. A skip must be
 * keyed on the absence of the whole directory, which is the only shape of
 * "not built yet" that cannot also mean "built, and I looked in the wrong
 * place".
 *
 * Exported as `bundle` (and run from the command line at the bottom) so a
 * future `test/ui.test.mjs` can build the same graph in memory and pin that
 * property without writing dist/, the way the CRM module's does.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The externals the host publishes, exactly as `window.swarmclaw.modules` keys them. */
export const HOST_MODULES = Object.freeze(['react', 'react-dom', 'react/jsx-runtime'])

/** The page's own directory. Its ABSENCE -- and nothing narrower -- is what "the page task has not run yet" means. */
export const UI_DIR_NEV = 'ui'

/** Where the page's entry point must be, relative to the module root. A later task that moves it edits this line, and `buildTerv` fails loudly until it does. */
export const ENTRY_RELATIV = path.join(UI_DIR_NEV, 'main.tsx')

/** Absolute path to the page's entry point, once it exists. */
export const ENTRY = path.join(root, ENTRY_RELATIV)

/**
 * What the command line should do about the workspace at `gyoker`.
 *
 * Split out of the runner and given a root argument so a test can put each of
 * the three shapes on disk and pin the answer; the runner below is then a
 * two-line switch with nothing left in it to get wrong.
 */
export function buildTerv(gyoker = root) {
  if (!fs.existsSync(path.join(gyoker, UI_DIR_NEV))) {
    return { teendo: 'kihagy', uzenet: `nincs ${UI_DIR_NEV}/ könyvtár: a naptár lap ebben a kiadásban még nem készült el, nincs mit buildelni.` }
  }
  if (!fs.existsSync(path.join(gyoker, ENTRY_RELATIV))) {
    return { teendo: 'megall', uzenet: `van ${UI_DIR_NEV}/ könyvtár, de nincs ${ENTRY_RELATIV}: a lap belépőpontját ezen a néven kell megtalálni, különben a build csendben nem ír semmit, és a kiszolgált lap mindkét assetre 404-et ad. Nevezd át a belépőt ${ENTRY_RELATIV}-re, vagy írd át az ENTRY_RELATIV-ot ebben a fájlban.` }
  }
  return { teendo: 'buildel', uzenet: null }
}

/**
 * The esbuild resolver hook that turns each host module import into a lookup.
 *
 * A missing entry throws with the module's name at bundle execution, which is
 * the earliest moment the bundle can know: the table is only there once the
 * host's shell has installed `window.swarmclaw`, and `loadExtensionPage` injects
 * this script after that. A throw here lands as an uncaught error in the
 * console and the page route's timeout reports the page as never registered.
 */
const hostModules = {
  name: 'swarmclaw-host-modules',
  setup(api) {
    const filter = new RegExp(`^(${HOST_MODULES.map((m) => m.replace('/', '\\/')).join('|')})$`)
    api.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'swarmclaw-host' }))
    api.onLoad({ filter: /.*/, namespace: 'swarmclaw-host' }, (args) => ({
      contents: [
        `var host = typeof window !== 'undefined' && window.swarmclaw;`,
        `var mod = host && host.modules && host.modules[${JSON.stringify(args.path)}];`,
        `if (!mod) throw new Error(${JSON.stringify(`publish: host module missing: ${args.path}`)});`,
        'module.exports = mod;',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

/**
 * Build the bundle. `write: false` returns the output in memory instead of
 * writing `dist/index.js`, which is what a future test would use.
 */
export async function bundle({ write = true } = {}) {
  return build({
    entryPoints: [ENTRY],
    bundle: true,
    write,
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outfile: path.join(root, 'dist/index.js'),
    plugins: [hostModules],
    minify: false,
    // esbuild's default charset ('ascii') escapes every non-ASCII character
    // (e.g. "Ütemezés" -> "\xDAtemez\xE9s"). The UI copy is Hungarian, so
    // 'utf8' keeps the source text readable in the built file.
    charset: 'utf8',
    sourcemap: write ? true : false,
    logLevel: 'silent',
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const terv = buildTerv()
  if (terv.teendo === 'kihagy') {
    console.log(terv.uzenet)
  } else if (terv.teendo === 'megall') {
    console.error(terv.uzenet)
    process.exitCode = 1
  } else {
    await bundle()
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
    fs.copyFileSync(path.join(root, UI_DIR_NEV, 'style.css'), path.join(root, 'dist/style.css'))
    console.log('built dist/index.js, dist/style.css')
  }
}
