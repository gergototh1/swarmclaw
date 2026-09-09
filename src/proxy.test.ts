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
  // The rate-limit bucket is module state keyed by source IP, and every request
  // built here shares one. Left uncleared, one test's failed attempts spend the
  // next test's budget and it gets a 429 it never asked for.
  clearRateLimitState()
})

/** Drops every rate-limit bucket, if the proxy has created the map at all. */
function clearRateLimitState() {
  const store = globalThis as unknown as Record<string, Map<string, unknown> | undefined>
  store.__swarmclaw_rate_limit__?.clear()
}

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

interface TestRateLimitEntry {
  count: number
  lockedUntil: number
  lastFailureAt: number
}

/** The proxy's rate-limit state, reached the same way HMR reaches it. */
function rateLimitState(): Map<string, TestRateLimitEntry> {
  const store = globalThis as unknown as Record<string, Map<string, TestRateLimitEntry>>
  const map = store.__swarmclaw_rate_limit__
  assert.ok(map, 'rate-limit map has not been created yet')
  return map
}

function apiRequest(key: string, forwardedFor = '203.0.113.7'): NextRequest {
  return new NextRequest('http://localhost/api/agents', {
    headers: { 'x-access-key': key, 'x-forwarded-for': forwardedFor },
  })
}


type MutableEnv = Record<string, string | undefined>

/** Runs `body` with NODE_ENV pinned, an access key configured, and a clean bucket. */
function withNodeEnv(value: string, body: () => void) {
  const env = process.env as unknown as MutableEnv
  const originalNodeEnv = env.NODE_ENV
  env.NODE_ENV = value
  process.env.ACCESS_KEY = 'top-secret'
  try {
    body()
  } finally {
    if (originalNodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = originalNodeEnv
    clearRateLimitState()
  }
}

/** Runs `body` with the proxy in its production configuration. */
function inProduction(body: () => void) {
  withNodeEnv('production', body)
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
    withNodeEnv('development', () => {
      for (let i = 0; i < 7; i++) {
        assert.equal(proxy(apiRequest('bad-key')).status, 401, `attempt ${i}`)
      }
    })
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

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */

describe('proxy rate limiting', () => {
  it('does not let a client with a bad key lock out a client with the good key on the same IP', () => {
    // Desktop builds put every client on 127.0.0.1, so one misconfigured local
    // program used to take the Electron window down with it for 15 minutes.
    inProduction(() => {
      for (let i = 0; i < 5; i++) {
        assert.equal(proxy(apiRequest('bad-key', '127.0.0.1')).status, 401, `attempt ${i}`)
      }
      assert.equal(
        proxy(apiRequest('bad-key', '127.0.0.1')).status,
        429,
        'the bad-key client must really be locked out, or this proves nothing',
      )

      const good = proxy(apiRequest('top-secret', '127.0.0.1'))
      assert.equal(good.status, 200, 'the correct key must never be answered with 429')
    })
  })

  it('still locks out a client that keeps presenting a bad key', () => {
    inProduction(() => {
      for (let i = 0; i < 5; i++) {
        assert.equal(proxy(apiRequest('bad-key')).status, 401, `attempt ${i}`)
      }

      const locked = proxy(apiRequest('bad-key'))
      assert.equal(locked.status, 429)
      assert.ok(Number(locked.headers.get('retry-after')) > 0)
    })
  })

  it('gives a fresh attempt budget once the lockout window has passed', () => {
    // The count used to only reset on a successful auth, which a locked-out
    // bucket can never reach — so the first miss after a lockout expired
    // re-locked the bucket immediately, forever.
    inProduction(() => {
      for (let i = 0; i < 5; i++) proxy(apiRequest('bad-key'))
      assert.equal(proxy(apiRequest('bad-key')).status, 429)

      // Wind the clock forward past the window.
      const entry = rateLimitState().get('203.0.113.7')
      assert.ok(entry)
      const longAgo = Date.now() - 16 * 60 * 1000
      entry.lockedUntil = longAgo
      entry.lastFailureAt = longAgo

      assert.equal(proxy(apiRequest('bad-key')).status, 401, 'first miss after the window must not re-lock')
      assert.equal(proxy(apiRequest('bad-key')).status, 401, 'the budget must have reset, not resumed at 5')
    })
  })

  it('does not exempt a spoofable loopback X-Forwarded-For from the limit', () => {
    // getClientIp trusts x-forwarded-for, so a loopback exemption would be an
    // opt-out any remote client could ask for by setting one header.
    inProduction(() => {
      for (let i = 0; i < 5; i++) proxy(apiRequest('bad-key', '127.0.0.1'))
      assert.equal(proxy(apiRequest('bad-key', '127.0.0.1')).status, 429)
    })
  })
})
