import assert from 'node:assert/strict'
import test from 'node:test'

import { HOST_MODULES, bundle } from '../scripts/build.mjs'

/**
 * What the built page must be true of, pinned.
 *
 * The React rule is the one that would otherwise fail late and confusingly: a
 * second copy of React in this bundle makes every hook in the page throw, at
 * runtime, inside the host's tree, with a message about hook order rather than
 * about bundling.
 */

let built = null
async function output() {
  if (!built) {
    const result = await bundle({ write: false, minify: true })
    built = result.outputFiles[0].text
  }
  return built
}

test('the bundle carries no React source, only lookups into the host table', async () => {
  const code = await output()
  assert.ok(code.includes('window.swarmclaw'), 'nem a host tábláját olvassa')
  // A React fejlesztői figyelmeztetései és a reconciler jellegzetes szövegei.
  for (const jel of ['react.production', 'react.development', 'Invalid hook call', '__SECRET_INTERNALS']) {
    assert.ok(!code.includes(jel), `React forrás került a bundle-be: ${jel}`)
  }
})

test('react comes from the host table, and every host module is on the list', async () => {
  const code = await output()
  // Csak azt lehet állítani, hogy amit a bundle IMPORTÁL a három közül, az a
  // táblán át jön. A react-dom-ot például ez a lap nem importálja, tehát nem is
  // szerepel benne -- az nem hiba, csak annyi, hogy nincs rá szükség.
  //
  // A minifier a `modules["react"]` indexelést `modules.react` tulajdonság-
  // olvasásra írja át, ezért mindkét alak elfogadható; a lényeg, hogy a react
  // a host tábláján keresztül érkezzen.
  assert.match(code, /modules(\.react\b|\["react"\]|\['react'\])/, 'a react nem a host táblájából jön')
  assert.ok(HOST_MODULES.includes('react'))
  assert.ok(HOST_MODULES.includes('react-dom'))
  assert.ok(HOST_MODULES.includes('react/jsx-runtime'))
})

test('the page registers itself under the id the host expects', async () => {
  const code = await output()
  assert.ok(code.includes('registerPage'), 'nem hívja a registerPage-et')
  assert.ok(code.includes('"docs"') || code.includes("'docs'"), 'nem a docs lapot regisztrálja')
})

test('the bundle stays under a size the page can justify', async () => {
  const code = await output()
  const kb = Buffer.byteLength(code) / 1024
  // TipTap és a ProseMirror a nagy tétel, és a host nem publikál belőlük
  // példányt. A plafon nem esztétika: e fölött érdemesebb a szerkesztőt
  // lecserélni, mint tovább növelni.
  assert.ok(kb < 700, `túl nagy lett a bundle: ${Math.round(kb)} kB`)
})
