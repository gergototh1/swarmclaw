import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The extension was translated to English in full, and this is what keeps it
 * that way: every non-test source file is scanned for Hungarian words and
 * accented letters.
 *
 * Two exceptions, both named. `src/legacy-names.mjs` is where the old names
 * must still be spelled, because stored settings, folders on disk and old chat
 * messages carry them. And reads of the Video module's contract rows
 * (`video.cim`, `video.hossz_ms`) are that module's API, not this one's.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEGACY_FILE = 'src/legacy-names.mjs'

/** Every source file under the given directories, subdirectories included. */
function walk(rel) {
  const out = []
  for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(child))
    else if (/\.(mjs|ts|tsx|css)$/.test(entry.name)) out.push(child)
  }
  return out
}

function sourceFiles() {
  const out = ['index.mjs', ...['src', 'ui', 'mcp', 'scripts'].flatMap(walk)]
  return out.filter((rel) => rel !== LEGACY_FILE)
}

/** Whole words that are Hungarian in this codebase. */
const EXACT = new Set([
  'cim', 'cimek', 'nev', 'nevek', 'fa', 'fut', 'uj', 'hiba', 'kuka', 'mezo', 'gomb', 'tagek', 'hivo', 'ovek',
  'sajat', 'elemek', 'nincs', 'rossz', 'ilyen', 'valt', 'ment', 'lap', 'sav', 'baj', 'proza', 'aktiv', 'panelvalt',
])

/** Stems: a word starting with one of these is Hungarian. */
const STEMS = [
  'doksi', 'mappa', 'tartalom', 'utvonal', 'verzio', 'gyoker', 'kozos', 'sablon', 'muvelet', 'allapot',
  'utkozes', 'tulajdonos', 'valtoz', 'uzenet', 'figyel', 'talalat', 'frissit', 'elonezet', 'letrehoz', 'olvas',
  'beallit', 'szerkeszt', 'forgatokonyv', 'fejlec', 'fejgomb', 'visszaallit', 'betolt', 'elavult', 'kapott',
  'reszlet', 'ugynok', 'jelenlegi', 'oszlop', 'fokusz', 'javit', 'ismeretlen', 'cimke', 'felold', 'nyugalom',
  'eltavolit', 'kihagy', 'hivatkoz', 'modosit', 'lekerdez', 'szerzodes', 'megtartas', 'mozgat', 'vegleges',
  'ujraind', 'hasab', 'atnevez', 'atnezett', 'nyitva', 'halvany', 'eszkoztar', 'zarolas', 'kulcs', 'letesz',
  'keres', 'torol', 'allas', 'tiszta', 'elozo', 'mentve', 'idotullepes', 'kapcsolat', 'hianyzik', 'ervenytelen',
  'beallitatlan', 'narracio', 'hossz',
]

const ACCENTS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/

/** Accented letters used as examples of accent folding, in English prose. */
const ACCENT_EXAMPLES = ["lower('Ü')", "`'Ü'`", "'ő' into 'o'", "'ű' into 'u'"]

function wordsOf(line) {
  return line
    .split(/[^A-Za-z]+/)
    .flatMap((token) => token.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [])
    .map((w) => w.toLowerCase())
}

function hungarianWord(line) {
  return wordsOf(line).find((w) => EXACT.has(w) || STEMS.some((s) => w.startsWith(s)))
}

test('the docs extension source is English', () => {
  const problems = []
  for (const rel of sourceFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
    lines.forEach((raw, i) => {
      const line = raw.replace(/\bvideo\??\.[a-z_]+/g, '')
      if (ACCENTS.test(line) && !ACCENT_EXAMPLES.some((s) => line.includes(s))) {
        problems.push(`${rel}:${i + 1} accented text: ${raw.trim().slice(0, 80)}`)
      }
      const word = hungarianWord(line)
      if (word) problems.push(`${rel}:${i + 1} "${word}": ${raw.trim().slice(0, 80)}`)
    })
  }
  assert.deepEqual(problems, [])
})

test('the guard itself catches a Hungarian identifier and lets English through', () => {
  assert.equal(hungarianWord('const aktivId = null'), 'aktiv')
  assert.equal(hungarianWord('rpc("ujraindex")'), 'ujraindex')
  assert.equal(hungarianWord('.docs-hasabok { display: grid }'), 'hasabok')
  assert.equal(hungarianWord('const activeId = sort(comment)'), undefined)
})

/**
 * Regression guard for a real incident: a rootless docs.setup(fakeCtx({}))
 * in a settings test once ran the folder migration against the operator's
 * REAL ~/SwarmClaw/docs and moved live documents. Every test that calls
 * setup on a fake context must pass an explicit `root` in the settings
 * object, so the migration never touches a real home directory.
 */
const GUARD_FILE = 'english-only.test.mjs'

function testFiles() {
  return fs
    .readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.mjs') && f !== GUARD_FILE)
}

test('every docs.setup(fakeCtx(...)) call in the test suite passes an explicit root', () => {
  const problems = []
  for (const file of testFiles()) {
    const rel = `test/${file}`
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const lines = text.split('\n')
    lines.forEach((raw, i) => {
      if (!/\.setup\(\s*fakeCtx\(/.test(raw)) return
      // Gather this call across a few lines, since fakeCtx({...}) can be multi-line.
      const window = lines.slice(i, i + 12).join('\n')
      const callMatch = window.match(/\.setup\(\s*fakeCtx\(([\s\S]*)/)
      if (!callMatch) return
      const rest = callMatch[1]
      // Find the balanced-ish settings object passed to fakeCtx by taking up to
      // the matching close paren of fakeCtx(...). We approximate by scanning
      // until parens/braces balance back to zero.
      let depth = 1
      let end = -1
      for (let j = 0; j < rest.length; j += 1) {
        if (rest[j] === '(') depth += 1
        else if (rest[j] === ')') {
          depth -= 1
          if (depth === 0) {
            end = j
            break
          }
        }
      }
      const args = end === -1 ? rest : rest.slice(0, end)
      // A `root` key has to be present, and if it carries a value that value has
      // to be real: `root: undefined`, `root: null`, `root: ''`, `root: ""` and
      // `root: ``` `` ``` all resolve to the operator's real ~/SwarmClaw/docs
      // once rootSetting() falls back, so none of them count as an explicit
      // root. Shorthand `{ root }` (no colon) has no literal to inspect here --
      // it is a variable, and the runtime guard in fakeCtx() covers whatever
      // that variable turns out to hold.
      // The value pattern takes a whole quoted literal, spaces included: a
      // root of '   ' is as empty as '' once rootSetting() trims it.
      const rootMatch = args.match(/\broot\b(?:\s*:\s*('[^']*'|"[^"]*"|`[^`]*`|[^\s,)}]+))?/)
      const literal = rootMatch?.[1]
      const unquoted = literal && /^(['"`]).*\1$/s.test(literal) ? literal.slice(1, -1) : literal
      const emptyRoot = unquoted !== undefined
        && (unquoted === 'undefined' || unquoted === 'null' || unquoted.trim() === '')
      if (!rootMatch || emptyRoot) {
        problems.push(`${rel}:${i + 1} setup(fakeCtx(...)) without an explicit root: ${raw.trim().slice(0, 80)}`)
      }
    })
  }
  assert.deepEqual(problems, [])
})
