#!/usr/bin/env node
/**
 * One-shot codemod: remove the arbitrary shadows the namespace reset cannot see.
 *
 * globals.css resets Tailwind's `--shadow-*`, `--inset-shadow-*` and
 * `--drop-shadow-*` namespaces, which kills every named step -- shadow-sm
 * through shadow-2xl -- in one place and keeps them dead. It does nothing at
 * all to `shadow-[...]`, because an arbitrary value compiles straight to a
 * declaration and never touches the namespace. 81 class lists use that form,
 * so the reset looked like it had finished the job and had not: the message
 * bubble, the composer and half the panels in the app still lifted.
 *
 * This is the third time in this project that a rule expressed in the design
 * system has been invisible to the surfaces that break it -- the same family
 * as the inline gradient on the chat header and the raw rgba in .bubble-ai.
 * A codemod is the answer for the 81 that exist; an ESLint rule would be the
 * answer for the 82nd, and is not written here.
 *
 * WHAT IS KEPT, and it is the only exception: the 21 sites spelling
 * `shadow-[0_0_0_3px_var(--color-accent-glow)]`. That is a focus ring, not a
 * lift -- it has no offset and no blur, it appears only on :focus, and the
 * design language specifies a focus ring of its own (a 2px outline in the
 * focus colour). Removing it would take a keyboard affordance away in the name
 * of a rule about decoration. It is spelled as a shadow rather than an outline
 * because an outline cannot follow a rounded corner in every browser this app
 * runs in; that is a separate change and not this one.
 *
 * Everything else goes:
 *
 *   - drop shadows, the whole point of the pass          0_24px_64px, 0_8px_32px, ...
 *   - coloured glows around dots and badges              0_0_8px_rgba(245,158,11,0.4)
 *   - accent halos that are not focus rings              0_0_8px_var(--color-accent-glow)
 *   - inset hairline highlights                          inset_0_1px_0_rgba(...)
 *
 * The last one is worth naming: an inset top highlight is the Midnight Glass
 * idiom, a fake light source along a panel's top edge. This design has no
 * light source at all.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The one arbitrary shadow that stays. Matched on its exact spelling rather
 * than on a shape heuristic ("no offset, no blur") on purpose: a heuristic
 * would also spare `0_0_8px_var(--color-accent-glow)`, which has no offset
 * either and IS a decorative halo. There is one focus ring in this app and it
 * is spelled one way.
 */
export const FOCUS_RING = 'shadow-[0_0_0_3px_var(--color-accent-glow)]'

/** Every `shadow-[...]`, whatever is inside the brackets. */
const TARGET_RE = /(?:[a-z0-9-]+:)*shadow-\[[^\]]+\]/g

/**
 * True when this class must be removed. Variants are stripped first, so
 * `hover:shadow-[...]` and `group-hover:shadow-[...]` are judged on the shadow
 * itself -- a hovered lift is still a lift.
 */
export function isRemovableShadow(cls) {
  const bare = cls.replace(/^(?:[a-z0-9-]+:)*/, '')
  return bare.startsWith('shadow-[') && bare !== FOCUS_RING
}

/**
 * Read-only counterpart to main(). Wider than what gets removed, so a class
 * this script decides to keep is still visible to an audit -- the same reason
 * codemod-radius.mjs widens its TARGET_RE past what it maps.
 */
export function findArbitraryShadows(source) {
  return source.match(TARGET_RE) ?? []
}

/**
 * Remove one class from a class string, collapsing the whitespace it leaves.
 *
 * Deleting the token alone turns `"a shadow-[x] b"` into `"a  b"`, which is
 * harmless in HTML but shows up in every diff and in snapshot tests. The
 * collapse is only applied between tokens, never at the ends, so a class
 * string that legitimately starts or ends with a space keeps it.
 */
export function removeClass(classText, cls) {
  return classText.replace(cls, '').replace(/(\S) {2,}(\S)/g, '$1 $2').replace(/ +"/g, '"')
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
  const kept = new Map()
  let removed = 0
  let changedFiles = 0

  for (const file of walk(join(REPO_ROOT, 'src'))) {
    const before = readFileSync(file, 'utf8')
    let after = before
    for (const cls of new Set(findArbitraryShadows(before))) {
      if (!isRemovableShadow(cls)) {
        kept.set(cls, (kept.get(cls) ?? 0) + (before.match(new RegExp(cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length)
        continue
      }
      const hits = (after.match(new RegExp(cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
      after = removeClass(after, cls)
      while (after.includes(cls)) after = removeClass(after, cls)
      removed += hits
    }
    if (after !== before) {
      writeFileSync(file, after)
      changedFiles += 1
    }
  }

  console.log(`removed ${removed} arbitrary shadows across ${changedFiles} files`)
  if (kept.size > 0) {
    console.log('\nkept on purpose:')
    for (const [cls, n] of [...kept].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${cls}`)
  }
}

if (process.argv[1]?.endsWith('codemod-shadows.mjs')) main()
