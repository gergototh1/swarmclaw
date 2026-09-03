import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildContentSecurityPolicy,
  contentSecurityPolicyHeaderName,
} from './content-security-policy'

/** Split a policy string into `directive -> sources` for order-independent assertions. */
function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    const name = tokens.shift()
    if (name) map.set(name, tokens)
  }
  return map
}

describe('buildContentSecurityPolicy', () => {
  it('puts the nonce in script-src where Next parses it back out', () => {
    const policy = buildContentSecurityPolicy('abc123', { allowEval: false })
    assert.ok(directives(policy).get('script-src')?.includes("'nonce-abc123'"))
  })

  it('keeps host sources usable by never emitting strict-dynamic', () => {
    // 'strict-dynamic' makes browsers ignore 'self', so a page Next renders
    // statically (no nonce) would load none of its scripts and go blank.
    const policy = buildContentSecurityPolicy('abc123', { allowEval: false })
    assert.ok(!policy.includes('strict-dynamic'))
    assert.ok(directives(policy).get('script-src')?.includes("'self'"))
  })

  it('never allows inline script, in either mode', () => {
    for (const allowEval of [true, false]) {
      const scriptSrc = directives(buildContentSecurityPolicy('n', { allowEval })).get('script-src')
      assert.ok(!scriptSrc?.includes("'unsafe-inline'"))
    }
  })

  it('allows eval only when asked, so development keeps React Refresh', () => {
    const dev = directives(buildContentSecurityPolicy('n', { allowEval: true })).get('script-src')
    const prod = directives(buildContentSecurityPolicy('n', { allowEval: false })).get('script-src')
    assert.ok(dev?.includes("'unsafe-eval'"))
    assert.ok(!prod?.includes("'unsafe-eval'"))
  })

  it('allows inline style attributes, which React style props and Recharts need', () => {
    const styleSrc = directives(buildContentSecurityPolicy('n', { allowEval: false })).get('style-src')
    assert.ok(styleSrc?.includes("'unsafe-inline'"))
  })

  it('serves the same-origin extension bundle URL out of script-src self', () => {
    // Extension pages load /api/extensions/<id>/assets/<file>.js by script tag.
    // That is same-origin, so 'self' covers it and no per-extension source is
    // needed. This is not isolation: the bundle runs with full page privileges.
    const scriptSrc = directives(buildContentSecurityPolicy('n', { allowEval: false })).get('script-src')
    assert.deepEqual(scriptSrc, ["'self'", "'nonce-n'"])
  })

  it('keeps the directives an unpolicied app already relied on', () => {
    const parsed = directives(buildContentSecurityPolicy('n', { allowEval: false }))
    // Chat embeds YouTube and frames uploaded PDFs; tool output plays remote media.
    assert.ok(parsed.get('frame-src')?.includes('https:'))
    assert.ok(parsed.get('media-src')?.includes('blob:'))
    assert.ok(parsed.get('img-src')?.includes('data:'))
    // The realtime channel is ws:// on PORT+1 for a plain-http self-hosted install.
    assert.ok(parsed.get('connect-src')?.includes('ws:'))
    assert.ok(parsed.get('connect-src')?.includes('wss:'))
  })

  it('does not upgrade insecure requests, which would break http installs', () => {
    assert.ok(!buildContentSecurityPolicy('n', { allowEval: false }).includes('upgrade-insecure-requests'))
  })

  it('locks down the directives nothing in the app uses', () => {
    const parsed = directives(buildContentSecurityPolicy('n', { allowEval: false }))
    assert.deepEqual(parsed.get('object-src'), ["'none'"])
    assert.deepEqual(parsed.get('base-uri'), ["'self'"])
    assert.deepEqual(parsed.get('form-action'), ["'self'"])
    assert.deepEqual(parsed.get('frame-ancestors'), ["'none'"])
  })
})

describe('contentSecurityPolicyHeaderName', () => {
  it('reports rather than blocks until an operator opts in', () => {
    assert.equal(contentSecurityPolicyHeaderName(false), 'Content-Security-Policy-Report-Only')
    assert.equal(contentSecurityPolicyHeaderName(true), 'Content-Security-Policy')
  })
})
