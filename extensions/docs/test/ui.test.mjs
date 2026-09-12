import assert from 'node:assert/strict'
import test from 'node:test'

import { HOST_MODULES, bundle, bundleExport } from '../scripts/build.mjs'

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
  assert.ok(code.includes('window.swarmclaw'), 'does not read the host table')
  // React's own dev warnings and the reconciler's telltale strings.
  for (const marker of ['react.production', 'react.development', 'Invalid hook call', '__SECRET_INTERNALS']) {
    assert.ok(!code.includes(marker), `React source ended up in the bundle: ${marker}`)
  }
})

test('react comes from the host table, and every host module is on the list', async () => {
  const code = await output()
  // This can only assert what the bundle IMPORTS of the three actually comes
  // through the table. react-dom, for instance, is not imported by this page,
  // so it does not show up either -- that is not a bug, just nothing needing it.
  //
  // The minifier rewrites `modules["react"]` indexing into a `modules.react`
  // property read, so either spelling is acceptable; what matters is that
  // react arrives through the host table.
  assert.match(code, /modules(\.react\b|\["react"\]|\['react'\])/, 'react does not come from the host table')
  assert.ok(HOST_MODULES.includes('react'))
  assert.ok(HOST_MODULES.includes('react-dom'))
  assert.ok(HOST_MODULES.includes('react/jsx-runtime'))
})

test('the page registers itself under the id the host expects', async () => {
  const code = await output()
  assert.ok(code.includes('registerPage'), 'does not call registerPage')
  assert.ok(code.includes('"docs"') || code.includes("'docs'"), 'does not register the docs page')
})

test('the bundle stays under a size the page can justify', async () => {
  const code = await output()
  const kb = Buffer.byteLength(code) / 1024
  // TipTap and ProseMirror are the big line item, and the host does not
  // publish an instance of them. The ceiling is not aesthetics -- above it the
  // editor is worth replacing rather than growing further.
  assert.ok(kb < 700, `bundle grew too large: ${Math.round(kb)} kB`)
})

test('the bundle registers the chat panel beside the page', async () => {
  const code = await output()
  assert.ok(code.includes('panel:doc'), 'the doc panel is not registered')
})

let builtExport = null
async function exportOutput() {
  if (!builtExport) {
    const result = await bundleExport({ write: false, minify: true })
    builtExport = result.outputFiles[0].text
  }
  return builtExport
}

test('the export bundle installs itself and stays apart from the page bundle', async () => {
  const page = await output()
  const exporter = await exportOutput()
  assert.ok(exporter.includes('swarmclawDocsExport'), 'the export bundle does not install its global')
  assert.ok(exporter.includes('wordprocessingml'), 'the export bundle does not carry the docx writer')
  assert.ok(!page.includes('wordprocessingml'), 'the docx writer leaked into the page bundle')
  assert.ok(Buffer.byteLength(exporter) / 1024 < 600, 'the export bundle grew past 600 kB')
})

test('the page can export: it asks the host for PDFs and loads the Word bundle on demand', async () => {
  const code = await output()
  assert.ok(code.includes('savePdf'), 'the page never asks the host to save a PDF')
  assert.ok(code.includes('export.js'), 'the page never loads the export bundle')
})
