import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ABSTRACT_MAX_CHARS, generateAbstract, summarizeWithoutModel } from './memory-abstract'

// ---------------------------------------------------------------------------
// Short content guard
// ---------------------------------------------------------------------------

describe('generateAbstract', () => {
  it('returns null for content <= 200 chars', async () => {
    const short = 'A'.repeat(200)
    assert.equal(await generateAbstract(short, 'title'), null)
  })

  it('returns null for empty content', async () => {
    assert.equal(await generateAbstract('', 'title'), null)
  })

  it('returns null for content exactly 200 chars', async () => {
    assert.equal(await generateAbstract('x'.repeat(200)), null)
  })

  // ---------------------------------------------------------------------------
  // Fallback abstract
  // ---------------------------------------------------------------------------

  it('returns fallback (truncated prefix) when LLM import fails', async () => {
    // generateAbstract uses dynamic import('@/lib/server/build-llm')
    // In a test environment without the full server, the import will fail
    // and the catch block returns fallbackAbstract
    const longContent = 'B'.repeat(250)
    const result = await generateAbstract(longContent, 'title')
    // Fallback: first 150 chars + '...'
    assert.ok(result !== null)
    assert.equal(result, 'B'.repeat(ABSTRACT_MAX_CHARS) + '...')
  })

  it('returns content untouched when it already fits the abstract budget', async () => {
    // Only content over 200 chars reaches the fallback at all, but the budget
    // is wider than that, so a 201-char note is a summary of itself — cutting
    // it would lose information for no gain.
    const content = 'C'.repeat(201)
    const result = await generateAbstract(content, 'title')
    assert.equal(result, content)
  })

  it('adds no ellipsis to content that was never truncated', async () => {
    const content = 'D'.repeat(201)
    const result = await generateAbstract(content)
    assert.ok(result !== null)
    assert.ok(!result!.endsWith('...'), result!)
  })
})

// ---------------------------------------------------------------------------
// Model-free summarizing
//
// Without a generation model the abstract used to be content.slice(0, 150) --
// a cut that lands mid-word and mid-sentence. These cover the shape a reader
// actually gets in a recall bullet.
// ---------------------------------------------------------------------------

describe('summarizeWithoutModel', () => {
  it('stops at a sentence boundary instead of mid-word', () => {
    const content = 'A YouTube OAuth token lejárt. Újra kell hitelesíteni a konzolon. '
      + 'Ez a harmadik alkalom ebben a hónapban, és minden egyes alkalommal ugyanaz a hiba jön elő.'
    const out = summarizeWithoutModel(content)
    assert.ok(out.endsWith('.'), out)
    assert.ok(!out.endsWith('...'), out)
    assert.ok(out.startsWith('A YouTube OAuth token lejárt.'), out)
  })

  it('keeps accented characters intact', () => {
    const content = 'A határidő péntekre csúszott, mert az ügyfél késett a visszajelzéssel. '
      + 'Emiatt az egész ütemterv eltolódik egy héttel, és ezt jelezni kell a csapatnak is időben.'
    const out = summarizeWithoutModel(content)
    assert.ok(out.includes('határidő'), out)
    assert.ok(out.includes('ügyfél'), out)
  })

  it('uses the first line when the content is a structured note', () => {
    const content = 'DÖNTÉS: videó stratégia 70/30 screen vs motion\n'
      + 'Indoklás: a screen recording olcsóbb és gyorsabb.\n'
      + 'Felülvizsgálat: 2026 Q4.'
    const out = summarizeWithoutModel(content)
    assert.equal(out, 'DÖNTÉS: videó stratégia 70/30 screen vs motion')
  })

  it('falls back to a word boundary when there is no sentence end', () => {
    const content = 'alpha bravo charlie delta echo foxtrot '.repeat(20)
    const out = summarizeWithoutModel(content)
    assert.ok(out.length <= ABSTRACT_MAX_CHARS + 3, `too long: ${out.length}`)
    assert.ok(out.endsWith('...'), out)
    assert.ok(!/\s\.\.\.$/.test(out), `dangling space before ellipsis: ${out}`)
  })

  it('returns short content unchanged', () => {
    assert.equal(summarizeWithoutModel('Rövid tény.'), 'Rövid tény.')
  })

  it('collapses whitespace so the result is one line', () => {
    const out = summarizeWithoutModel('Első   sor\n\nmásodik   sor, ugyanabban a mondatban folytatva.')
    assert.ok(!out.includes('\n'), out)
    assert.ok(!out.includes('  '), out)
  })
})
