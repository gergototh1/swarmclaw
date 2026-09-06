import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The MCP shim is duplicated, on purpose, and this is what keeps the copies
 * honest.
 *
 * It cannot be shared from one place: each shim runs from its own extension's
 * installed workspace, spawned with plain `node` and no `node_modules` in
 * reach, so it can import nothing outside its own tree. Copying it is the only
 * option the arrangement leaves.
 *
 * What makes that tolerable is that the file is generic — it names no tool and
 * asks the host for its table — so the copies differ only in which extension
 * they front. This test pins that down: two constants may differ, and nothing
 * else may. A fix applied to one copy and forgotten in the others fails here
 * rather than in whichever module nobody was looking at.
 *
 * The same holds for `src/mcp-bridge.mjs`, which is byte-identical everywhere.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTENSIONS = ['aisignal', 'docs', 'video']

/** The two lines that are allowed to differ, and what each must say. */
const PER_EXTENSION = [
  { line: (name) => `const EXTENSION_ID = '${name}.mjs'`, what: 'EXTENSION_ID' },
  { line: (name) => `const SERVER_INFO = { name: 'swarmclaw-${name}', version: '0.1.0' }`, what: 'SERVER_INFO' },
]

const read = (name, ...rest) => fs.readFileSync(path.join(HERE, name, ...rest), 'utf8')

test('every extension that ships an MCP shim carries the same one', () => {
  const normalised = EXTENSIONS.map((name) => {
    let text = read(name, 'mcp', 'server.mjs')
    for (const { line, what } of PER_EXTENSION) {
      const own = line(name)
      assert.ok(text.includes(own), `${name}/mcp/server.mjs does not carry its own ${what}: expected ${own}`)
      text = text.replace(own, `const ${what} = <per extension>`)
    }
    return { name, text }
  })
  const [first, ...rest] = normalised
  for (const other of rest) {
    assert.equal(
      other.text,
      first.text,
      `${other.name}/mcp/server.mjs has drifted from ${first.name}/mcp/server.mjs. `
      + 'Apply the change to all copies, or make the difference one of the two per-extension constants.',
    )
  }
})

test('the bridge is byte-identical in every extension', () => {
  const texts = EXTENSIONS.map((name) => ({ name, text: read(name, 'src', 'mcp-bridge.mjs') }))
  const [first, ...rest] = texts
  for (const other of rest) {
    assert.equal(other.text, first.text, `${other.name}/src/mcp-bridge.mjs has drifted from ${first.name}'s`)
  }
})

test('no shim names a tool, because the tool table comes from the host', () => {
  // A tool name appearing here would mean this copy had started carrying its
  // own table, which is the drift the generic design exists to avoid.
  for (const name of EXTENSIONS) {
    const text = read(name, 'mcp', 'server.mjs')
    assert.equal(/\bvideo[A-Z]\w*|doksi_\w+|signalSweep\b/.test(text), false, `${name}/mcp/server.mjs names a tool`)
  }
})

test('every shipped shim is installed, or it is not on the machine that runs it', () => {
  // The workspace copy is what the operator's MCP entry points at. An extension
  // whose install script does not copy `mcp/` ships a shim that never arrives.
  for (const name of EXTENSIONS) {
    const install = read(name, 'scripts', 'install.mjs')
    assert.match(install, /'mcp'/, `${name}/scripts/install.mjs does not copy mcp/ into the workspace`)
  }
})

/**
 * The other thing that is duplicated across extensions on purpose, and the
 * other place it can drift silently: a contract's shape, held by a provider in
 * one tree and by a consumer in another.
 *
 * These checks live here rather than in `extensions/docs/test/` deliberately.
 * A docs test that imported the video module would fail on an install that has
 * no video module -- which is a normal install, not a defect -- and would
 * couple two suites that must be able to run apart. This file already reads
 * across the extension trees and runs in the same CI command as every
 * extension suite, so it is where a cross-tree agreement belongs.
 *
 * What it catches: a twelfth column added to the provider's projection that
 * the consumer's document never mentions, a renamed contract, and a version
 * bump on one side only.
 */

const { VIDEOS_CONTRACT: PROVIDER_NAME, VIDEOS_CONTRACT_VERSION: PROVIDER_VERSION, VIDEO_CONTRACT_COLUMNS } = await import('./video/src/contract.mjs')
const { VIDEOS_CONTRACT: CONSUMER_NAME, VIDEOS_CONTRACT_VERSION: CONSUMER_VERSION, forgatokonyv } = await import('./docs/src/video-forgatokonyv.mjs')

test('the docs module pins the contract the video module actually offers', () => {
  assert.equal(CONSUMER_NAME, PROVIDER_NAME, 'a fogyasztó más nevű szerződést kér, mint amit a szolgáltató kínál')
  assert.equal(
    CONSUMER_VERSION,
    PROVIDER_VERSION,
    'a két verzió elvált: így a host version_mismatch-et ad, és a doksi_video_forgatokonyv minden hívónál elutasít. '
    + 'Ha a videos szerződés szándékosan lépett verziót, a Doksik oldalát is át kell nézni és utána léptetni.',
  )
})

test('every column the videos contract carries reaches the document the docs module writes', () => {
  // Egyetlen renderelés olyan sorból, ahol minden oszlop saját ujjlenyomatot
  // hord. Egy tizenkettedik oszlop, amit a fogyasztó nem ír le, itt bukik --
  // nem pedig egy doksiban, amiről senki nem tudja, hogy hiányos.
  const nyom = (col) => (col === 'hossz_ms'
    // Az egyetlen nem szöveg oszlop: a fogyasztó másodpercre váltja, tehát a
    // kiírt alakját kell keresni, nem a nyers számot.
    ? { ertek: 12345, latszik: '12,3 mp' }
    : { ertek: `NYOM_${col}`, latszik: `NYOM_${col}` })

  const row = Object.fromEntries(VIDEO_CONTRACT_COLUMNS.map((col) => [col, nyom(col).ertek]))
  const { cim, tartalom } = forgatokonyv(row, row.id)
  const doksi = `${cim}\n${tartalom}`
  for (const col of VIDEO_CONTRACT_COLUMNS) {
    assert.ok(
      doksi.includes(nyom(col).latszik),
      `a videos szerződés "${col}" oszlopa nem jelenik meg a Doksik által írt doksiban. `
      + 'Ha új oszlop, vedd fel a forgatokonyv() felsorolásába; ha szándékosan marad ki, ez a teszt mondja meg, hogy döntés volt.',
    )
  }
})
