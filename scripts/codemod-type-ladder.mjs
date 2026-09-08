#!/usr/bin/env node
/**
 * One-shot codemod: put the type onto Apple's ladder.
 *
 * Two rules, both mechanical, both about the same thing -- the app was set in
 * a technical-console idiom and the design language it now follows does not
 * have that idiom.
 *
 * RULE 1, weight. Apple's ladder is 300 / 400 / 600 / 700 and 500 is
 * deliberately absent: a mid-weight reading is always 600. 124 class lists ask
 * for `font-500` and 71 for `font-800`, and neither step exists on the ladder.
 * 500 goes UP to 600 rather than down to 400, because every one of those sites
 * is asking for emphasis and 400 would remove it. 800 goes DOWN to 700, which
 * is the top of the ladder.
 *
 * RULE 2, tracking on uppercase micro-labels. 614 class lists set a wide
 * positive tracking -- 0.08em, 0.1em, 0.12em and Tailwind's own `wider`
 * (0.05em) -- almost always on a 10-12px uppercase label. Wide-tracked
 * uppercase is the single loudest signal of the console idiom, and Apple's
 * specification has no such treatment anywhere: its one positive-tracked token
 * is a 21px sentence-case tagline at +0.011em.
 *
 * They do NOT go to zero, and that is the one judgement call in this file.
 * Uppercase at 10px with no tracking is genuinely harder to read than lowercase
 * -- the letterforms are all the same height and the word shape that normally
 * carries recognition is gone. Apple's answer to that is to not set micro-labels
 * in uppercase at all, which is a content change across 614 sites and a
 * different piece of work. So the tracking drops to 0.03em: enough to keep
 * uppercase legible, far too little to read as the deliberate wide-tracked
 * treatment it currently is.
 *
 * Same shape as codemod-radius.mjs, codemod-surfaces.mjs and
 * codemod-text-dim.mjs: pure exported mapping functions, and refuse-and-report
 * rather than guess.
 *
 * What is deliberately NOT here: the sizes. The app runs 3,873 explicit sizes
 * dominated by 10-13px, and Apple's ladder floors at 12 with a 17px body.
 * Moving those changes the height of every row, table and panel in the app,
 * which is a layout change rather than a typographic one, and it is held for a
 * pass that can be looked at surface by surface.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The two weights that are not on the ladder, and the step each lands on. */
const WEIGHT_MAP = new Map([
  ['500', '600'],
  ['800', '700'],
])

/**
 * The tracking values this rule rewrites, and what they become.
 *
 * Keyed by the *bracket contents* or the bare Tailwind name, so `tracking-wider`
 * and `tracking-[0.05em]` -- which compile to the same 0.05em -- are both
 * caught. Anything wider than 0.05em is the console treatment; `wide` (0.025em)
 * is already at the target and is left alone rather than churned.
 */
const TRACKING_MAP = new Map([
  ['0.05em', '0.03em'],
  ['0.06em', '0.03em'],
  ['0.08em', '0.03em'],
  ['0.1em', '0.03em'],
  ['0.10em', '0.03em'],
  ['0.12em', '0.03em'],
  ['0.14em', '0.03em'],
  ['0.15em', '0.03em'],
  ['0.16em', '0.03em'],
  ['0.18em', '0.03em'],
  ['wider', '0.03em'],
  ['widest', '0.03em'],
])

/*
 * The five values from 0.05 to 0.18 above were NOT in the first run's map. The
 * script refused them and printed them, which is the whole reason it refuses
 * rather than guesses -- a codemod that had quietly rounded an unknown value to
 * the nearest step would have rewritten them without anyone deciding to, and a
 * codemod that had silently skipped them would have left forty wide-tracked
 * labels behind for nobody to find. They are here on a second pass because the
 * refusal list is what put them in front of a person.
 */

const WEIGHT_RE = /(?:[a-z0-9-]+:)*font-(\d00)\b/g
/*
 * The \b sits inside the bare-name branch, not after the alternation. A word
 * boundary needs a word character on one side, and `tracking-[0.08em]` ends on
 * `]` -- so a trailing \b matched nothing and the bracketed form, which is 583
 * of the 614 sites, was silently invisible to the whole script. The test caught
 * it; nothing about the codemod's own output would have.
 */
const TRACKING_RE = /(?:[a-z0-9-]+:)*tracking-(?:\[([^\]]+)\]|([a-z]+)\b)/g

/**
 * Map one `font-NNN` class, or null when the weight is already on the ladder.
 *
 * Variants are preserved verbatim -- `hover:font-500` is still a weight on the
 * wrong step and still has to move.
 */
export function mapWeightClass(cls) {
  WEIGHT_RE.lastIndex = 0
  const m = WEIGHT_RE.exec(cls)
  if (!m || m[0] !== cls) return null
  const target = WEIGHT_MAP.get(m[1])
  if (target === undefined) return null
  return cls.replace(`font-${m[1]}`, `font-${target}`)
}

/**
 * Map one `tracking-*` class, or null when it is not one of the wide steps.
 *
 * Returns null for negative tracking (which is the design language's own
 * signature and must survive untouched), for `normal`, `tight` and `tighter`,
 * and for any bracket content that is not in TRACKING_MAP -- an em value this
 * script has not been told about, or a px/rem unit, reaches the refusal list
 * rather than being silently rewritten to a value nobody chose.
 */
export function mapTrackingClass(cls) {
  TRACKING_RE.lastIndex = 0
  const m = TRACKING_RE.exec(cls)
  if (!m || m[0] !== cls) return null
  const key = m[1] ?? m[2]
  const target = TRACKING_MAP.get(key)
  if (target === undefined) return null
  const from = m[1] !== undefined ? `tracking-[${m[1]}]` : `tracking-${m[2]}`
  return cls.replace(from, `tracking-[${target}]`)
}

/**
 * Read-only counterpart to main(): every weight and tracking class the two
 * regexes find, mapped or not.
 *
 * Deliberately wider than what the maps rewrite, for the reason recorded in
 * codemod-radius.mjs: a class the maps decline has to reach the refusal list
 * rather than be filtered out here and vanish.
 */
export function findTypeClasses(source) {
  return [...(source.match(WEIGHT_RE) ?? []), ...(source.match(TRACKING_RE) ?? [])]
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
  const untouched = new Map()
  let changedFiles = 0
  let weights = 0
  let trackings = 0

  for (const file of walk(join(REPO_ROOT, 'src'))) {
    const before = readFileSync(file, 'utf8')
    let after = before.replace(WEIGHT_RE, (cls) => {
      const mapped = mapWeightClass(cls)
      if (mapped === null) {
        untouched.set(cls, (untouched.get(cls) ?? 0) + 1)
        return cls
      }
      weights += 1
      return mapped
    })
    after = after.replace(TRACKING_RE, (cls) => {
      const mapped = mapTrackingClass(cls)
      if (mapped === null) {
        untouched.set(cls, (untouched.get(cls) ?? 0) + 1)
        return cls
      }
      trackings += 1
      return mapped
    })
    if (after !== before) {
      writeFileSync(file, after)
      changedFiles += 1
    }
  }

  console.log(`rewrote ${weights} weights and ${trackings} trackings across ${changedFiles} files`)
  if (untouched.size > 0) {
    console.log('\nleft alone -- already on the ladder, or not a step this script knows:')
    for (const [cls, n] of [...untouched].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n}\t${cls}`)
    }
  }
}

if (process.argv[1]?.endsWith('codemod-type-ladder.mjs')) main()
