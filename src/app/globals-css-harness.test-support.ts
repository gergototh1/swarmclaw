/**
 * Compiles src/app/globals.css through Tailwind's own compile(), for the two
 * tests that assert on what Tailwind actually emits
 * (globals-radius-scale.test.ts and globals-font-family.test.ts). Nothing in
 * the app imports this; it exists so the two tests share one resolver instead
 * of keeping two copies of it in step.
 *
 * Why the resolver is hand-rolled. compile() cannot follow
 * `@import "tailwindcss"` on its own -- it hands the specifier back and asks
 * for the file -- so something has to map a package name to a stylesheet. The
 * obvious tool is enhanced-resolve, and both tests used it, but it is not in
 * package.json: it reaches node_modules only as a transitive dependency of
 * @tailwindcss/postcss -> @tailwindcss/node. A Tailwind release that stopped
 * using it would take both tests down with a module-not-found, and so would a
 * stricter install layout. Declaring a dependency in order to run a test is
 * the worse trade of the two, so the thirty lines below own the job instead
 * and everything these tests import is declared.
 *
 * The rules implemented are the ones globals.css actually exercises: a
 * relative path, a bare package (`tailwindcss`, `tw-animate-css`), and a
 * package subpath (`shadcn/tailwind.css`, `highlight.js/styles/...`). Export
 * patterns with a `*` are not handled, because none of the four use one --
 * highlight.js declares `"./styles/*"` but the literal path under the package
 * root is the same file. A specifier this cannot place throws rather than
 * guessing, so a future @import that needs more will fail loudly here.
 */
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'tailwindcss'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The stylesheet under test. */
export const GLOBALS_CSS = resolve(HERE, 'globals.css')

/** A package.json is only read for its `style` entry points, so this is all we need of it. */
type PackageManifest = {
  style?: string
  exports?: Record<string, unknown>
}

/** Split `@scope/name/sub/path` into its package name and the rest. */
function splitSpecifier(id: string): { pkg: string; subpath: string } {
  const parts = id.split('/')
  const take = id.startsWith('@') ? 2 : 1
  return { pkg: parts.slice(0, take).join('/'), subpath: parts.slice(take).join('/') }
}

/** Walk up from `base` for `node_modules/<pkg>`, the way Node itself resolves. */
function findPackageDir(pkg: string, base: string): string {
  let dir = base
  for (;;) {
    const candidate = resolve(dir, 'node_modules', pkg)
    if (fs.existsSync(resolve(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`could not find package ${pkg} from ${base}`)
    dir = parent
  }
}

/** The `style` target of one exports entry, which may be a bare string or a conditions object. */
function styleTarget(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    const conditions = entry as Record<string, unknown>
    for (const key of ['style', 'default']) {
      const value = conditions[key]
      if (typeof value === 'string') return value
    }
  }
  return null
}

/** Resolve one `@import` specifier to an absolute file path. */
export function resolveStylesheetPath(id: string, base: string): string {
  if (id.startsWith('.') || isAbsolute(id)) return resolve(base, id)

  const { pkg, subpath } = splitSpecifier(id)
  const pkgDir = findPackageDir(pkg, base)
  const manifest = JSON.parse(
    fs.readFileSync(resolve(pkgDir, 'package.json'), 'utf8'),
  ) as PackageManifest

  const exportKey = subpath ? `./${subpath}` : '.'
  const exported = styleTarget(manifest.exports?.[exportKey])
  if (exported) return resolve(pkgDir, exported)

  // No exports entry: a subpath is a literal file under the package root, and a
  // bare package falls back to the legacy top-level `style` field.
  if (subpath) return resolve(pkgDir, subpath)
  if (manifest.style) return resolve(pkgDir, manifest.style)
  throw new Error(`package ${pkg} declares no stylesheet entry point`)
}

async function loadStylesheet(id: string, base: string) {
  const path = resolveStylesheetPath(id, base)
  return { path, base: dirname(path), content: await readFile(path, 'utf8') }
}

/** Compile a stylesheet (by path) against a candidate class list. */
export async function compileCandidates(
  candidates: string[],
  cssPath: string = GLOBALS_CSS,
): Promise<string> {
  const source = await readFile(cssPath, 'utf8')
  const { build } = await compile(source, {
    base: dirname(cssPath),
    from: cssPath,
    loadStylesheet,
  })
  return build(candidates)
}
