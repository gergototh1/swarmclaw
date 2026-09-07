import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ENTRY_RELATIV, UI_DIR_NEV, buildTerv } from '../scripts/build.mjs'

/**
 * The build script's skip guard, and the one shape of it that must NOT skip.
 *
 * An exit-0 skip keyed on one exact file path is a gate that can only ever
 * pass: rename the page's entry, or move it a directory deeper, and the build
 * goes on saying "no page yet", goes on exiting 0, and goes on writing
 * nothing -- while the page task's own gate goes green and the served page
 * 404s on both assets. From the host's side that is indistinguishable from a
 * broken install, so it has to be a hard failure, and the skip has to be
 * keyed on the absence of the whole `ui/` directory instead.
 */

function tempGyoker(build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-build-terv-'))
  try {
    build(dir)
    return buildTerv(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('nincs ui/ könyvtár: a lap még nem készült el, a build kihagyja', () => {
  const terv = tempGyoker(() => {})
  assert.equal(terv.teendo, 'kihagy')
  assert.match(terv.uzenet, /nincs ui\//)
})

test('van ui/, de nincs benne a belépő: HARD FAIL, nem csendes kihagyás', () => {
  // A lektor mutációja: a lap-feladat `ui/index.tsx`-nek nevezi a belépőt.
  const terv = tempGyoker((dir) => {
    fs.mkdirSync(path.join(dir, UI_DIR_NEV))
    fs.writeFileSync(path.join(dir, UI_DIR_NEV, 'index.tsx'), 'export {}\n')
  })
  assert.equal(terv.teendo, 'megall', 'egy rossz néven lévő belépő csendes kihagyást kapott')
  assert.match(terv.uzenet, new RegExp(ENTRY_RELATIV.replace('/', '\\/')))
})

test('van ui/, de a belépő egy könyvtárral lejjebb került: ez is HARD FAIL', () => {
  const terv = tempGyoker((dir) => {
    fs.mkdirSync(path.join(dir, UI_DIR_NEV, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, UI_DIR_NEV, 'src', 'main.tsx'), 'export {}\n')
  })
  assert.equal(terv.teendo, 'megall')
})

test('van ui/ és benne a belépő: buildel', () => {
  const terv = tempGyoker((dir) => {
    fs.mkdirSync(path.join(dir, UI_DIR_NEV))
    fs.writeFileSync(path.join(dir, ENTRY_RELATIV), 'export {}\n')
  })
  assert.equal(terv.teendo, 'buildel')
  assert.equal(terv.uzenet, null)
})

test('a modul mai állapota a buildelő ág: Task 6 óta van ui/ könyvtár és belépő', () => {
  // A korábbi pin ("nincs még ui/ könyvtár, kihagy") saját docblockja szerint
  // erre az ágra íródott át, amint a lap-feladat elindul -- ez Task 6, és ez
  // az a diff.
  assert.equal(buildTerv().teendo, 'buildel')
  assert.equal(buildTerv().uzenet, null)
})
