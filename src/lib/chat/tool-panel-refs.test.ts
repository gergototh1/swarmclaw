import test from 'node:test'
import assert from 'node:assert/strict'
import { bareToolName, findToolPanelRefs, toolPanelRefKey } from './tool-panel-refs'
import type { ExtensionToolPanel } from '@/types/extension'

const panels: ExtensionToolPanel[] = [{
  extensionId: 'docs.mjs', id: 'doc', label: 'Doc', icon: 'FileText',
  tools: ['docs_write', 'doksi_ir'], entry: 'dist/index.js', css: 'dist/style.css',
}]

const out = (value: unknown) => JSON.stringify(value)

test('the MCP prefix comes off, a bare name stays', () => {
  assert.equal(bareToolName('mcp__Docs-MCP__docs_write'), 'docs_write')
  assert.equal(bareToolName('docs_write'), 'docs_write')
  assert.equal(bareToolName('mcp__broken'), 'mcp__broken')
})

test('a matching call with a panel reference becomes a card', () => {
  const refs = findToolPanelRefs([
    { name: 'mcp__Docs-MCP__docs_write', input: '{}', output: out({ id: 'doc_1', path: 'a.md', panel: { id: 'doc_1', title: 'Report' } }) },
  ], panels)
  assert.deepEqual(refs, [{
    extensionId: 'docs.mjs', panelId: 'doc', refId: 'doc_1', title: 'Report',
    icon: 'FileText', entry: 'dist/index.js', css: 'dist/style.css',
  }])
})

test('an old call with only an id falls back to the id and the panel label', () => {
  const refs = findToolPanelRefs([
    { name: 'mcp__Doksik-MCP__doksi_ir', input: '{}', output: out({ id: 'doc_f8573ac5', utvonal: 'x.md', verzio: 1 }) },
  ], panels)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].refId, 'doc_f8573ac5')
  assert.equal(refs[0].title, 'Doc')
})

test('errors, non-JSON output, unknown tools and missing ids give no card', () => {
  const refs = findToolPanelRefs([
    { name: 'docs_write', input: '{}', output: out({ id: 'doc_1' }), error: true },
    { name: 'docs_write', input: '{}', output: 'not json' },
    { name: 'docs_write', input: '{}' },
    { name: 'Bash', input: '{}', output: out({ id: 'doc_1' }) },
    { name: 'docs_write', input: '{}', output: out({ error: 'conflict', message: 'x' }) },
    { name: 'docs_write', input: '{}', output: out(['doc_1']) },
  ], panels)
  assert.deepEqual(refs, [])
})

test('three writes to one doc are one card, carrying the latest title, in first-seen order', () => {
  const refs = findToolPanelRefs([
    { name: 'docs_write', input: '{}', output: out({ id: 'a', panel: { id: 'a', title: 'A1' } }) },
    { name: 'docs_write', input: '{}', output: out({ id: 'b', panel: { id: 'b', title: 'B' } }) },
    { name: 'docs_write', input: '{}', output: out({ id: 'a', panel: { id: 'a', title: 'A2' } }) },
  ], panels)
  assert.deepEqual(refs.map((r) => [r.refId, r.title]), [['a', 'A2'], ['b', 'B']])
})

test('ids that contain the key separator character still make separate cards', () => {
  // The dedupe key joins extensionId, panelId and refId. A ref id is whatever
  // the tool answered with, so the join has to use a character that cannot
  // appear inside one -- with a printable separator, 'a:b' plus panel 'doc'
  // would collide with panel 'doc:a' plus id 'b'.
  const two: ExtensionToolPanel[] = [
    { ...panels[0], id: 'doc' },
    { ...panels[0], id: 'doc:a', tools: ['docs_video_script'] },
  ]
  const refs = findToolPanelRefs([
    { name: 'docs_write', input: '{}', output: out({ id: 'a:b', panel: { id: 'a:b', title: 'One' } }) },
    { name: 'docs_video_script', input: '{}', output: out({ id: 'b', panel: { id: 'b', title: 'Two' } }) },
  ], two)
  assert.deepEqual(refs.map((r) => [r.panelId, r.refId, r.title]), [['doc', 'a:b', 'One'], ['doc:a', 'b', 'Two']])
})

test('toolPanelRefKey does not collide when a panel id and a refId share a printable separator', () => {
  // Pins the exact collision the dedupe key and the React key must both
  // avoid: panel 'doc' + refId 'a:b' vs panel 'doc:a' + refId 'b'.
  const a = toolPanelRefKey({ extensionId: 'docs.mjs', panelId: 'doc', refId: 'a:b' })
  const b = toolPanelRefKey({ extensionId: 'docs.mjs', panelId: 'doc:a', refId: 'b' })
  assert.notEqual(a, b)
})

test('no tool events or no panels give no cards', () => {
  assert.deepEqual(findToolPanelRefs(undefined, panels), [])
  assert.deepEqual(findToolPanelRefs([{ name: 'docs_write', input: '{}', output: out({ id: 'a' }) }], []), [])
})
