import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')

/**
 * A szóvédjegy három darabból áll, és mindhárom külön fájlban -- a font, a
 * `@font-face`, és a komponens. Bármelyik hiánya némán a display-betűre ejti
 * vissza a logót, ami majdnem jól néz ki, tehát nem tűnik fel.
 */
describe('SidekickOS wordmark', () => {
  it('ships the font file the @font-face points at', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8')
    const match = css.match(/@font-face\s*\{[^}]*src:\s*url\('([^']+)'\)/)
    assert.ok(match, 'nincs @font-face a logó betűjéhez')
    const url = match[1]
    assert.ok(fs.existsSync(path.join(ROOT, 'public', url)), `hiányzik a fájl: public${url}`)
  })

  it('declares the font BEFORE any use, and after the imports', () => {
    // A CSS az `@import`-ot csak a fájl elején fogadja el; a `@font-face`
    // eléjük téve az egész import-blokkot érvényteleníti.
    const css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8')
    assert.ok(css.indexOf('@import') < css.indexOf('@font-face'), 'a @font-face megelőzi az @import-ot')
    assert.match(css, /--font-logo:/, 'nincs --font-logo token')
  })

  it('renders the two halves in the two colours the brand asks for', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/components/layout/brand-logo.tsx'), 'utf8')
    assert.match(src, /text-text[^-][\s\S]*?Sidekick/, '"Sidekick" nem a szövegszínen áll')
    assert.match(src, /text-accent-bright[\s\S]*?OS/, '"OS" nem az accenten áll')
    assert.match(src, /var\(--font-logo\)/, 'nem a logó-tokent használja')
  })

  it('is what the rail draws, in both of its widths', () => {
    const rail = fs.readFileSync(path.join(ROOT, 'src/components/layout/sidebar-rail.tsx'), 'utf8')
    assert.match(rail, /BrandWordmark/, 'a nyitott rail nem a szóvédjegyet rajzolja')
    assert.match(rail, /BrandMark/, 'a csukott rail nem a jelet rajzolja')
  })

  it('keeps the data directory where it already is, despite the rename', () => {
    // A `productName` hajtja az `app.getPath('userData')`-t; átnevezés után a
    // csomagolt build új könyvtárban keresné az otthonát, és üresen indulna.
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8')
    assert.match(main, /app\.setPath\('userData'/, 'nincs rögzítve a userData útvonal')
    assert.match(main, /@swarmclawai\/swarmclaw/, 'nem a meglévő könyvtárra mutat')
  })
})
