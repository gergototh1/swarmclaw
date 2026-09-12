import assert from 'node:assert/strict'
import test from 'node:test'

import { DocsError, ERR, errorResult } from '../src/errors.mjs'

test('every error code is English snake_case and equals its key', () => {
  assert.deepEqual(Object.keys(ERR).sort(), [
    'already_exists', 'conflict', 'contract_missing', 'doc_not_found', 'forbidden',
    'invalid_argument', 'path_forbidden', 'root_not_writable', 'video_not_found',
  ])
  for (const [key, value] of Object.entries(ERR)) assert.equal(key, value)
})

test('errorResult carries the code under "error" so an MCP client reads it as a failure', () => {
  assert.deepEqual(errorResult(ERR.forbidden, 'no'), { error: 'forbidden', message: 'no' })
})

test('DocsError keeps its code', () => {
  const e = new DocsError(ERR.conflict, 'changed meanwhile')
  assert.equal(e.code, 'conflict')
  assert.equal(e.message, 'changed meanwhile')
})
