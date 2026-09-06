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
