/**
 * Compiles the real stylesheet and asserts what the `@theme inline` block
 * actually emits for the three font-family variables.
 *
 * Why this exists, and what changed. The app used to load Sora, DM Sans and
 * JetBrains Mono through `next/font`, which writes the real faces onto <html>
 * as `--font-sans-face` / `--font-display-face` / `--font-mono-face`; the
 * three theme keys here referenced those. That indirection had two silent
 * failure modes, and this file existed to pin the first of them:
 *
 *   1. A custom property whose value references itself
 *      (`--font-sans: var(--font-sans), ...`) is invalid at computed-value
 *      time. Chromium discards the whole declaration, generic fallback tail
 *      included, and reverts every font on the page to system-ui.
 *   2. A `var()` with neither a declaration nor a fallback is the same
 *      guaranteed-invalid value. Any root that did not carry next/font's class
 *      names produced exactly that -- src/app/global-error.tsx renders its own
 *      <html>, and body had no font-family at all on that route.
 *
 * Neither produces a build, lint or type error, which is why the check has to
 * compile the stylesheet rather than read it: text review is what missed this
 * the first time the three names were introduced.
 *
 * The app is now on the macOS system faces (SF Pro / SF Mono), which ship with
 * the OS and need no loader, so the three keys hold literal stacks and the
 * `-face` variables are gone. That does not retire the check, it sharpens it:
 * a stack containing no `var()` at all cannot be self-referential and cannot
 * be unresolvable, so the contract this file now pins is exactly that --
 * plus a real named face at the head (so the key is not just `system-ui`
 * wearing a name) and a generic family at the tail (so a machine without the
 * face still gets something). The discrimination test at the bottom rebuilds
 * the old self-referencing form and proves the checks still fail on it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileCandidates, GLOBALS_CSS } from './globals-css-harness.test-support'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The value Tailwind emitted for a `--name: value;` custom property
 * declaration, or null if the property was never declared at all.
 */
function emittedCustomProperty(css: string, name: string): string | null {
  const match = new RegExp(`^\\s*--${name}:\\s*(.+);\\s*$`, 'm').exec(css)
  return match ? match[1] : null
}

/**
 * Each theme key, the named face that must lead its stack, and the generic
 * family that must close it. The head is what makes the key mean something on
 * a Mac; the tail is what makes it mean something everywhere else.
 */
const FONT_VARS: ReadonlyArray<readonly [string, string, string]> = [
  ['font-sans', '-apple-system', 'sans-serif'],
  ['font-display', '-apple-system', 'sans-serif'],
  ['font-mono', "'SF Mono'", 'monospace'],
]

/** True when a value can be resolved by the cascade without any var() lookup. */
function isSelfContained(value: string): boolean {
  return !value.includes('var(')
}

test('each font theme key is a literal stack with no var() in it', async () => {
  const css = await compileCandidates([])
  for (const [themeKey] of FONT_VARS) {
    const value = emittedCustomProperty(css, themeKey)
    assert.notEqual(value, null, `--${themeKey} must be declared in the compiled CSS`)
    assert.ok(
      isSelfContained(value as string),
      `--${themeKey} must not reference another custom property, got: ${value}. ` +
        'A var() here is how this declaration gets silently discarded: pointing it at ' +
        'itself is invalid at computed-value time, and pointing it at a property no root ' +
        'declares is the same guaranteed-invalid value. Chromium drops the whole ' +
        'declaration in both cases, generic fallback tail included, with no build, lint ' +
        'or type error anywhere. The macOS system faces ship with the OS, so nothing here ' +
        'needs a loader to write a face variable onto <html>',
    )
  }
})

test('each font theme key names a real face and ends in a generic family', async () => {
  const css = await compileCandidates([])
  for (const [themeKey, head, tail] of FONT_VARS) {
    const value = emittedCustomProperty(css, themeKey) as string
    assert.notEqual(value, null, `--${themeKey} must be declared in the compiled CSS`)
    const families = value.split(',').map((part) => part.trim())
    assert.equal(
      families[0],
      head,
      `--${themeKey} must lead with ${head} -- a stack that opens on system-ui is not ` +
        'this typeface, it is whatever the browser felt like',
    )
    assert.equal(
      families[families.length - 1],
      tail,
      `--${themeKey} must end in ${tail} so a machine without the named face still ` +
        'renders in the right category',
    )
  }
})

test('discriminates: a self-referencing theme key fails the assertion above', async (t) => {
  // Proves the first test can actually fail, not just always pass. Writes a
  // sibling stylesheet identical to globals.css except the three theme keys
  // are reverted to the shape they had while next/font was in use -- each one
  // referencing a variable rather than naming a face -- and asserts the
  // no-var() check now catches all three.
  const brokenPath = resolve(HERE, 'globals-font-family.broken-fixture.css')
  const source = await readFile(GLOBALS_CSS, 'utf8')
  const broken = source
    .replace(
      "--font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;",
      '--font-sans: var(--font-sans), system-ui, sans-serif;',
    )
    .replace(
      "--font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif;",
      '--font-display: var(--font-display-face), system-ui, sans-serif;',
    )
    .replace(
      "--font-mono: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace;",
      '--font-mono: var(--font-mono), ui-monospace, monospace;',
    )
  assert.notEqual(broken, source, 'fixture setup must actually change the three declarations')

  await writeFile(brokenPath, broken, 'utf8')
  t.after(() => unlink(brokenPath))

  const css = await compileCandidates([], brokenPath)
  const offenders: string[] = []
  for (const [themeKey] of FONT_VARS) {
    const value = emittedCustomProperty(css, themeKey)
    if (value !== null && !isSelfContained(value)) offenders.push(themeKey)
  }
  assert.deepEqual(
    offenders,
    ['font-sans', 'font-display', 'font-mono'],
    'the broken fixture must reproduce a var() reference on all three theme keys -- two ' +
      'self-referencing and one pointing at the -face variable no root declares any more -- ' +
      'otherwise the check above cannot be trusted to fail when it should',
  )
})
