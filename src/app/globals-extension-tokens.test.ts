import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const EXTENSIONS = resolve(REPO_ROOT, 'extensions')

/**
 * The six extensions that ship a UI render inside the host and style themselves
 * with the host's tokens -- but their CSS lives outside `src/`, so nothing that
 * governs the app's own stylesheets reaches them, and nothing checked that the
 * tokens they ask for exist.
 *
 * They cannot fail loudly either. Every reference is written
 * `var(--token, #fallback)`, so a token the host does not define renders a
 * hardcoded colour instead: no error, no warning, just the wrong colour. Three
 * were doing exactly that when this test was written --
 *
 *   --color-focus        -> #2563eb, a blue nobody chose, on every focus ring
 *                           in aisignal, gmail and video
 *   --color-text-muted   -> #6b7280
 *   --destructive-muted  -> #fef2f2
 *
 * -- and the fallbacks are all Midnight Glass values, the palette this design
 * replaced. So the failure mode is not "unstyled": it is the previous design
 * quietly reappearing inside one panel.
 *
 * This test is what makes a renamed or removed token break something.
 */

/** Every `--token` an extension stylesheet reads, with the file that reads it. */
function collectExtensionTokenRefs(): Map<string, string[]> {
  const refs = new Map<string, string[]>()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.css')) continue
      const css = fs.readFileSync(full, 'utf8')
      for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        const list = refs.get(m[1]) ?? []
        const where = relative(REPO_ROOT, full)
        if (!list.includes(where)) list.push(where)
        refs.set(m[1], list)
      }
    }
  }
  walk(EXTENSIONS)
  return refs
}

/**
 * Tokens an extension may read without the host declaring them.
 *
 * Empty, and meant to stay that way. An entry here is a promise that the
 * fallback beside the reference is a deliberate value rather than a leftover,
 * and each one needs the reason written next to it.
 */
const ALLOWED_UNRESOLVED = new Set<string>([])

test('every token an extension stylesheet reads is one the host defines', () => {
  const refs = collectExtensionTokenRefs()
  assert.ok(refs.size > 0, 'found no token references at all -- the walker is not reaching extensions/')

  // Read the stylesheet SOURCE, not a compiled slice of it. Compiling was the
  // first attempt and it was wrong in a way worth recording: `@theme inline`
  // tree-shakes, emitting a --color-* variable only when some utility in the
  // candidate list needs it, so the compiled output declared nine fewer tokens
  // than globals.css does and the test blamed the extensions for the harness.
  // Both halves of the system -- the `@theme inline` keys and the runtime
  // variables under :root and .light -- appear literally as `--name:` here.
  const source = fs.readFileSync(resolve(HERE, 'globals.css'), 'utf8')
  const declared = new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
  assert.ok(declared.size > 100, 'globals.css declared suspiciously few tokens -- the scan is not reading it')

  const missing = [...refs.keys()]
    .filter((token) => !declared.has(token) && !ALLOWED_UNRESOLVED.has(token))
    .sort()
    .map((token) => `${token}  (read by ${refs.get(token)!.join(', ')})`)

  assert.deepEqual(
    missing,
    [],
    'these tokens are read by an extension but not defined by the host, so each one silently renders the hardcoded fallback beside it -- which in this codebase means a colour from the palette this design replaced',
  )
})

test('the radius scale an extension reads is the host scale', () => {
  // A narrower check with its own message, because this is the one that goes
  // wrong by drift rather than by rename: the host has five steps, and an
  // extension reaching for a sixth gets a fallback-shaped card.
  const refs = collectExtensionTokenRefs()
  const radii = [...refs.keys()].filter((t) => t.startsWith('--radius'))
  const allowed = new Set(['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-full'])
  const off = radii.filter((r) => !allowed.has(r)).sort()
  assert.deepEqual(off, [], 'an extension is asking for a radius step the five-step scale does not have')
})

/**
 * Discrimination proofs. Each mutation was applied and the named test
 * confirmed to fail:
 *
 *   1. reintroduce `var(--color-focus, #2563eb)` in an extension stylesheet
 *      -> breaks "every token an extension stylesheet reads"
 *   2. reintroduce `var(--radius-xl, 24px)`
 *      -> breaks "the radius scale an extension reads"
 *   3. point the walker at src/ instead of extensions/
 *      -> breaks the `refs.size > 0` guard, so a walker that stops finding
 *         files fails loudly instead of passing on an empty set
 */
