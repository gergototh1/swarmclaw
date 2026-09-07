/**
 * Proves the hardcoded-style guard in eslint.config.mjs actually fires.
 *
 * Why through the ESLint API rather than by reading the config text: the two
 * patterns this guards against are invisible to every other gate. A Tailwind
 * class whose theme key does not exist is dropped silently -- no build error,
 * no lint error, no type error -- so a guard that is subtly mis-selectored
 * looks exactly like a guard that works. Linting real snippets measures what
 * runs.
 *
 * eslint.config.mjs exempts this file from the rule, because every fixture
 * below is by construction one of the patterns the rule bans.
 */
import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'
import { ESLint } from 'eslint'

let eslint: ESLint

before(() => {
  // One instance for the whole file: constructing it loads the full Next
  // flat config, which is by far the slowest part of this test.
  eslint = new ESLint({ cwd: process.cwd() })
})

/** Lint a snippet as if it were a component, so the flat config's `files` globs apply. */
async function lintTsx(source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, {
    filePath: 'src/components/shared/__lint_fixture__.tsx',
  })
  return result.messages.map((m) => m.message)
}

const surfaceComplaint = /surface ladder/i
const radiusComplaint = /radius scale/i

async function assertComplains(source: string, pattern: RegExp): Promise<void> {
  const messages = await lintTsx(source)
  assert.ok(
    messages.some((m) => pattern.test(m)),
    `expected a ${pattern.source} complaint for ${JSON.stringify(source)}, got: ${JSON.stringify(messages)}`,
  )
}

async function assertSilent(source: string): Promise<void> {
  const messages = await lintTsx(source)
  assert.equal(
    messages.some((m) => surfaceComplaint.test(m) || radiusComplaint.test(m)),
    false,
    `expected no style complaint for ${JSON.stringify(source)}, got: ${JSON.stringify(messages)}`,
  )
}

describe('hardcoded-style guard', () => {
  it('rejects a reintroduced white-alpha background', async () => {
    await assertComplains(`export const A = () => <div className="bg-white/[0.04]" />\n`, surfaceComplaint)
  })

  it('rejects the shorthand white-alpha form the surfaces codemod never saw', async () => {
    // scripts/codemod-surfaces.mjs only matched the bracket form, so every
    // `bg-white/10` in the tree survived it. The guard has to cover both or it
    // leaves open the spelling that is easier to type.
    await assertComplains(`export const A2 = () => <div className="bg-white/6" />\n`, surfaceComplaint)
    await assertComplains(`export const A3 = () => <div className="text-white/70" />\n`, surfaceComplaint)
  })

  it('rejects the directional line forms', async () => {
    await assertComplains(`export const A4 = () => <div className="border-t-white/[0.06]" />\n`, surfaceComplaint)
    await assertComplains(`export const A5 = () => <div className="divide-y-white/10" />\n`, surfaceComplaint)
  })

  it('rejects a reintroduced arbitrary radius', async () => {
    await assertComplains(`export const B = () => <div className="rounded-[14px]" />\n`, radiusComplaint)
  })

  it('rejects arbitrary radii in the other units and on a single corner', async () => {
    await assertComplains(`export const B2 = () => <div className="rounded-tl-[8px]" />\n`, radiusComplaint)
    await assertComplains(`export const B3 = () => <div className="rounded-[0.5rem]" />\n`, radiusComplaint)
  })

  it('rejects non-numeric arbitrary radii the narrower px|rem|em selector used to miss', async () => {
    // An earlier version of this selector required a numeric length with a
    // px/rem/em unit, so it never even saw these forms to refuse them -- the
    // same bug class codemod-radius.mjs's TARGET_RE comment warns against.
    await assertComplains(`export const B4 = () => <div className="rounded-[50%]" />\n`, radiusComplaint)
    await assertComplains(`export const B5 = () => <div className="rounded-[var(--x)]" />\n`, radiusComplaint)
    await assertComplains(`export const B6 = () => <div className="rounded-[2vh]" />\n`, radiusComplaint)
    await assertComplains(`export const B7 = () => <div className="rounded-[calc(1rem+2px)]" />\n`, radiusComplaint)
  })

  it('still leaves rounded-[inherit] alone even though the radius selector now catches every other bracket form', async () => {
    // The one keyword site that must survive: src/components/ui/scroll-area.tsx
    // takes its parent's corner via `rounded-[inherit]`, not a length at all.
    await assertSilent(`export const B8 = () => <div className="rounded-[inherit]" />\n`)
  })

  it('rejects a gradient-stop or shadow white-alpha, not just surface/text/line utilities', async () => {
    // via-white/20 and friends were reachable by the prefix list's absence
    // and tracked nowhere: three real via-white/20 shimmer sites existed with
    // no lint complaint and no baseline entry.
    await assertComplains(`export const F = () => <div className="via-white/20" />\n`, surfaceComplaint)
    await assertComplains(`export const F2 = () => <div className="from-white/[0.1]" />\n`, surfaceComplaint)
    await assertComplains(`export const F3 = () => <div className="shadow-white/10" />\n`, surfaceComplaint)
  })

  it('catches the same patterns inside a template literal', async () => {
    await assertComplains(
      'export const C = ({ on }: { on: boolean }) => <div className={`p-2 ${on ? "x" : ""} bg-white/[0.06]`} />\n',
      surfaceComplaint,
    )
    await assertComplains(
      'export const C2 = ({ on }: { on: boolean }) => <div className={`p-2 rounded-[14px] ${on ? "a" : "b"}`} />\n',
      radiusComplaint,
    )
  })

  it('catches a variant-prefixed occurrence', async () => {
    await assertComplains(`export const C3 = () => <div className="hover:bg-white/10" />\n`, surfaceComplaint)
  })

  it('leaves the token classes alone', async () => {
    await assertSilent(`export const D = () => <div className="bg-layer-2 rounded-md border-line-subtle" />\n`)
  })

  it('leaves opaque white and the named radius steps alone', async () => {
    // `bg-white` has no alpha channel to hardcode, and `rounded-[inherit]` is
    // how a primitive inherits its parent's corner (src/components/ui/scroll-area.tsx).
    // Flagging either would force a disable comment, which is worse than a
    // narrower rule.
    await assertSilent(
      `export const E = () => <div className="bg-white text-white border-white rounded-full rounded-[inherit]" />\n`,
    )
  })
})
