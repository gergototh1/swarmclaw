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
    const urls = [...css.matchAll(/@font-face\s*\{[^}]*src:\s*url\('([^']+)'\)/g)].map((m) => m[1])
    assert.ok(urls.length > 0, 'nincs @font-face a logó betűjéhez')
    for (const url of urls) {
      assert.ok(fs.existsSync(path.join(ROOT, 'public', url)), `hiányzik a fájl: public${url}`)
    }
    // Helyből szolgáljuk ki: egy futásidejű Google-kérés offline elejtené a
    // márkanevet, és minden indításnál kifelé szólna.
    assert.ok(!/@font-face[\s\S]{0,400}fonts\.gstatic\.com/.test(css), 'a logó betűje külső hosztról jön')
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

  it('draws the mark, and does not fall back to a letter', () => {
    // A jel egy rajz. Egy betű a helyén -- "S" a korall négyzetben -- pont
    // annyira néz ki késznek, hogy senkinek ne tűnjön fel, hogy elveszett.
    const src = fs.readFileSync(path.join(ROOT, 'src/components/layout/brand-logo.tsx'), 'utf8')
    const mark = src.slice(src.indexOf('export function BrandGlyph'), src.indexOf('export function BrandMark'))
    assert.match(mark, /<path\b/, 'a jel nem rajz')
    // A lyukak a kitöltési szabályból jönnek, nem maszkból. Egy maszk `id`-t
    // kérne, egy `id` pedig egy dokumentumban egyszer élhet -- a railen és a
    // fejlécben egyszerre kirajzolt jel közül a második üresen maradna, és ez
    // futásidőben derülne ki, nem itt.
    assert.match(mark, /fillRule="evenodd"/, 'a jel nem evenodd-dal vágja ki a lyukakat')
    assert.ok(!/\bid=/.test(mark), 'a jelben `id` van: több példány esetén elszáll')
    assert.ok(mark.length > 800, 'a jel path-ja gyanúsan rövid -- kiürült?')
    assert.match(src, /viewBox="0 0 24 24"/, 'a jel nem a 24-es rácson ül')
  })

  it('is what the rail draws, in both of its widths', () => {
    const rail = fs.readFileSync(path.join(ROOT, 'src/components/layout/sidebar-rail.tsx'), 'utf8')
    assert.match(rail, /BrandLockup/, 'a nyitott rail nem a jelet és a nevet rajzolja')
    assert.match(rail, /BrandMark size=\{40\}/, 'a csukott rail nem a jelet rajzolja')
  })

  it('puts the mark before the name wherever the name is spelled out', () => {
    // Két hely írja ki a nevet: a nyitott rail és a kezdőlap címe. Mindkettő
    // a lockupot rajzolja, nem a csupasz szóvédjegyet -- különben a jel csak
    // csukott railen létezne, és a márka fele eltűnne, amint valaki kinyitja.
    for (const f of ['src/components/layout/sidebar-rail.tsx', 'src/app/home/page.tsx']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      assert.match(src, /<BrandLockup\b/, `${f} nem a lockupot rajzolja`)
      assert.ok(!/<BrandWordmark\b/.test(src), `${f} még a csupasz szóvédjegyet rajzolja`)
    }
  })

  it('ships an app icon and a favicon drawn from the same mark', () => {
    // Az ikonokat a scripts/build-brand-icons.py generálja a komponens path-jából.
    // Ha a jel változik és az ikon nem, az sehol nem hibázik -- csak a Dockban
    // marad a régi rajz, amit a fejlesztés közben senki nem néz.
    const glyph = fs.readFileSync(path.join(ROOT, 'src/components/layout/brand-logo.tsx'), 'utf8')
    const d = /d="(M[^"]{40})/.exec(glyph)?.[1]
    assert.ok(d, 'nem találom a jel path-ját')
    const favicon = fs.readFileSync(path.join(ROOT, 'src/app/icon.svg'), 'utf8')
    assert.ok(favicon.includes(d), 'a favicon nem ugyanazt a jelet rajzolja')
    for (const f of ['resources/icon.png', 'resources/icon.icns', 'resources/icon.ico',
                     'public/brand/sidekick-avatar.png']) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `hiányzik: ${f}`)
    }
  })

  it('keeps the data directory where it already is, despite the rename', () => {
    // A `productName` hajtja az `app.getPath('userData')`-t; átnevezés után a
    // csomagolt build új könyvtárban keresné az otthonát, és üresen indulna.
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8')
    assert.match(main, /app\.setPath\('userData'/, 'nincs rögzítve a userData útvonal')
    assert.match(main, /@swarmclawai\/swarmclaw/, 'nem a meglévő könyvtárra mutat')
  })
})
