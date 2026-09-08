#!/usr/bin/env node
/**
 * One-shot codemod: put the extensions' own stylesheets on the host's radius
 * scale.
 *
 * The six extensions that ship a UI -- aisignal, crm, docs, gmail, tts, video
 * -- render inside the host and inherit its tokens, but their CSS lives
 * outside `src/` and so every pass over the app's own stylesheets missed them.
 * Between them they spell thirteen distinct radii: 0, 2, 3, 4, 6, 8, 10, 12,
 * 16, 50%, 999px, and two `var()` references to values the host no longer
 * means. The host spells five. A CRM card at 12px sitting beside a host card
 * at 18px is the mismatch you see first.
 *
 * The mapping is the one codemod-radius.mjs already established for `src/`:
 * nearest step upward by bound, because these were written against a scale
 * whose steps sat between the host's and rounding down would flatten a card
 * into a control.
 *
 * NOT rewritten, and each refusal is reported rather than guessed:
 *
 *   - `50%` and `999px` are circles and pills; the scale has `full` and this
 *     script maps them, but any other percentage is a shape decision the
 *     five-step scale does not express.
 *   - `0` is deliberate square, and stays.
 *   - A `var()` whose fallback this script does not recognise: the extension is
 *     asking the host for something, and quietly replacing that with a literal
 *     would break the link it was reaching for.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Upper bound -> token. Same ladder as codemod-radius.mjs: a value belongs to
 * the first step it does not exceed.
 */
const STEPS = [
  [5, 'xs'],
  [8, 'sm'],
  [11, 'md'],
  [18, 'lg'],
]

/** Values that mean "fully round" whatever the number says. */
const FULL = new Set(['50%', '999px', '9999px', '100%'])

/**
 * The two `var()` forms these stylesheets use, and the pixel value each one
 * actually rendered. `--radius` is shadcn's single-value token, kept alive in
 * globals.css only so re-running the shadcn CLI cannot resurrect a second
 * scale; `--radius-sm` is a Tailwind theme key rather than a CSS variable, so
 * that reference never resolved at all and always rendered its fallback.
 */
const VAR_FORMS = new Map([
  ['var(--radius, .625rem)', 10],
  ['var(--radius, 0.625rem)', 10],
  ['var(--radius-sm, .375rem)', 6],
  ['var(--radius-sm, 0.375rem)', 6],
])

/**
 * Map one radius value to a host token, or null when it should be left alone.
 *
 * Exported so the test pins the mapping itself rather than only its output.
 */
export function mapRadiusValue(raw) {
  const value = raw.trim()
  if (value === '0' || value === '0px') return null
  if (FULL.has(value)) return 'var(--radius-full)'
  if (VAR_FORMS.has(value)) return tokenForPx(VAR_FORMS.get(value))
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value)
  if (px) return tokenForPx(Number(px[1]))
  const rem = /^(\d+(?:\.\d+)?)rem$/.exec(value)
  if (rem) return tokenForPx(Number(rem[1]) * 16)
  return null
}

function tokenForPx(px) {
  for (const [bound, name] of STEPS) if (px <= bound) return `var(--radius-${name})`
  return 'var(--radius-lg)'
}

/** Every `border-radius` declaration, whatever its value. */
const DECL_RE = /(border(?:-[a-z]+)*-radius\s*:\s*)([^;}]+)/g

/** Read-only: every radius value in a stylesheet, mapped or not. */
export function findRadiusValues(css) {
  return [...css.matchAll(DECL_RE)].map((m) => m[2].trim())
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.css')) out.push(full)
  }
  return out
}

function main() {
  const refused = new Map()
  let changed = 0
  let files = 0

  for (const file of walk(join(REPO_ROOT, 'extensions'))) {
    const before = readFileSync(file, 'utf8')
    const after = before.replace(DECL_RE, (whole, head, value) => {
      // A shorthand with several values (`12px 12px 0 0`) is a corner-by-corner
      // decision; mapping only the first would silently change the shape.
      if (value.trim().split(/\s+/).length > 1 && !value.includes('(')) {
        const parts = value.trim().split(/\s+/)
        const mapped = parts.map((p) => mapRadiusValue(p))
        if (mapped.some((m) => m === null)) {
          refused.set(value.trim(), (refused.get(value.trim()) ?? 0) + 1)
          return whole
        }
        changed += 1
        return head + mapped.join(' ')
      }
      const mapped = mapRadiusValue(value)
      if (mapped === null) {
        refused.set(value.trim(), (refused.get(value.trim()) ?? 0) + 1)
        return whole
      }
      changed += 1
      return head + mapped
    })
    if (after !== before) {
      writeFileSync(file, after)
      files += 1
    }
  }

  console.log(`mapped ${changed} radii across ${files} stylesheets`)
  if (refused.size > 0) {
    console.log('\nleft alone -- deliberate, or a shape the five-step scale does not express:')
    for (const [v, n] of [...refused].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${v}`)
  }
}

if (process.argv[1]?.endsWith('codemod-extension-radius.mjs')) main()
