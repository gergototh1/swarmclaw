/**
 * Compiles the real stylesheet and asserts what the `@theme inline` block
 * actually emits for the three font-family variables.
 *
 * Why this exists: `next/font` (src/app/fonts.ts) writes the real font
 * faces onto <html> as `--font-sans-face` / `--font-display-face` /
 * `--font-mono-face`, and the theme keys in globals.css --
 * `--font-sans` / `--font-display` / `--font-mono` -- reference those
 * `-face` variables. If a future edit ever renames either side back to the
 * same name as the other, the declaration becomes a custom property that
 * references itself, which is invalid at computed-value time. Chromium
 * discards a cyclic declaration entirely, generic fallback tail included,
 * and it does so silently: no build error, no lint error, no type error,
 * and (per src/app/globals-radius-scale.test.ts, which exists for the same
 * class of bug) every other gate stays green while every font on the page
 * quietly reverts to `system-ui`.
 *
 * So this compiles src/app/globals.css through Tailwind's own compile() and
 * checks the emitted `--font-*` declarations, rather than reading the
 * stylesheet's text -- text review is exactly what missed this the first
 * time these three names were introduced.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileCandidates, GLOBALS_CSS } from './globals-css-harness'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The value Tailwind emitted for a `--name: value;` custom property
 * declaration, or null if the property was never declared at all.
 */
function emittedCustomProperty(css: string, name: string): string | null {
  const match = new RegExp(`^\\s*--${name}:\\s*(.+);\\s*$`, 'm').exec(css)
  return match ? match[1] : null
}

const FONT_VARS: ReadonlyArray<readonly [string, string]> = [
  ['font-sans', 'font-sans-face'],
  ['font-display', 'font-display-face'],
  ['font-mono', 'font-mono-face'],
]

test('each font theme key resolves to its -face counterpart', async () => {
  const css = await compileCandidates([])
  for (const [themeKey, faceVar] of FONT_VARS) {
    const value = emittedCustomProperty(css, themeKey)
    assert.notEqual(value, null, `--${themeKey} must be declared in the compiled CSS`)
    assert.match(
      value as string,
      new RegExp(`^var\\(--${faceVar}\\)`),
      `--${themeKey} must start with var(--${faceVar}), got: ${value}`,
    )
  }
})

test('none of the three font theme keys reference themselves', async () => {
  const css = await compileCandidates([])
  for (const [themeKey] of FONT_VARS) {
    const value = emittedCustomProperty(css, themeKey)
    assert.notEqual(value, null, `--${themeKey} must be declared in the compiled CSS`)
    assert.doesNotMatch(
      value as string,
      new RegExp(`var\\(--${themeKey}\\)`),
      `--${themeKey} must not reference itself -- a self-referencing custom property is ` +
        'invalid at computed-value time and the whole declaration (fallback tail included) ' +
        'is silently discarded. An undefined -face variable does the same thing, which is ' +
        'why every root that renders its own <html> takes its classes from fontVariables ' +
        'in src/app/fonts.ts',
    )
  }
})

test('discriminates: a self-referencing theme key fails the assertion above', async (t) => {
  // Proves the previous test can actually fail, not just always pass. Writes
  // a sibling stylesheet identical to globals.css except the three theme
  // keys are reverted to reference their own name, compiles that, and
  // asserts the self-reference check now catches it.
  const brokenPath = resolve(HERE, 'globals-font-family.broken-fixture.css')
  const source = await readFile(GLOBALS_CSS, 'utf8')
  const broken = source
    .replace(
      '--font-sans: var(--font-sans-face), system-ui, sans-serif;',
      '--font-sans: var(--font-sans), system-ui, sans-serif;',
    )
    .replace(
      '--font-display: var(--font-display-face), system-ui, sans-serif;',
      '--font-display: var(--font-display), system-ui, sans-serif;',
    )
    .replace(
      "--font-mono: var(--font-mono-face), ui-monospace, 'SF Mono', monospace;",
      "--font-mono: var(--font-mono), ui-monospace, 'SF Mono', monospace;",
    )
  assert.notEqual(broken, source, 'fixture setup must actually change the three declarations')

  await writeFile(brokenPath, broken, 'utf8')
  t.after(() => unlink(brokenPath))

  const css = await compileCandidates([], brokenPath)
  const offenders: string[] = []
  for (const [themeKey] of FONT_VARS) {
    const value = emittedCustomProperty(css, themeKey)
    if (value !== null && new RegExp(`var\\(--${themeKey}\\)`).test(value)) {
      offenders.push(themeKey)
    }
  }
  assert.deepEqual(
    offenders,
    ['font-sans', 'font-display', 'font-mono'],
    'the broken fixture must reproduce a self-reference on all three theme keys, ' +
      'otherwise the self-reference test above cannot be trusted to fail when it should',
  )
})
