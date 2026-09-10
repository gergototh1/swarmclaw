import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/*
 * A kódblokk követi a témát, és a kódrészlet nem accent.
 *
 * A blokk korábban mindkét témában sötét maradt, mert a highlight.js
 * github-dark-dimmed-del van betöltve. Ez viszont egyik olvashatatlan esetet
 * cserélte egy másikra: egy nyelv nélküli kódkerítésen nincs `hljs` osztály,
 * úgyhogy a világos téma majdnem fekete szövegszínét örökölte -- #1D1D1F-et
 * rajzolt #242426-ra.
 */
describe('code surface tokens', () => {
  const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
  const lightBlock = css.slice(css.indexOf('\n.light {'))

  it('gives the light theme its own code ground instead of the dark one', () => {
    assert.match(lightBlock, /--code-surface:\s*#F6F8FA/i)
  })

  it('keeps a dark code ground for the dark theme', () => {
    const rootBlock = css.slice(0, css.indexOf('\n.light {'))
    assert.match(rootBlock, /--code-surface:\s*#242426/i)
  })

  it('draws the block hairline from a token, not a hardcoded white alpha', () => {
    assert.match(css, /\.msg-content pre\s*\{[^}]*border:\s*1px solid var\(--code-border\)/m)
  })

  it('ships a light syntax palette, or the light ground would be unreadable', () => {
    // A github-dark-dimmed tokenszínei világos alapon elmennek olvashatatlanba.
    for (const cls of ['.light .hljs-keyword', '.light .hljs-string', '.light .hljs-comment']) {
      assert.ok(css.includes(cls), `missing light-theme override for ${cls}`)
    }
  })
})

/*
 * A szövegbe ágyazott kódrészlet nem az accent, és kisebb a prózánál.
 *
 * Korallul szedve egy hat fájlnevet tartalmazó mondat hat figyelmeztetésnek
 * olvasódott. A chip saját háttere jelöli, hogy kód -- a színnek nem kell.
 */
describe('inline code', () => {
  const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
  const rule = css.slice(css.indexOf('.msg-content :not(pre) > code'))
    .slice(0, css.slice(css.indexOf('.msg-content :not(pre) > code')).indexOf('}') + 1)

  it('is not painted in the accent', () => {
    assert.doesNotMatch(rule, /color:\s*var\(--color-accent-bright\)/)
  })

  it('reads as body text, one step down', () => {
    assert.match(rule, /color:\s*var\(--color-text-2\)/)
  })

  it('is smaller than the prose it sits in', () => {
    const size = rule.match(/font-size:\s*([0-9.]+)em/)
    assert.ok(size, 'inline code must set a relative font-size')
    assert.ok(Number(size[1]) < 0.85, `expected well under 1em, got ${size[1]}em`)
  })
})
