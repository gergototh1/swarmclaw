import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * A stíluslap szerződése (spec 2. és 7.).
 *
 * A `scripts/build.mjs` a `ui/style.css`-t SIMA MÁSOLÁSSAL viszi
 * `dist/style.css`-be -- nincs feldolgozás --, ezért a forrást olvassuk,
 * buildelés nélkül. Ha a build egyszer feldolgozni kezdi, ezt a tesztet a
 * kimenetre kell átállítani, különben olyasmit igazol, ami nem kerül ki.
 */
const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')

/** A szabályok választói, at-szabály-preludiumok nélkül. */
function valasztok() {
  return [...css.matchAll(/(?:^|[};])\s*([^{};@]+?)\s*\{/g)]
    .map((m) => m[1].trim())
    .filter((s) => s.length > 0)
    .flatMap((s) => s.split(',').map((x) => x.trim()))
}

test('a stiluslap nem tolt be betutipust', () => {
  assert.equal(
    /@font-face|@import|fonts\.googleapis|fonts\.gstatic/.test(css), false,
    'a hoszt mar betoltotte a betuket; a --font-* tokeneket kell olvasni',
  )
})

test('minden valaszto crm- prefixet visel', () => {
  const rosszak = valasztok().filter((s) => !s.includes('.crm-'))
  assert.deepEqual(rosszak, [], 'prefix nelkuli szabaly a hoszt shelljet is atstilusozna')
})

test('minden szin tokenbol jon, fallbackkel', () => {
  // A var(--token, fallback) hivasokat kivagjuk; ami hexa marad, az nyers.
  const maradek = css.replace(/var\(\s*--[a-z0-9-]+\s*(?:,[^;]*?)?\)/g, 'VAR')
  const nyers = [...maradek.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  assert.deepEqual(nyers, [], 'nyers szin csak var() fallback-pozicioban allhat')
})

test('minden var() hivas visz fallbacket', () => {
  const fallbackNelkul = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => m[1])
  assert.deepEqual(fallbackNelkul, [], 'egy atnevezett token nelkul a lap olvashatatlan lenne')
})
