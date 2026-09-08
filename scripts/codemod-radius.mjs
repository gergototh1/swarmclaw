#!/usr/bin/env node
/**
 * One-shot codemod: 1837 arbitrary rounded-[Npx] classes, spread over
 * nineteen distinct pixel values (3-28px, plus 999px for pills), onto a
 * five-step scale. Nineteen radii is why the surface reads as unplanned; the
 * ESLint guard in eslint.config.mjs keeps a twentieth from appearing now that
 * this has run.
 *
 * Same shape as codemod-surfaces.mjs: refuse and report rather than guess.
 * The two regexes below are deliberately asymmetric for the same reason that
 * script's TARGET_RE ended up wider than its CLASS_RE — Task 1 shipped with
 * the side/direction list hardcoded into both regexes, and the two drifted
 * apart, silently skipping a class shape neither one covered. Here CLASS_RE
 * is the single place that enumerates valid Tailwind side/corner suffixes;
 * TARGET_RE stays generic (`-[a-z]+` for any suffix at all) so it can never
 * miss a shape CLASS_RE knows about, and anything it catches that CLASS_RE
 * doesn't recognize falls through to the unmapped report instead of vanishing.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root derived from this file, so the walk does not depend on the cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** [upper bound in px (inclusive), scale name] — first matching bound wins. */
const STEPS = [
  [7, 'xs'],
  [10, 'sm'],
  [14, 'md'],
  [40, 'lg'],
]

/** Every side/corner suffix Tailwind v4's rounded-* utility actually takes. */
const SIDES = ['t', 'b', 'l', 'r', 'tl', 'tr', 'bl', 'br', 's', 'e', 'ss', 'se', 'es', 'ee']

const CLASS_RE = new RegExp(`^((?:[a-z0-9-]+:)*)rounded(-(?:${SIDES.join('|')}))?-\\[(\\d+)px\\]$`)

/**
 * Map one arbitrary radius class to the scale, or null when it cannot be
 * mapped (percentages, CSS variables, zero, or anything wider than the lg
 * step — each of those means something the five-step scale does not express).
 */
export function mapRadiusClass(cls) {
  const m = CLASS_RE.exec(cls)
  if (!m) return null
  const [, variants, side = '', pxRaw] = m
  const px = Number(pxRaw)
  if (px <= 0) return null
  if (px >= 999) return `${variants}rounded${side}-full`
  for (const [bound, name] of STEPS) if (px <= bound) return `${variants}rounded${side}-${name}`
  return null
}

/**
 * Every `rounded[-<anything>]-[...]` in the text, whatever the suffix and
 * whatever is inside the brackets.
 *
 * Deliberately wider than the set of sides CLASS_RE knows, and deliberately
 * wider than the `\d+px` shape CLASS_RE maps: CLASS_RE is the single
 * authority on which side/corner suffix is valid Tailwind and which bracket
 * contents this scale expresses, and anything it declines -- a percentage,
 * a CSS variable, `inherit`, a unit other than px -- has to reach the
 * refusal list rather than be filtered out here and vanish. An earlier,
 * narrower version of this regex matched only `\[\d+px\]` and so never even
 * saw `rounded-[50%]` or `rounded-[inherit]` to refuse them -- the same bug
 * class that hit codemod-surfaces.mjs's TARGET_RE/CLASS_RE split twice.
 */
const TARGET_RE = /(?:[a-z0-9-]+:)*rounded(?:-[a-z]+)?-\[[^\]]+\]/g

/**
 * Read-only counterpart to main(): every arbitrary radius class TARGET_RE
 * finds, mapped or not, without rewriting anything. main() does not call
 * this -- it drives the replace itself -- but a future audit script or the
 * ESLint rule promised above can call it to list what a file contains
 * without mutating it. Covered directly in the test file so the widened
 * TARGET_RE stays exercised even though main() never touches it.
 */
export function findRadiusClasses(source) {
  return source.match(TARGET_RE) ?? []
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full)
  }
  return out
}

function main() {
  const unmapped = new Map()
  let changedFiles = 0
  let changedClasses = 0

  for (const file of walk(join(REPO_ROOT, 'src'))) {
    const before = readFileSync(file, 'utf8')
    const after = before.replace(TARGET_RE, (cls) => {
      const mapped = mapRadiusClass(cls)
      if (mapped === null) {
        unmapped.set(cls, (unmapped.get(cls) ?? 0) + 1)
        return cls
      }
      changedClasses += 1
      return mapped
    })
    if (after !== before) {
      writeFileSync(file, after)
      changedFiles += 1
    }
  }

  console.log(`rewrote ${changedClasses} classes across ${changedFiles} files`)
  if (unmapped.size > 0) {
    console.log('\nleft for manual review (paste into the commit message):')
    for (const [cls, n] of [...unmapped].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n}\t${cls}`)
    }
  }
}

if (process.argv[1]?.endsWith('codemod-radius.mjs')) main()
