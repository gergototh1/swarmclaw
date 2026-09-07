#!/usr/bin/env node
/**
 * One-shot codemod: hardcoded white-alpha utilities to the semantic ladder.
 *
 * Runs once, is reviewed as a machine diff, and then the ESLint guard in
 * eslint.config.mjs keeps the patterns from coming back. Anything it cannot map
 * cleanly it refuses to touch and reports instead — a wrong guess here is a
 * silent visual regression across 200 files.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * [upper bound (inclusive), token suffix] — first matching bound wins.
 *
 * Named `layer-*` rather than `surface-*` because globals.css already defines
 * --color-surface-2 and --color-surface-3 as opaque tinted surfaces, and every
 * existing `bg-surface-2` in the app means that. Reusing those names would
 * silently repaint components this codemod never touched.
 */
const SURFACE_STEPS = [[0.03, 'layer-1'], [0.06, 'layer-2'], [0.12, 'layer-3'], [1, 'layer-4']]
const LINE_STEPS = [[0.06, 'line-subtle'], [0.12, 'line-default'], [1, 'line-strong']]

/** Utility prefixes that take a surface token. */
const SURFACE_PREFIXES = ['bg']
/** Utility prefixes that take a line token. */
const LINE_PREFIXES = ['border', 'divide', 'ring', 'outline']
/** Directional suffixes the line-ladder prefixes may carry (`border-t-`, `divide-x-`, ...). */
const DIRECTIONS = ['t', 'b', 'l', 'r', 'x', 'y', 's', 'e']

const CLASS_RE = /^((?:[a-z0-9-]+:)*)([a-z]+)(-[tblrxyse])?-white\/\[([0-9.]+)\]$/

function step(steps, alpha) {
  for (const [bound, token] of steps) if (alpha <= bound) return token
  return null
}

/**
 * Map one Tailwind class to its token equivalent, or null when it cannot be
 * mapped without guessing. Variant prefixes (`hover:`, `dark:md:`) are carried
 * through untouched.
 */
export function mapWhiteAlphaClass(cls) {
  const m = CLASS_RE.exec(cls)
  if (!m) return null
  const [, variants, prefix, direction, alphaRaw] = m
  const alpha = Number(alphaRaw)
  if (!Number.isFinite(alpha) || alpha <= 0) return null

  // Only the line-ladder prefixes take a directional form. `bg-t-` etc. isn't
  // a Tailwind utility, so refuse rather than guess.
  if (direction && !LINE_PREFIXES.includes(prefix)) return null

  if (SURFACE_PREFIXES.includes(prefix)) {
    // Above 0.13 a background is an overlay, not a surface. The ladder tops out
    // at layer-4; anything past 0.25 is a scrim and stays for manual review.
    if (alpha > 0.25) return null
    return `${variants}bg-${step(SURFACE_STEPS, alpha)}`
  }
  if (LINE_PREFIXES.includes(prefix)) {
    if (alpha > 0.3) return null
    return `${variants}${prefix}${direction ?? ''}-${step(LINE_STEPS, alpha)}`
  }
  if (prefix === 'text') {
    if (alpha >= 0.8) return `${variants}text-fg-1`
    if (alpha >= 0.5) return `${variants}text-fg-2`
    return `${variants}text-fg-3`
  }
  return null
}

const TARGET_RE = new RegExp(
  `(?:[a-z0-9-]+:)*(?:bg|(?:border|divide|ring|outline)(?:-(?:${DIRECTIONS.join('|')}))?|text)-white/\\[[0-9.]+\\]`,
  'g'
)

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

  for (const file of walk('src')) {
    const before = readFileSync(file, 'utf8')
    const after = before.replace(TARGET_RE, (cls) => {
      const mapped = mapWhiteAlphaClass(cls)
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
    for (const [cls, n] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${cls}`)
  }
}

if (process.argv[1]?.endsWith('codemod-surfaces.mjs')) main()
