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
 * TipTap and ProseMirror ARE bundled, because the host publishes no copy of
 * them. That is the bulk of the output, and `test/ui.test.mjs` pins a ceiling
 * on it so the page cannot quietly grow into a megabyte.
 *
 * Exported as `bundle` (and run from the command line at the bottom) so the
 * test can build the same graph in memory and inspect it without writing dist/.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The externals the host publishes, exactly as `window.swarmclaw.modules` keys them. */
export const HOST_MODULES = Object.freeze(['react', 'react-dom', 'react/jsx-runtime'])

const hostModules = {
  name: 'swarmclaw-host-modules',
  setup(api) {
    const filter = new RegExp(`^(${HOST_MODULES.map((m) => m.replace('/', '\\/')).join('|')})$`)
    api.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'swarmclaw-host' }))
    api.onLoad({ filter: /.*/, namespace: 'swarmclaw-host' }, (args) => ({
      contents: [
        "var host = typeof window !== 'undefined' && window.swarmclaw;",
        `var mod = host && host.modules && host.modules[${JSON.stringify(args.path)}];`,
        `if (!mod) throw new Error(${JSON.stringify(`docs: host module missing: ${args.path}`)});`,
        'module.exports = mod;',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

export async function bundle({ write = true, minify = true } = {}) {
  return build({
    entryPoints: [path.join(root, 'ui/main.tsx')],
    bundle: true,
    write,
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outfile: path.join(root, 'dist/index.js'),
    plugins: [hostModules],
    minify,
    sourcemap: false,
    logLevel: 'silent',
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle()
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.copyFileSync(path.join(root, 'ui/style.css'), path.join(root, 'dist/style.css'))
  const size = fs.statSync(path.join(root, 'dist/index.js')).size
  console.log(`built dist/index.js (${Math.round(size / 1024)} kB), dist/style.css`)
}
