import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import { proxy } from './proxy'

const originalAccessKey = process.env.ACCESS_KEY
const originalCspEnforce = process.env.SWARMCLAW_CSP_ENFORCE

afterEach(() => {
  if (originalAccessKey === undefined) delete process.env.ACCESS_KEY
  else process.env.ACCESS_KEY = originalAccessKey
  if (originalCspEnforce === undefined) delete process.env.SWARMCLAW_CSP_ENFORCE
  else process.env.SWARMCLAW_CSP_ENFORCE = originalCspEnforce
})

function nonceFromPolicy(policy: string): string {
  const match = policy.match(/'nonce-([^']+)'/)
  assert.ok(match, `policy carries no nonce: ${policy}`)
  return match[1]
}

/** The request headers this response tells Next to render from. */
function forwardedRequestHeaders(response: Response): Headers {
  return new Headers(
    Object.fromEntries(
      (response.headers.get('x-middleware-override-headers') ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
        .map((key) => [key, response.headers.get(`x-middleware-request-${key}`) ?? '']),
    ),
  )
}

describe('proxy', () => {
  it('keeps CORS headers on extension-install auth failures for allowed origins', () => {
    process.env.ACCESS_KEY = 'top-secret'

    const request = new NextRequest('http://localhost/api/extensions/install', {
      method: 'POST',
      headers: {
        origin: 'https://swarmclaw.ai',
      },
    })

    const response = proxy(request)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://swarmclaw.ai')
    assert.equal(response.headers.get('vary'), 'Origin')
  })

  it('prefers the auth cookie over a stale access-key header', () => {
    process.env.ACCESS_KEY = 'top-secret'

    const request = new NextRequest('http://localhost/api/agents', {
      headers: {
        cookie: 'sc_auth=top-secret',
        'x-access-key': 'stale-key',
      },
    })

    const response = proxy(request)
    assert.equal(response.status, 200)
  })

  it('lets the Google OAuth callback through without the access key, but nothing else under /api/oauth', () => {
    // Consent comes back in the system browser on desktop, which holds no auth
    // cookie. The single-use state is the protection, not the cookie.
    process.env.ACCESS_KEY = 'top-secret'

    const callback = proxy(new NextRequest('http://localhost/api/oauth/google/callback?code=c&state=s'))
    assert.equal(callback.status, 200)

    for (const url of [
      'http://localhost/api/oauth/google/start?purpose=aisignal',
      'http://localhost/api/oauth/google/callback/extra',
      'http://localhost/api/oauth/google/callbackx',
    ]) {
      assert.equal(proxy(new NextRequest(url)).status, 401, url)
    }
  })

  it('keeps the callback exemption to GET, so no other method rides in on it', () => {
    process.env.ACCESS_KEY = 'top-secret'

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = proxy(new NextRequest('http://localhost/api/oauth/google/callback', { method }))
      assert.equal(response.status, 401, method)
    }
  })

  it('does not lock out invalid requests in development', () => {
    process.env.ACCESS_KEY = 'top-secret'
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'development'

    try {
      for (let i = 0; i < 6; i++) {
        const response = proxy(new NextRequest('http://localhost/api/agents', {
          headers: {
            'x-access-key': 'bad-key',
          },
        }))
        assert.equal(response.status, 401)
      }
      const finalResponse = proxy(new NextRequest('http://localhost/api/agents', {
        headers: {
          'x-access-key': 'bad-key',
        },
      }))
      assert.equal(finalResponse.status, 401)
    } finally {
      if (originalNodeEnv === undefined) delete (process.env as any).NODE_ENV
      else (process.env as any).NODE_ENV = originalNodeEnv
    }
  })
})

