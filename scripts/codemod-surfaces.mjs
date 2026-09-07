#!/usr/bin/env node
/**
 * One-shot codemod: hardcoded white-alpha utilities to the semantic ladder.
 *
 * Runs once, is reviewed as a machine diff, and then the ESLint guard in
 * eslint.config.mjs keeps the patterns from coming back. Anything it cannot map
 * cleanly it refuses to touch and reports instead — a wrong guess here is a
 * silent visual regression across 200 files.
 *
 * The three scans below are deliberately separate. The first one rewrites; the
 * other two only report, because a silent miss is worse than a loud refusal:
 * every bug found in this script so far has been something it could not see
 * rather than something it mapped wrong.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root derived from this file, so the walk does not depend on the cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
/** Interaction variants whose collapse onto their own base class is invisible. */
const COLLAPSE_VARIANTS = ['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'group-hover']

const CLASS_RE = new RegExp(
  `^((?:[a-z0-9-]+:)*)([a-z]+)(-(?:${DIRECTIONS.join('|')}))?-white\\/\\[([0-9.]+)\\]$`
)

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

/**
 * Every `<anything>-white/[α]` in the text, whatever the utility prefix.
 *
 * Deliberately wider than the set of prefixes the mapper knows: the mapper is
 * the single authority on what can be rewritten, and a prefix it declines has
 * to reach the refusal list rather than be filtered out here and vanish.
 */
const TARGET_RE = /(?:[a-z0-9-]+:)*[a-z][a-z0-9-]*-white\/\[[0-9.]+\]/g

export function findWhiteAlphaClasses(source) {
  return source.match(TARGET_RE) ?? []
}

/**
 * Tailwind's ordinary opacity-modifier form — `border-white/10`, `text-white/70`.
 *
 * Never rewritten. Some of these mean literal white on purpose (white text on a
 * user-message bubble is white, not a foreground token), so the choice is per
 * site. Reported so the choice is at least visible.
 */
const SHORTHAND_RE = /(?:[a-z0-9-]+:)*[a-z][a-z0-9-]*-white\/[0-9]+(?![0-9.[])/g

export function findShorthandOpacityClasses(source) {
  return source.match(SHORTHAND_RE) ?? []
}

/**
 * Characters that may appear inside a Tailwind class. Everything else — quotes,
 * braces, parens, commas, `=` — ends the run, which is what keeps the two
 * branches of a ternary from being read as one class list.
 */
const CLASS_RUN_RE = /[A-Za-z0-9_:\-[\]/.\s]+/g

/**
 * Base/variant pairs that collapse onto the same token, e.g. `bg-layer-2` next
 * to `hover:bg-layer-2` — a hover state with no visible change.
 *
 * Classes are compared after mapping, so this finds the collapse both before
 * the rewrite (`bg-white/[0.04]` + `hover:bg-white/[0.06]`, same bucket) and
 * after it (two identical token classes). Reporting only: which side should
 * move is a design decision, not a derivable one.
 */
export function findCollapsedVariantPairs(source) {
  const pairs = []
  for (const run of source.matchAll(CLASS_RUN_RE)) {
    const tokens = run[0].split(/\s+/).filter(Boolean)
    if (tokens.length < 2) continue
    const bases = new Map()
    for (const token of tokens) {
      if (token.includes(':')) continue
      bases.set(mapWhiteAlphaClass(token) ?? token, token)
    }
    for (const token of tokens) {
      const parts = token.split(':')
      if (parts.length !== 2 || !COLLAPSE_VARIANTS.includes(parts[0])) continue
      const resolved = mapWhiteAlphaClass(parts[1]) ?? parts[1]
      if (!bases.has(resolved)) continue
      pairs.push({
        base: bases.get(resolved),
        variant: token,
        token: resolved,
        line: source.slice(0, run.index).split('\n').length,
      })
    }
  }
  return pairs
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

function tally(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function printTally(heading, map) {
  if (map.size === 0) return
  console.log(`\n${heading}`)
  for (const [key, n] of [...map].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${key}`)
}

function main() {
  const unmapped = new Map()
  const shorthand = new Map()
  const collapsed = []
  let changedFiles = 0
  let changedClasses = 0

  for (const file of walk(join(REPO_ROOT, 'src'))) {
    const before = readFileSync(file, 'utf8')
    const after = before.replace(TARGET_RE, (cls) => {
      const mapped = mapWhiteAlphaClass(cls)
      if (mapped === null) {
        tally(unmapped, cls)
        return cls
      }
      changedClasses += 1
      return mapped
    })
    if (after !== before) {
      writeFileSync(file, after)
      changedFiles += 1
    }
    for (const cls of findShorthandOpacityClasses(after)) tally(shorthand, cls)
    for (const pair of findCollapsedVariantPairs(after)) {
      collapsed.push({ ...pair, file: relative(REPO_ROOT, file) })
    }
  }

  console.log(`rewrote ${changedClasses} classes across ${changedFiles} files`)
  printTally('left for manual review (paste into the commit message):', unmapped)
  printTally('not scanned — shorthand opacity form, decide per site:', shorthand)

  if (collapsed.length > 0) {
    console.log('\nbase/variant collapse — the variant repaints nothing, decide per site:')
    for (const { file, line, base, variant } of collapsed) {
      console.log(`  ${file}:${line}\t${base} + ${variant}`)
    }
  }
}

if (process.argv[1]?.endsWith('codemod-surfaces.mjs')) main()
