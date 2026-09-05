import assert from 'node:assert/strict'
import { test } from 'node:test'

import { forrasUrl } from '../ui/format.ts'
import { safeHref } from '../ui/safe-href.ts'

/**
 * The one gate between a stored url and an href. The source text of every
 * video is a stranger's, so the gate is an allowlist of two schemes and
 * nothing else.
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

/**
 * The url the Video view offers is the LAST paragraph of the source text and
 * only when the whole paragraph is a safe url. `videoOpen` joins headline,
 * summary and url with blank lines, so it is the third paragraph when the
 * summary is there and the second when it is not; and a paragraph of prose
 * that merely mentions a url stays prose.
 */
test('forrasUrl takes the last paragraph and only when the whole of it is a safe url', () => {
  assert.equal(forrasUrl('Cím\n\nÖsszefoglaló\n\nhttps://example.test/a', safeHref), 'https://example.test/a')
  assert.equal(forrasUrl('Cím\n\nhttps://example.test/a', safeHref), 'https://example.test/a')
  assert.equal(forrasUrl('Cím\n\nÖsszefoglaló\n\njavascript:alert(1)', safeHref), null)
  assert.equal(forrasUrl('Cím\n\nhttps://example.test/a\n\nAz utolsó bekezdés próza.', safeHref), null)
  assert.equal(forrasUrl('Nézd meg itt: https://example.test/a most', safeHref), null)
  assert.equal(forrasUrl('', safeHref), null)
  assert.equal(forrasUrl('\n\n\n', safeHref), null)
})
