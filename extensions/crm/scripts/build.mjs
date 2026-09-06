import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

/**
 * Builds the page bundle the host serves from `<workspace>/dist`.
 *
 * `react`, `react-dom` and `react/jsx-runtime` must not be bundled: the host
 * renders this page inside its own React tree and a second copy of React makes
 * every hook throw. Each of the three is resolved by `hostModules` below into a
 * one-line module that reads `window.swarmclaw.modules[<name>]` at execution
 * time -- the table `components/layout/extension-host.tsx` publishes -- so the
 * built file carries no React source, only lookups into the host's table.
 *
 * Exported as `bundle` (and run from the command line at the bottom) so
 * test/ui.test.mjs can build the same graph in memory and pin that property
 * without writing dist/.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The externals the host publishes, exactly as `window.swarmclaw.modules` keys them. */
export const HOST_MODULES = Object.freeze(['react', 'react-dom', 'react/jsx-runtime'])

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
        `if (!mod) throw new Error(${JSON.stringify(`crm: host module missing: ${args.path}`)});`,
        'module.exports = mod;',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

/**
 * Build the bundle. `write: false` returns the output in memory instead of
 * writing `dist/index.js`, which is what the test uses.
 */
export async function bundle({ write = true } = {}) {
  return build({
    entryPoints: [path.join(root, 'ui/main.tsx')],
    bundle: true,
    write,
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outfile: path.join(root, 'dist/index.js'),
    plugins: [hostModules],
    minify: false,
    // esbuild's default charset ('ascii') escapes every non-ASCII character
    // (e.g. "Ügyfelek" -> "\xDCgyfelek"). The UI copy is Hungarian, so 'utf8'
    // keeps the source text readable in the built file.
    charset: 'utf8',
    sourcemap: write ? true : false,
    logLevel: 'silent',
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle()
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.copyFileSync(path.join(root, 'ui/style.css'), path.join(root, 'dist/style.css'))
  console.log('built dist/index.js, dist/style.css')
}
