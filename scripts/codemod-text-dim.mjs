#!/usr/bin/env node
/**
 * One-shot codemod: 1,440 call sites stack a Tailwind opacity modifier on a
 * text token that already means "dimmed" -- 1,393 on `text-text-3` and 47 on
 * `text-text-2`. A tertiary colour multiplied by a further 40% is
 * double-dimming, and no token value rescues it: with --tx-3 at its designed
 * #646E80, `text-text-3` is 5.14:1 on a white card and `text-text-3/40` is
 * 1.73:1. The modifier, not the token, is what makes the label unreadable.
 *
 * Same shape as codemod-radius.mjs and codemod-surfaces.mjs: a pure exported
 * mapping function, and refuse-and-report rather than guess. What is new here
 * is that a class token is not enough to decide by itself. Three contexts make
 * a modifier a legitimate treatment rather than double-dimming:
 *
 *   1. a state variant on the token   -- `hover:text-text-3/60`
 *   2. a ternary or `&&` branch       -- `active ? 'text-accent' : 'text-text-3/60'`
 *   3. a state-variant sibling in the
 *      same class string              -- `text-text-3/40 group-hover:text-text-3/60`
 *
 * (3) is the one a `hover:`-prefix filter misses and the reason this script
 * classifies a whole class string at once: stripping the base of that pair
 * leaves a hover that dims instead of brightening, which is worse than what it
 * replaced. (2) needs the TypeScript AST -- a regex cannot see that a string
 * literal sits in a conditional's branch, and `cn()` puts class strings in
 * argument position where nothing textual marks them. So the walk parses each
 * file, asks the parent chain, and stops that question at the JsxAttribute:
 * above it a conditional governs whether the element renders at all, which
 * says nothing about the class.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Repo root derived from this file, so the walk does not depend on the cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Variants after which an opacity modifier is a state treatment. Matched
 * against the variant with any `/name` group suffix removed, so
 * `group-hover/resume` is tested as `group-hover`.
 */
const STATE_VARIANT_RE =
  /^(?:(?:group|peer)-)?(?:hover|focus|focus-visible|focus-within|focus-visible-within|active|disabled|enabled|checked|unchecked|indeterminate|visited|target|open|closed|selected|expanded|current|read-only|read-write|required|optional|valid|invalid|in-range|out-of-range|placeholder-shown|autofill|user-valid|user-invalid|has-checked)$/

/** Attribute-driven state, e.g. `data-[state=open]:`, `aria-expanded:`. */
const STATE_ATTR_RE = /^(?:(?:group|peer)-)?(?:data|aria)-/

/**
 * Variants that are not state: a breakpoint, a colour scheme, a media query,
 * a structural position or a pseudo-element. An opacity modifier behind one of
 * these is the same double-dimming as a bare one, so it is stripped. The list
 * is exhaustive on purpose -- a variant that is on neither this list nor the
 * two state lists is refused and reported rather than assumed to be safe.
 */
const SAFE_VARIANTS = new Set([
  'sm', 'md', 'lg', 'xl', '2xl',
  'max-sm', 'max-md', 'max-lg', 'max-xl', 'max-2xl',
  'dark', 'light',
  'print', 'screen', 'portrait', 'landscape',
  'motion-safe', 'motion-reduce', 'contrast-more', 'contrast-less', 'forced-colors',
  'ltr', 'rtl',
  'first', 'last', 'only', 'odd', 'even', 'first-of-type', 'last-of-type', 'only-of-type',
  'empty',
  'placeholder', 'marker', 'selection', 'file', 'first-letter', 'first-line',
  'before', 'after',
])

/**
 * A whole Tailwind utility token: any run of characters that a class string
 * separates with whitespace. Deliberately wider than CLASS_RE, for the reason
 * codemod-radius.mjs records: CLASS_RE is the single authority on what this
 * codemod understands, and a token shape it does not understand has to reach
 * the refusal report rather than be filtered out here and vanish.
 */
const TOKEN_RE = /[^\s"'`{}\\]+/g

/** The utility half of a token, once its variants have been split off. */
const UTILITY_RE = /^text-text-([23])(?:\/(.+))?$/

/**
 * Split a Tailwind token into its variants and its utility, on colons at
 * bracket depth zero only. A naive `split(':')` breaks
 * `supports-[display:grid]:text-text-3/60` at the colon inside the brackets
 * and reports a variant named `supports-[display` -- a refusal with a reason
 * that names nothing real, which is the failure mode this whole script exists
 * to avoid.
 */
export function splitVariants(token) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i]
    if (ch === '[' || ch === '(') depth += 1
    else if (ch === ']' || ch === ')') depth -= 1
    else if (ch === ':' && depth === 0) {
      parts.push(token.slice(start, i))
      start = i + 1
    }
  }
  return { variants: parts, utility: token.slice(start) }
}

/** True when the token is one this codemod is responsible for at all. */
export function isDimToken(token) {
  return /text-text-[23]/.test(token)
}

/**
 * Classify one class token in the context of the class string and the syntax
 * around it. Pure: everything it needs is an argument.
 *
 * `context.conditional`          - the class string sits in a `?:` or `&&` branch
 * `context.siblingStateVariant`  - some other token in the same class string is a
 *                                  state-variant form of the same text token
 *
 * Returns `{ action: 'rewrite', to }` or `{ action: 'refuse', reason }`.
 */
