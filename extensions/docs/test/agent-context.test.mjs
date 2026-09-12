import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentContext } from '../src/agent-context.mjs'

const ctx = createAgentContext({}, { serviceOf: () => ({ list: () => [] }), sharedFolder: () => 'shared', logOf: () => null })

test('the first operating rule sends readable output to Docs, not to a file', () => {
  const [first] = ctx.getOperatingGuidance()
  assert.match(first, /docs_write/)
  assert.match(first, /not into a file in your working directory/)
})

test('the MCP instructions are short and name the rule, the version handshake and the shared folder', () => {
  const text = ctx.getMcpInstructions()
  assert.ok(text.split('\n').length <= 6, 'keep it to a handful of lines')
  assert.match(text, /docs_write/)
  assert.match(text, /baseVersion/)
  assert.match(text, /"shared"/)
})
