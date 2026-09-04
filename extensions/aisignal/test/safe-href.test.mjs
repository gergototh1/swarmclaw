import assert from 'node:assert/strict'
import { test } from 'node:test'

import { safeHref } from '../ui/safe-href.ts'

/**
 * The one gate between a stored url and an href. Every url on the board is a
 * stranger's text, so the gate is an allowlist of two schemes and nothing else.
 */
test('safeHref allows only http(s)', () => {
  assert.equal(safeHref('https://a'), 'https://a')
  assert.equal(safeHref(' http://a '), 'http://a')
  assert.equal(safeHref('HTTPS://Example.com/x?y=1'), 'HTTPS://Example.com/x?y=1')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref(' javascript:alert(1)'), null)
  assert.equal(safeHref('JavaScript:alert(1)'), null)
  assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null)
  assert.equal(safeHref('vbscript:msgbox'), null)
  assert.equal(safeHref('file:///etc/passwd'), null)
  assert.equal(safeHref('//evil.example/x'), null)
  assert.equal(safeHref('ftp://a'), null)
  assert.equal(safeHref('https:/a'), null)
  assert.equal(safeHref('xhttps://a'), null)
  assert.equal(safeHref(''), null)
  assert.equal(safeHref('   '), null)
  assert.equal(safeHref(null), null)
  assert.equal(safeHref(undefined), null)
})
