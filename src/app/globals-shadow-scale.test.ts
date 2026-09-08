import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileCandidates } from './globals-css-harness.test-support'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * This design has exactly one drop shadow and it belongs to product
 * photography, which an operator's console does not have. So the app has none:
 * depth is the surface ladder and the hairline, and nothing else.
 *
 * globals.css enforces that by resetting Tailwind's `--shadow-*` namespace
 * rather than by editing the sixty-one class lists that asked for a shadow --
 * the same technique the radius scale uses, and for the same reason. An edit
 * fixes the sixty-one that exist; the reset also kills the sixty-second, typed
 * next month by someone who did not read this file.
 *
 * That makes the whole rule invisible: nothing fails, nothing warns, a
 * `shadow-lg` simply stops doing anything. This file is what turns it back
 * into something that can break. It is also the second time this project has
 * needed it -- Tailwind v4 ships `--shadow-*` in its own `@theme default`
 * block, so without an explicit `initial` the reset is a comment rather than a
 * rule, which is exactly how the radius scale silently kept Tailwind's xl..4xl.
 */

/**
 * The `box-shadow` a class actually emits, or null when Tailwind emitted no
 * rule for it at all.
 *
 * Matches the selector on its own line, like the radius harness, so `.shadow`
 * cannot be found inside `.shadow-lg`. Every "must be null" assertion below
 * therefore depends on Tailwind's output formatting, so each one first asserts
 * a rule this parser IS known to find -- without that canary, a formatting
 * change in a Tailwind minor would turn every negative assertion into one that
 * passes no matter what the stylesheet says.
 */
function emittedShadow(css: string, className: string): string | null {
  const lines = css.split('\n')
  const open = lines.findIndex((line) => line.trim() === `.${className} {`)
  if (open === -1) return null
  for (let i = open + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '}') break
    const match = /^box-shadow:\s*(.+?);$/.exec(line)
    if (match) return match[1]
  }
  return null
}

/**
 * The `filter` a class emits, or null.
 *
 * Separate from emittedShadow on purpose, and the reason is a test that
 * guarded nothing: `drop-shadow-*` compiles to a `filter:` declaration, not a
 * `box-shadow:` one, so asking emittedShadow about it returned null whatever
 * the stylesheet said. Removing `--drop-shadow-*: initial` from globals.css
 * left the suite green -- the assertion was reading a property the class never
 * writes.
 */
function emittedFilter(css: string, className: string): string | null {
  const lines = css.split('\n')
  const open = lines.findIndex((line) => line.trim() === `.${className} {`)
  if (open === -1) return null
  for (let i = open + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '}') break
    const match = /^filter:\s*(.+?);$/.exec(line)
    if (match) return match[1]
  }
  return null
}

/** The same walk, used by the canary: does Tailwind emit this class at all? */
function emitsAnything(css: string, className: string): boolean {
  return css.split('\n').some((line) => line.trim() === `.${className} {`)
}

const NAMED_STEPS = ['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl']

/** A class the parser is known to find, proving a null below means "absent". */
const CANARY = 'the emittedShadow parser no longer finds a rule it is known to emit, so every null assertion in this file has stopped meaning anything -- Tailwind changed its output format'

test('every named shadow step compiles to nothing', async () => {
  const css = await compileCandidates([...NAMED_STEPS, 'rounded-lg'])
  // The canary. rounded-lg is on a live scale and must emit, which proves the
  // harness compiled something and that a null result below is a real absence.
  assert.equal(emitsAnything(css, 'rounded-lg'), true, CANARY)
  for (const step of NAMED_STEPS) {
    assert.equal(
      emittedShadow(css, step),
      null,
      `.${step} still emits a shadow -- the --shadow-* namespace reset in globals.css is not taking effect. Tailwind v4 ships this namespace in its own @theme default block, so the reset must say \`--shadow-*: initial\` explicitly.`,
    )
  }
})

test('the step-less shadow utility is dead too', async () => {
  // `shadow` is the DEFAULT key of the same namespace, not a separate
  // variable -- exactly the trap the radius scale hit, where `--radius-*:
  // initial` also deleted the step-less radius class and squared fifty-seven
  // sites that nobody had noticed were asking for it. (Naming that class here
  // would trip the radius suite's own scan, which reads comments too.)
  const css = await compileCandidates(['shadow', 'rounded-lg'])
  assert.equal(emitsAnything(css, 'rounded-lg'), true, CANARY)
  assert.equal(emittedShadow(css, 'shadow'), null)
})

test('inset and drop shadows are dead as well', async () => {
  // Three separate namespaces. Resetting only --shadow-* would leave
  // `inset-shadow-sm` and `drop-shadow-lg` alive to reintroduce the idiom
  // under a different class name.
  const css = await compileCandidates(['inset-shadow-sm', 'drop-shadow-lg', 'rounded-lg'])
  assert.equal(emitsAnything(css, 'rounded-lg'), true, CANARY)
  assert.equal(emittedShadow(css, 'inset-shadow-sm'), null)
  // Read `filter`, not `box-shadow` -- see the note on emittedFilter.
  assert.equal(emittedFilter(css, 'drop-shadow-lg'), null)
})

test('the one permitted shadow survives, and is not on the namespace', () => {
  // .overlay-panel is raw CSS, so the reset cannot reach it -- which is the
  // point. A panel floating over a dimmed copy of the whole app is doing
  // something no ladder step expresses, and macOS shadows its own sheets for
  // the same reason. If this assertion ever fails because the rule was folded
  // into a Tailwind utility, the reset above will have silently killed the
  // last shadow the design actually wants.
  const source = fs.readFileSync(resolve(HERE, 'globals.css'), 'utf8')
  assert.match(source, /\.overlay-panel\s*\{[^}]*box-shadow:\s*var\(--overlay-shadow\)/)
  // And it has a value in BOTH themes. A shadow defined only under :root
  // renders as `box-shadow: ;` on the light one -- no error, no shadow.
  const roots = source.match(/--overlay-shadow:\s*[^;]+;/g) ?? []
  assert.equal(roots.length, 2, 'expected --overlay-shadow in both :root and .light')
})

/**
 * Discrimination proofs. Each mutation was applied to a temp copy of
 * globals.css and the named test confirmed to fail:
 *
 *   1. remove `--shadow-*: initial`          breaks tests 1 AND 2
 *   2. remove `--inset-shadow-*: initial`    breaks "inset and drop shadows"
 *   3. remove `--drop-shadow-*: initial`     breaks "inset and drop shadows"
 *   4. remove the .overlay-panel box-shadow  breaks "the one permitted shadow"
 *   5. delete --overlay-shadow from .light   breaks "the one permitted shadow"
 *
 * (3) is here because the first version of it did NOT discriminate: the
 * assertion asked emittedShadow about a class that writes `filter`, so it
 * returned null no matter what globals.css said, and removing the reset left
 * the suite green. emittedFilter exists because of that, and this line is the
 * proof that the replacement actually fails.
 *
 * (5) is the one worth keeping longest: it is the failure that renders as
 * nothing at all rather than as an error, and it is how a light-mode panel
 * would have quietly lost the only shadow in the system.
 */
