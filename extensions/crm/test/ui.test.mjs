import assert from 'node:assert/strict'
import test from 'node:test'

import { bundle } from '../scripts/build.mjs'

test('a bundle nem visz saját React-példányt', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.equal(js.includes('react-dom/client'), false)
  assert.match(js, /window\.swarmclaw/, 'a React a hoszt táblájából jön')
})

test('a bundle mind a három nézetet tartalmazza', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Ügyfelek', 'Ügyek', 'Elavult']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a kézi bevitel űrlapjait', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Új kapcsolat', 'Cím hozzáadása', 'Új ügy']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a besorolatlan hozzárendelő sorát', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Hozzárendel', 'Válassz kapcsolatot']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a találgatást feloldó "összes kapcsolat" jelölőnégyzetet', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.ok(js.includes('Összes kapcsolat'), 'hiányzik a bundle-ből: Összes kapcsolat')
})

test('a bundle tartalmazza a lapozast es a szoveg-megnyitast', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Korábbiak', 'Teljes szöveg']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a sopres gombjat', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.ok(js.includes('Levelek behúzása'), 'hiányzik a bundle-ből: Levelek behúzása')
})

test('a bundle tartalmazza a nem iktatott hozzarendeles jelzeset', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.ok(js.includes('még nincs ügyfele'), 'hiányzik a bundle-ből: a nem iktatott hozzárendelés üzenete')
})

test('a bundle megkulonbozteti a postafiok-hivas elhasalasanak ket okat', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of [
    'nincs beállítva Google OAuth kliens',
    'GOOGLE_OAUTH_CLIENT_DESKTOP_ID',
    'Hiányzik vagy lejárt a Gmail-hitelesítő',
    'A hívás üzenete',
  ]) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

/**
 * A 7. feladat: az ügyfél lapon a host `/api/tasks`-ából jövő feladatlista,
 * és a Ma nézeten a javaslat elfogadásának gombja.
 */
test('a bundle tartalmazza az ugyfelhez tartozo feladatlistat', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Feladatok', 'Ehhez az ügyfélhez még nincs feladat']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a javaslat elfogadasanak gombjat', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Elfogad', 'acceptSuggestion', 'Feladat létrehozva']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle a sopres-osszegzesben a kimeno levelet es a kihagyast is mutatja', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['recordedOut', 'skippedOut', 'kimenő idővonalra']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})