export function mapDimClass(token, context = {}) {
  const { variants, utility } = splitVariants(token)
  const m = UTILITY_RE.exec(utility)
  if (!m) return { action: 'refuse', reason: 'unrecognized-token' }
  const [, step, modifier] = m
  if (modifier === undefined) return { action: 'refuse', reason: 'no-modifier' }
  if (!/^\d{1,3}$/.test(modifier)) return { action: 'refuse', reason: 'unrecognized-modifier' }

  for (const variant of variants) {
    const base = variant.replace(/\/[^:]*$/, '')
    if (STATE_VARIANT_RE.test(base) || STATE_ATTR_RE.test(base)) {
      return { action: 'refuse', reason: `state-variant:${base}` }
    }
    if (!SAFE_VARIANTS.has(base)) {
      return { action: 'refuse', reason: `unknown-variant:${base}` }
    }
  }

  if (context.siblingStateVariant) return { action: 'refuse', reason: 'paired-with-state-variant' }
  if (context.conditional) return { action: 'refuse', reason: 'conditional-context' }
  return { action: 'rewrite', to: [...variants, `text-text-${step}`].join(':') }
}

/**
 * Which text steps in a class string carry a state variant. Feeds
 * `context.siblingStateVariant` so a base/hover pair is refused as a pair:
 * `text-text-3/40 group-hover/resume:text-text-3/60` must keep both halves or
 * the hover ends up dimmer than the resting state.
 */
export function stateVariantSteps(classText) {
  const steps = new Set()
  for (const token of classText.match(TOKEN_RE) ?? []) {
    if (!isDimToken(token)) continue
    const { variants, utility } = splitVariants(token)
    const m = UTILITY_RE.exec(utility)
    if (!m) continue
    for (const variant of variants) {
      const base = variant.replace(/\/[^:]*$/, '')
      if (STATE_VARIANT_RE.test(base) || STATE_ATTR_RE.test(base)) steps.add(m[1])
    }
  }
  return steps
}

/**
 * Does this string literal sit in a branch that only some states take?
 *
 * The walk stops at a JsxAttribute: `cond ? <p className="text-text-3/60"/> :
 * null` puts the class inside a conditional, but the conditional decides
 * whether the paragraph exists, not how dim its label is. Below the attribute
 * -- `cn('a', on ? 'b' : 'text-text-3/60')`, a ternary inside a template
 * literal, a `&&` right-hand side -- the branch really is a state.
 */
export function inConditionalBranch(node) {
  let child = node
  let parent = node.parent
  while (parent) {
    if (ts.isJsxAttribute(parent)) return false
    if (ts.isConditionalExpression(parent) && (child === parent.whenTrue || child === parent.whenFalse)) return true
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
      child === parent.right
    ) {
      return true
    }
    child = parent
    parent = parent.parent
  }
  return false
}

/**
 * Plan one file without touching it. Returns the rewritten source plus every
 * decision, so main() can report and the test can assert on both halves.
 */
export function planSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits = []
  const refusals = []

  const scan = (textNode, contextNode) => {
    const start = textNode.getStart(sourceFile)
    const text = source.slice(start, textNode.getEnd())
    if (!isDimToken(text)) return
    const stateSteps = stateVariantSteps(text)
    const conditional = inConditionalBranch(contextNode)
    for (const match of text.matchAll(TOKEN_RE)) {
      const token = match[0]
      if (!isDimToken(token)) continue
      const step = UTILITY_RE.exec(splitVariants(token).utility)?.[1]
      const result = mapDimClass(token, {
        conditional,
        siblingStateVariant: step !== undefined && stateSteps.has(step),
      })
      if (result.action === 'rewrite') {
        edits.push({ start: start + match.index, end: start + match.index + token.length, to: result.to })
      } else if (result.reason !== 'no-modifier') {
        refusals.push({ token, reason: result.reason, line: sourceFile.getLineAndCharacterOfPosition(start + match.index).line + 1 })
      }
    }
  }

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) scan(node, node)
    else if (ts.isTemplateExpression(node)) {
      scan(node.head, node)
      for (const span of node.templateSpans) scan(span.literal, span.literal)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  let output = source
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.to + output.slice(edit.end)
  }
  return { output, edits, refusals }
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
  const refusalsByReason = new Map()
  let changedFiles = 0
  let changedClasses = 0

  for (const file of walk(join(REPO_ROOT, 'src'))) {
    const before = readFileSync(file, 'utf8')
    if (!isDimToken(before)) continue
    const { output, edits, refusals } = planSource(before, file)
    changedClasses += edits.length
    for (const refusal of refusals) {
      const key = refusal.reason
      if (!refusalsByReason.has(key)) refusalsByReason.set(key, [])
      refusalsByReason.get(key).push(`${file.slice(REPO_ROOT.length + 1)}:${refusal.line}\t${refusal.token}`)
    }
    if (output !== before) {
      writeFileSync(file, output)
      changedFiles += 1
    }
  }

  console.log(`stripped ${changedClasses} modifiers across ${changedFiles} files`)
  const total = [...refusalsByReason.values()].reduce((n, list) => n + list.length, 0)
  if (total > 0) {
    console.log(`\nrefused ${total} sites (paste into the commit message):`)
    for (const [reason, list] of [...refusalsByReason].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ${reason} (${list.length})`)
      for (const line of list) console.log(`    ${line}`)
    }
  }
}

if (process.argv[1]?.endsWith('codemod-text-dim.mjs')) main()
