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
 * The last test walks src for the step-less class, and this file is excluded
 * from that walk by name: the candidate list and the assertions below have to
 * name the class to test it, and nothing here is a class list. That exclusion
 * is the only reason the walk can afford to read every line rather than only
 * lines that look like a className -- which is what it used to do, and which
 * left 98 of the 2511 .tsx lines carrying a radius class unread, the cva()
 * variant maps in src/components/ui/button.tsx among them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileCandidates } from './globals-css-harness'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The `border-radius` a class actually emits, or null when Tailwind emitted no
 * rule for it at all. Matches the selector on its own line -- Tailwind's output
 * is one selector per line -- so `.rounded` cannot be found inside `.rounded-xs`.
 *
 * That makes every "must be null" assertion below depend on Tailwind's output
 * formatting, so each of those tests first asserts a rule this parser is known
 * to find. Without that canary a formatting change in a Tailwind minor would
 * turn the negative assertions into ones that always pass.
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

/** A rule the parser above is known to find, asserted before any "must be null". */
const CANARY = 'the emittedRadius parser no longer finds a rule it is known to emit, so every ' +
  'null assertion in this file has stopped meaning anything -- Tailwind changed its output format'

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
  assert.equal(emittedRadius(css, 'rounded-md'), '12px', CANARY)
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
  assert.equal(emittedRadius(css, 'rounded-md'), '12px', CANARY)
  assert.equal(emittedRadius(css, 'rounded'), null)
})

test('no component asks for the step-less radius class, which would render square', () => {
  // The compile tests above prove the class emits nothing; this proves nothing
  // asks for it. Every line of every .ts and .tsx under src is read: the
  // earlier version only read lines that also carried `className`, `class=` or
  // `cn(`, which hid the 4% of radius-carrying lines that build a class string
  // somewhere other than the JSX attribute -- `const btn = '... rounded ...'`,
  // a cva() variant map, a shared inputClass constant. All of those were among
  // the 57 sites this test exists to keep from coming back.
  const srcRoot = resolve(HERE, '..')
  const SELF = resolve(HERE, 'globals-radius-scale.test.ts')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!full.endsWith('.tsx') && !full.endsWith('.ts')) continue
      if (full === SELF) continue
      fs.readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/\brounded\b(?![-\w])/.test(line)) offenders.push(`${full}:${index + 1}`)
        })
    }
  }
  walk(srcRoot)
  assert.deepEqual(
    offenders,
    [],
    'a step-less radius class emits no rule here -- use rounded-xs. Comments are read too, ' +
      'so if the line above is prose rather than a class list, rephrase it or hyphenate the word',
  )
})
