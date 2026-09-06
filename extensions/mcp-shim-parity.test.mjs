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
