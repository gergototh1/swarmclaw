import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

import { renderToStaticMarkup } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'

import { bundle } from '../scripts/build.mjs'
import { readHealth, readKerelmek, readMcpConfig } from '../ui/api.ts'
import { formatDate, formatMs, routeText, statusBadge } from '../ui/format.ts'
import { KerelemList, LIST_LIMIT, McpPanel, StatusPanel, TtsPage } from '../ui/main.tsx'

/**
 * The page, driven without a browser. What a state looks like once drawn is
 * pinned by rendering the component for it to static markup and reading the
 * string: that is enough to see a stranger's sentence arrive as text, a
 * refused answer arrive as its message, and a capped list say so.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const render = (type, props) => renderToStaticMarkup(jsx(type, props))

function health(overrides = {}) {
  return {
    kulcsBeallitva: true, vegpontBeallitva: true, hangGyoker: '/home/x/_remotion/public/narracio/swarmclaw',
    maiMasodperc: 12.4, napiKeret: 900, hang: 'Kenji', modell: 'tts-rt-v1', nyelv: 'hu',
    counts: { kerelmek: 3, kesz: 2, hiba: 1 }, portFile: '/home/x/run/port.json', shim: '/home/x/data/extensions/.workspaces/tts_mjs/mcp/server.mjs',
    ...overrides,
  }
}

function row(overrides = {}) {
  return {
    id: 'r1', modell: 'tts-rt-v1', hang: 'Kenji', nyelv: 'hu', szoveg: 'Egy mondat.', fajl: '/abs/a.mp3', hossz_ms: 1234, bajt: 10,
    status: 'kesz', hiba_kod: '', kerte: 'contract', created_at: '2026-09-05T10:00:00.000Z', ...overrides,
  }
}

const mcp = () => ({ id: 'tts', name: 'n', transport: 'stdio', command: 'node', args: ['/ws/mcp/server.mjs'], env: { SWARMCLAW_PORT_FILE: '/p', SWARMCLAW_ACCESS_KEY: 'az ACCESS_KEY értéke' } })

// --- build ---

test('the built bundle carries no React of its own and resolves the host modules', async () => {
  const result = await bundle({ write: false })
  const text = result.outputFiles.map((f) => f.text).join('\n')
  for (const name of ['react', 'react/jsx-runtime']) {
    assert.ok(text.includes(`host.modules[${JSON.stringify(name)}]`), `${name} resolves against window.swarmclaw.modules`)
  }
  assert.equal(text.includes('react-dom'), false)
  assert.equal(text.includes('Invalid hook call'), false)
  assert.equal(text.includes('react.production'), false)
  assert.equal(text.includes('react.development'), false)
  assert.ok(text.includes("registerPage('tts'") || text.includes('registerPage("tts"'))
})

test('the built bundle registers the declared page with the host React and the id the loader stamped', async () => {
  const result = await bundle({ write: false })
  const code = result.outputFiles.find((f) => f.path.endsWith('.js')).text
  const registrations = []
  class HTMLElement { constructor(dataset) { this.dataset = dataset } }
  const window = {
    swarmclaw: {
      modules: { react: React, 'react/jsx-runtime': jsxRuntime },
      registerPage: (pageId, component, opts) => registrations.push({ pageId, component, opts }),
    },
  }
  const document = { currentScript: new HTMLElement({ extension: 'tts.mjs' }) }
  vm.runInNewContext(code, { window, document, HTMLElement, Error, Object, console }, { filename: 'dist/index.js' })
  assert.equal(registrations.length, 1)
  const [{ pageId, component, opts }] = registrations
  assert.equal(pageId, 'tts')
  assert.equal(opts.extensionId, 'tts.mjs')
  assert.equal(opts.react, React, 'the very object on window.swarmclaw.modules, not a copy')
  assert.equal(typeof component, 'function')
  const html = renderToStaticMarkup(jsx(component, { extensionId: 'tts.mjs', rpc: async () => ({}) }))
  assert.ok(html.includes('data-extension="tts.mjs"'))
  assert.ok(html.includes('Betöltés'))
  assert.equal(html.includes('tts-facts'), false, 'no status is drawn before one arrives')
})

test('the built bundle names the missing host module instead of failing inside React', async () => {
  const result = await bundle({ write: false })
  const code = result.outputFiles.find((f) => f.path.endsWith('.js')).text
  const window = { swarmclaw: { modules: {}, registerPage: () => {} } }
  assert.throws(() => vm.runInNewContext(code, { window, document: { currentScript: null }, Error, Object }), /host module missing: react/)
})

// --- api readers: a malformed answer is refused, not drawn as a blank status ---

test('readHealth refuses a response without counts or without a field the page reads', () => {
  assert.throws(() => readHealth({ ...health(), counts: undefined }), /"counts"/)
  assert.throws(() => readHealth({}), /"counts"/)
  assert.throws(() => readHealth(null), /"health"/)
  assert.throws(() => readHealth('<!doctype html>'), /"health"/)
  assert.throws(() => readHealth({ ...health(), kulcsBeallitva: 'igen' }), /"kulcsBeallitva"/)
  assert.throws(() => readHealth({ ...health(), maiMasodperc: '12' }), /"maiMasodperc"/)
  assert.throws(() => readHealth({ ...health(), counts: { kerelmek: 1, kesz: 1 } }), /"hiba"/)
  assert.throws(() => readHealth({ ...health(), shim: undefined }), /"shim"/)
  assert.throws(() => readHealth({ ...health(), hangGyoker: undefined }), /"hangGyoker"/)
  const ok = readHealth({ ...health(), extra: 'ignored' })
  assert.equal('extra' in ok, false)
  assert.equal(ok.counts.hiba, 1)
})

test('readMcpConfig and readKerelmek refuse what they cannot show as text', () => {
  assert.throws(() => readMcpConfig({ ...mcp(), args: 'node' }), /"args"/)
  assert.throws(() => readMcpConfig({ ...mcp(), env: { A: 1 } }), /"env"/)
  assert.throws(() => readMcpConfig({ ...mcp(), command: undefined }), /"command"/)
  assert.deepEqual(readMcpConfig(mcp()).args, ['/ws/mcp/server.mjs'])
  assert.throws(() => readKerelmek({ rows: [] }), /"kerelmek"/)
  assert.throws(() => readKerelmek(null), /"kerelmek"/)
  assert.deepEqual(readKerelmek([]), [])
})

// --- the list: a stranger's sentence is text, a status is never folded ---

test('the list renders a hostile sentence and path as text, never as markup', () => {
  const html = render(KerelemList, { rows: [row({ szoveg: '<script>x</script>', fajl: '/abs/<img src=x onerror=alert(1)>.mp3' })], total: 1 })
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'))
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<img'), false)
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.mp3'))
})

test('the list keeps finished, failed with its code, lost and unknown statuses apart, and prints a marker for a column that is not what it should be', () => {
  const html = render(KerelemList, { rows: [
    row({ id: 'a', status: 'kesz' }),
    row({ id: 'b', status: 'hiba', hiba_kod: 'tts_egyenleg_kimerult', hossz_ms: 0 }),
    row({ id: 'c', status: 'elveszett' }),
    row({ id: 'd', status: 'furcsa' }),
    row({ id: 'e', szoveg: { nested: true }, hossz_ms: 'x', created_at: 'nem dátum', kerte: 'mcp' }),
  ], total: 5 })
  assert.ok(html.includes('>kész<'))
  assert.ok(html.includes('hiba: tts_egyenleg_kimerult'), 'the balance refusal is named on the row, not flattened')
  assert.ok(html.includes('elveszett (a fájl eltűnt)'))
  assert.ok(html.includes('furcsa (ismeretlen státusz)'))
  assert.ok(html.includes('(nem szöveg)'))
  assert.ok(html.includes('nem dátum'))
  assert.ok(html.includes('>MCP<'))
  assert.equal(html.includes('[object Object]'), false)
  assert.deepEqual(statusBadge('hiba', ''), { text: 'hiba', known: true })
  assert.deepEqual(statusBadge(undefined, ''), { text: '(nincs státusz)', known: false })
  assert.equal(formatMs(1234), '1,2 s')
  assert.equal(formatMs(NaN), '–')
  assert.equal(formatDate(undefined), '–')
  assert.equal(routeText('import'), 'import')
  assert.equal(routeText(7), '(nem szöveg)')
})

test('the list says it is capped with both numbers only when rows stand behind it, and says so when empty', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' })]
  assert.ok(render(KerelemList, { rows, total: 40 }).includes('utolsó 2 kérést mutatja; összesen 40'))
  assert.equal(render(KerelemList, { rows, total: 2 }).includes('összesen'), false)
  assert.equal(render(KerelemList, { rows, total: null }).includes('összesen'), false, 'no total known, no claim about it')
  assert.ok(render(KerelemList, { rows: [], total: 0 }).includes('Még nem volt kérés'))
})

// --- status and the MCP entry ---

test('the status panel tells key from endpoint, shows the counter against the cap, and never a key value', () => {
  const html = render(StatusPanel, { health: health({ kulcsBeallitva: false }) })
  assert.ok(html.includes('nincs beállítva'))
  assert.ok(html.includes('12 s</dd>') || html.includes('12 s / 900 s'))
  assert.ok(html.includes('900 s'))
  assert.ok(html.includes('3 összesen, 2 kész, 1 hibás'))
  assert.ok(html.includes('/home/x/run/port.json'))
  const both = render(StatusPanel, { health: health() })
  assert.equal((both.match(/beállítva/g) || []).length, 2)
  assert.equal(both.includes('nincs'), false)
})

test('the MCP entry is shown as JSON text with the placeholder, and a path in it cannot become markup', () => {
  const html = render(McpPanel, { config: mcp() })
  assert.ok(html.includes('&quot;transport&quot;: &quot;stdio&quot;'))
  assert.ok(html.includes('az ACCESS_KEY értéke'))
  assert.ok(html.includes('tts-pre'))
  const hostile = render(McpPanel, { config: { ...mcp(), args: ['/ws/<b>x</b>/server.mjs'] } })
  assert.equal(hostile.includes('<b>'), false)
  assert.ok(hostile.includes('&lt;b&gt;'))
})

test('the page asks for the list limit it names in its heading', () => {
  const calls = []
  const rpc = async (method, body) => { calls.push({ method, body }); return {} }
  const html = render(TtsPage, { extensionId: 'tts.mjs', rpc })
  assert.ok(html.includes(`Legutóbbi ${LIST_LIMIT} kérés`))
  assert.ok(html.includes('Eltávolítás előtt'))
  assert.ok(html.includes('public/narracio/swarmclaw/'))
  // Effects do not run in a static render, so nothing was asked yet; the page never draws data it did not receive.
  assert.equal(calls.length, 0)
  assert.equal(html.includes('tts-facts'), false)
})

// --- housekeeping ---

test("the extension's package declares every package its own test run imports", () => {
  const pkg = JSON.parse(source('package.json'))
  assert.match(pkg.scripts.test, /--import tsx/)
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  const files = ['test', 'ui', 'scripts'].flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((f) => `${dir}/${f}`))
  const imported = new Set()
  for (const file of files) {
    for (const m of source(file).matchAll(/^import (?:[^'"]*from )?['"]([^'".][^'"]*)['"]/gm)) {
      const spec = m[1]
      if (spec.startsWith('node:')) continue
      imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
  }
  for (const name of [...imported, 'tsx'].sort()) {
    assert.ok(declared.includes(name), `${name} is imported but not declared in package.json`)
  }
})

/**
 * The word is esbuild's option key on one line of scripts/build.mjs, and that
 * line is the only place it may appear. Spelled in two halves here so this
 * file does not carry the word it forbids.
 */
test('the extension says extension, never the other word, in code, comments and tests', () => {
  const dirs = ['src', 'ui', 'test', 'scripts']
  const files = ['index.mjs', ...dirs.flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((f) => `${dir}/${f}`))]
  const forbidden = new RegExp(['plug', 'in'].join(''), 'i')
  const optionKey = new RegExp(`^\\s*${['plug', 'ins'].join('')}:\\s*\\[`)
  const offending = []
  for (const file of files) {
    for (const line of source(file).split('\n')) {
      if (forbidden.test(line) && !(file === 'scripts/build.mjs' && optionKey.test(line))) offending.push(`${file}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offending, [])
})
