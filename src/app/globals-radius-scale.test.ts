/**
 * Compiles the real stylesheet and asserts what Tailwind actually emits for
 * the radius scale.
 *
 * Why this exists: a Tailwind class whose theme key does not exist is dropped
 * silently. No build error, no lint error, no type error -- the class just
 * stops producing a rule and the corner renders square. Three radius bugs
 * shipped in the redesign that way, and the `--radius-*: initial` namespace
 * reset in globals.css that fixes them had no proof of life in the repo:
 * deleting that one line left every gate green while rounded-3xl quietly came
 * back at Tailwind's built-in 24px.
 *
 * So this compiles src/app/globals.css through Tailwind's own compile() and
 * checks the emitted CSS, rather than reading the stylesheet's text. Note the
 * reset is what makes the five-step scale real AND what removes the
 * step-less radius utility (Tailwind's --radius is the DEFAULT key of the same
 * namespace, not a separate variable), so both halves are pinned below.
 *
 * A wording note, since it looks stilted on purpose: the step-less class is
 * never written out as a standalone word anywhere below, because the repo
 * checks for its return with a grep over src that cannot tell a class list
 * from a sentence. Prose naming it here would make that grep report a
 * regression that is not one.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import EnhancedResolve from 'enhanced-resolve'
import { compile } from 'tailwindcss'

const HERE = dirname(fileURLToPath(import.meta.url))
const GLOBALS_CSS = resolve(HERE, 'globals.css')

/**
 * Resolves the stylesheet's `@import`s the way a bundler does: `style` main
 * field and condition, `.css` extension. Without it compile() cannot follow
 * `@import "tailwindcss"` and there is no theme to test.
 */
const cssResolver = EnhancedResolve.ResolverFactory.createResolver({
  fileSystem: new EnhancedResolve.CachedInputFileSystem(fs, 4000),
  useSyncFileSystemCalls: true,
  extensions: ['.css'],
  mainFields: ['style'],
  conditionNames: ['style'],
})

async function loadStylesheet(id: string, base: string) {
  const path = cssResolver.resolveSync({}, base, id)
  if (!path) throw new Error(`could not resolve stylesheet ${id} from ${base}`)
  return { path, base: dirname(path), content: await readFile(path, 'utf8') }
}

/** Compile the real stylesheet against a candidate list. */
async function compileCandidates(candidates: string[], cssPath = GLOBALS_CSS): Promise<string> {
  const source = await readFile(cssPath, 'utf8')
  const { build } = await compile(source, {
    base: dirname(cssPath),
    from: cssPath,
    loadStylesheet,
  })
  return build(candidates)
}

/**
 * The `border-radius` a class actually emits, or null when Tailwind emitted no
 * rule for it at all. Matches the selector on its own line -- Tailwind's output
 * is one selector per line -- so `.rounded` cannot be found inside `.rounded-xs`.
 */
function emittedRadius(css: string, className: string): string | null {
  const lines = css.split('\n')
  const open = lines.findIndex((line) => line.trim() === `.${className} {`)
  if (open === -1) return null
  for (let i = open + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '}') break
    const match = /^border-radius:\s*(.+?);$/.exec(line)
    if (match) return match[1]
  }
  return null
}

/** The five steps globals.css declares, and nothing else. */
const INTENDED_SCALE: ReadonlyArray<readonly [string, string]> = [
  ['rounded-xs', '6px'],
  ['rounded-sm', '8px'],
  ['rounded-md', '12px'],
  ['rounded-lg', '16px'],
  ['rounded-full', '9999px'],
]

/**
 * Steps that must NOT compile. xl..4xl are Tailwind's own defaults, killed by
 * the namespace reset; `pill` never existed and stands in for any invented
 * name, proving a missing token really does produce no rule.
 */
const FORBIDDEN_STEPS = ['rounded-xl', 'rounded-2xl', 'rounded-3xl', 'rounded-4xl', 'rounded-pill']

const ALL_CANDIDATES = ['rounded', ...INTENDED_SCALE.map(([c]) => c), ...FORBIDDEN_STEPS]

test('the five named radius steps compile to their intended pixel values', async () => {
  const css = await compileCandidates(ALL_CANDIDATES)
  for (const [className, expected] of INTENDED_SCALE) {
    assert.equal(
      emittedRadius(css, className),
      expected,
      `.${className} must emit border-radius: ${expected}`,
    )
  }
})

test('the radius steps outside the scale compile to nothing at all', async () => {
  const css = await compileCandidates(ALL_CANDIDATES)
  for (const className of FORBIDDEN_STEPS) {
    assert.equal(
      emittedRadius(css, className),
      null,
      `.${className} must emit no rule -- the --radius-* namespace reset in globals.css is missing or has been overridden`,
    )
  }
})

test('the step-less radius utility does not exist on this scale', async () => {
  // Tailwind's --radius: 0.25rem is the DEFAULT key of the --radius-*
  // namespace, so `--radius-*: initial` removes it along with xl..4xl. That is
  // intended: all 57 step-less uses in src were rewritten to rounded-xs, and
  // a sixth radius should not exist. If this ever emits a rule again, the
  // reset has been weakened or --radius re-declared.
  const css = await compileCandidates(ALL_CANDIDATES)
  assert.equal(emittedRadius(css, 'rounded'), null)
})

test('no component asks for the step-less radius class, which would render square', () => {
  // The compile tests above prove the class emits nothing; this proves nothing
  // asks for it. Scoped to lines that actually carry a class list so that prose
  // mentioning the word does not trip it -- a class list split across lines
  // would slip past, which is the accepted limit of a line-wise scan.
  const srcRoot = resolve(HERE, '..')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!full.endsWith('.tsx')) continue
      fs.readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!/className|class=|\bcn\(/.test(line)) return
          if (/\brounded\b(?![-\w])/.test(line)) offenders.push(`${full}:${index + 1}`)
        })
    }
  }
  walk(srcRoot)
  assert.deepEqual(offenders, [], 'a step-less radius class emits no rule here -- use rounded-xs')
})
