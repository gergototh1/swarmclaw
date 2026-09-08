#!/usr/bin/env node
/**
 * One-shot codemod: a surface is a step on the ladder, not a step at 70%.
 *
 * 127 class lists paint a surface token through a Tailwind opacity modifier,
 * across twelve distinct values -- /30 /45 /50 /55 /60 /65 /70 /72 /75 /80 /90
 * /95. Nobody chose twelve. They accumulated, and each one composites against
 * whatever happens to sit behind it, so two panels written with the same token
 * render as different colours depending on where they are on the page. That is
 * the largest single reason nothing in this app matched anything else.
 *
 * Same argument as codemod-text-dim.mjs, which removed the opacity modifiers
 * stacked on text tokens: the token already names a step, and multiplying it
 * by an arbitrary alpha is not a second step, it is an unnamed colour.
 *
 * WHAT IS KEPT: a surface paired with `backdrop-blur` in the same class list.
 * That is a frosted bar -- a sticky header or a floating toolbar deliberately
 * letting the content scroll behind it -- and the design language does specify
 * exactly that treatment for its two sticky surfaces. 28 sites qualify.
 *
 * The rule is co-occurrence rather than a list of components, because the two
 * are the same claim: `backdrop-blur` is what makes translucency mean
 * something. A translucent surface with no blur behind it is not frosted, it
 * is just a colour nobody can predict.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A className, in the three spellings this codebase uses. `cn('...')` matters:
 * a third of the app's class lists start there, and an earlier pass that only
 * matched the double-quoted form missed every one of them.
 */
const CLASS_RE = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cn\(\s*'([^']*)')/g

/** A surface token carrying an opacity modifier. */
const SURFACE_RE = /\bbg-(raised|surface|surface-2|surface-3|bg|layer-[0-4])\/\d+\b/g

/**
 * Whether this class list's translucency is deliberate.
 *
 * Exported so the test can pin the rule itself rather than only its output --
 * this is the single judgement call in the file.
 */
export function isFrosted(classText) {
  return classText.includes('backdrop-blur')
}

/**
 * Drop the opacity modifier from every surface token in one class list, unless
 * the list is frosted. Returns the input unchanged when there is nothing to do,
 * so the caller can compare and count.
 */
export function makeOpaque(classText) {
  if (isFrosted(classText)) return classText
  return classText.replace(SURFACE_RE, (_m, step) => `bg-${step}`)
}

/** Read-only: every surface-with-opacity this file contains, frosted or not. */
export function findTranslucentSurfaces(source) {
  return source.match(SURFACE_RE) ?? []
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.tsx')) out.push(full)
  }
  return out
}

function main() {
  let changedFiles = 0
  let flattened = 0
  const kept = new Map()

  for (const file of walk(join(REPO_ROOT, 'src'))) {
    const before = readFileSync(file, 'utf8')
    const after = before.replace(CLASS_RE, (raw, a, b, c) => {
      const body = a ?? b ?? c
      if (body === undefined) return raw
      if (isFrosted(body)) {
        for (const hit of body.match(SURFACE_RE) ?? []) kept.set(hit, (kept.get(hit) ?? 0) + 1)
        return raw
      }
      const next = makeOpaque(body)
      if (next === body) return raw
      flattened += (body.match(SURFACE_RE) ?? []).length
      return raw.replace(body, next)
    })
    if (after !== before) {
      writeFileSync(file, after)
      changedFiles += 1
    }
  }

  console.log(`made ${flattened} surfaces opaque across ${changedFiles} files`)
  if (kept.size > 0) {
    console.log('\nkept -- these sit behind a backdrop-blur and are frosted on purpose:')
    for (const [cls, n] of [...kept].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${cls}`)
  }
}

if (process.argv[1]?.endsWith('codemod-opaque-surfaces.mjs')) main()