describe('proxy content-security-policy', () => {
  it('reports rather than enforces on a page request by default', () => {
    delete process.env.SWARMCLAW_CSP_ENFORCE
    const response = proxy(new NextRequest('http://localhost/home'))

    assert.equal(response.headers.get('content-security-policy'), null)
    const policy = response.headers.get('content-security-policy-report-only')
    assert.ok(policy?.includes("script-src 'self' 'nonce-"))
  })

  it('enforces when the operator opts in', () => {
    process.env.SWARMCLAW_CSP_ENFORCE = '1'
    const response = proxy(new NextRequest('http://localhost/home'))

    assert.ok(response.headers.get('content-security-policy')?.includes("default-src 'self'"))
    assert.equal(response.headers.get('content-security-policy-report-only'), null)
  })

  it('hands the same nonce to the response and to the request Next renders from', () => {
    // Next reads the nonce back out of the *request* CSP header, so a request
    // that only carried x-nonce would leave every Next script tag unnonced.
    const response = proxy(new NextRequest('http://localhost/x/aisignal'))
    const policy = response.headers.get('content-security-policy-report-only')
    assert.ok(policy)

    const forwarded = forwardedRequestHeaders(response)

    const nonce = nonceFromPolicy(policy)
    assert.equal(forwarded.get('x-nonce'), nonce)
    assert.equal(forwarded.get('content-security-policy-report-only'), policy)
  })

  it('gives every page request its own nonce', () => {
    const first = proxy(new NextRequest('http://localhost/home'))
    const second = proxy(new NextRequest('http://localhost/home'))
    assert.notEqual(
      nonceFromPolicy(first.headers.get('content-security-policy-report-only') ?? ''),
      nonceFromPolicy(second.headers.get('content-security-policy-report-only') ?? ''),
    )
  })

  it('leaves API responses alone so the asset route keeps its own policy', () => {
    // /api/extensions/:id/assets/:path* sets Content-Security-Policy: sandbox on
    // svg bodies. A proxy-set page policy would collide with it.
    delete process.env.ACCESS_KEY
    for (const path of [
      '/api/extensions/aisignal/assets/icon.svg',
      '/api/healthz',
      '/api/agents',
    ]) {
      const response = proxy(new NextRequest(`http://localhost${path}`))
      assert.equal(response.headers.get('content-security-policy'), null, path)
      assert.equal(response.headers.get('content-security-policy-report-only'), null, path)
    }
  })

  it('leaves the public A2A agent card without a page policy or a nonce', () => {
    // /.well-known/agent-card.json is application/json fetched by remote agents,
    // not a document. A page CSP there is meaningless at best, and an x-nonce it
    // never asked for is the seed of a future JSON route inheriting a page
    // policy. It is also not access-key gated, so it must not 401 either.
    process.env.ACCESS_KEY = 'top-secret'
    const response = proxy(new NextRequest('http://localhost/.well-known/agent-card.json'))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-security-policy'), null)
    assert.equal(response.headers.get('content-security-policy-report-only'), null)
    assert.equal(forwardedRequestHeaders(response).get('x-nonce'), null)
  })

  it('leaves static assets alone rather than treating every non-api path as a page', () => {
    process.env.ACCESS_KEY = 'top-secret'
    for (const path of [
      '/icon.svg',
      '/next.svg',
      '/branding/swarmclaw-mark.png',
      '/provider-logos/openai.svg',
      '/favicon.ico',
    ]) {
      const response = proxy(new NextRequest(`http://localhost${path}`))
      assert.equal(response.status, 200, path)
      assert.equal(response.headers.get('content-security-policy'), null, path)
      assert.equal(response.headers.get('content-security-policy-report-only'), null, path)
      assert.equal(forwardedRequestHeaders(response).get('x-nonce'), null, path)
    }
  })

  it('still policies every real page route, including extension pages and share links', () => {
    delete process.env.ACCESS_KEY
    for (const path of [
      '/',
      '/home',
      '/agents/2f1c9a3e-0d4b-4f21-9a77-1b6c0e5d8a42',
      '/x/aisignal',
      '/s/Q0hFQ0stVE9LRU4',
    ]) {
      const response = proxy(new NextRequest(`http://localhost${path}`))
      assert.ok(response.headers.get('content-security-policy-report-only'), path)
    }
  })

  it('still lets an unauthenticated page request through with a key configured', () => {
    // Extending the matcher to pages must not put pages behind the access key.
    process.env.ACCESS_KEY = 'top-secret'
    const response = proxy(new NextRequest('http://localhost/home'))
    assert.equal(response.status, 200)
    assert.ok(response.headers.get('content-security-policy-report-only'))
  })

  it('policies a dotted path under /x/, which the dot rule alone would misread as a file', () => {
    // /x/[[...slug]]/page.tsx is an optional catch-all: it matches any path
    // under /x/, dots included. `ui.pages`' PATH_RE only validates what an
    // extension manifest may declare, not what the route matches, so
    // /x/foo.json still renders this app's own document HTML and must carry
    // the policy the same as any other extension page.
    delete process.env.ACCESS_KEY
    const response = proxy(new NextRequest('http://localhost/x/foo.json'))
    assert.ok(response.headers.get('content-security-policy-report-only'))
  })

  it('leaves a dotted static asset without a policy', () => {
    delete process.env.ACCESS_KEY
    const response = proxy(new NextRequest('http://localhost/branding/swarmclaw-mark.png'))
    assert.equal(response.headers.get('content-security-policy'), null)
    assert.equal(response.headers.get('content-security-policy-report-only'), null)
  })
})
