import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

/**
 * Route-level cases. `globalThis.fetch` is replaced in the subprocess so the
 * handlers, which take no `fetchImpl` of their own, still never reach Google.
 */

const DESKTOP_ENV = `
  process.env.SWARMCLAW_DEPLOY_MODE = 'desktop'
  process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID = 'desk-id'
  process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET = 'desk-secret'
  delete process.env.GOOGLE_OAUTH_CLIENT_WEB_ID
  delete process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET
`

const LOAD_ROUTES = `
  const startMod = await import('@/app/api/oauth/google/start/route')
  const callbackMod = await import('@/app/api/oauth/google/callback/route')
  const start = (startMod.default || startMod).GET
  const callback = (callbackMod.default || callbackMod).GET
`

describe('GET /api/oauth/google/start', () => {
  it('redirects to Google with a redirect uri on the loopback origin and port the request arrived on', () => {
    const out = runWithTempDataDir<{ status: number; location: string; secondLocation: string }>(`
      ${DESKTOP_ENV}
      ${LOAD_ROUTES}
      const first = await start(new Request('http://127.0.0.1:4321/api/oauth/google/start?purpose=aisignal'))
      // Same build, different port: the desktop server picks a free one each launch.
      const second = await start(new Request('http://127.0.0.1:5555/api/oauth/google/start?purpose=aisignal'))
      console.log(JSON.stringify({
        status: first.status,
        location: first.headers.get('location') || '',
        secondLocation: second.headers.get('location') || '',
      }))
    `)
    assert.equal(out.status, 302)
    assert.match(out.location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    assert.match(out.location, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A4321%2Fapi%2Foauth%2Fgoogle%2Fcallback/)
    assert.match(out.location, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fgmail\.readonly/)
    assert.match(out.secondLocation, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A5555%2Fapi%2Foauth%2Fgoogle%2Fcallback/)
  })

  it('builds the vps redirect uri from the Host header, not from the 0.0.0.0 the container binds', () => {
    // Next composes request.url as protocol://<configured hostname>:<port>, and
    // the Docker image starts with HOSTNAME=0.0.0.0. A redirect uri built from
    // that would be rejected by Google outright.
    const out = runWithTempDataDir<{ location: string }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'
      process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'web-id'
      process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 'web-secret'
      ${LOAD_ROUTES}
      const req = new Request('http://0.0.0.0:3456/api/oauth/google/start?purpose=aisignal')
      req.headers.set('host', 'app.example.com')
      req.headers.set('x-forwarded-proto', 'https')
      req.headers.set('x-forwarded-host', 'evil.example')
      const res = await start(req)
      console.log(JSON.stringify({ location: res.headers.get('location') || '' }))
    `)
    assert.match(out.location, /client_id=web-id/)
    assert.match(out.location, /redirect_uri=https%3A%2F%2Fapp\.example\.com%2Fapi%2Foauth%2Fgoogle%2Fcallback/)
    assert.doesNotMatch(out.location, /evil\.example/)
    assert.doesNotMatch(out.location, /0\.0\.0\.0/)
  })

  it('refuses a purpose it has no scope list for, including inherited object keys', () => {
    const out = runWithTempDataDir<{ missing: number; unknown: number; inherited: number; body: string }>(`
      ${DESKTOP_ENV}
      ${LOAD_ROUTES}
      const call = async (query) => start(new Request('http://127.0.0.1:4321/api/oauth/google/start' + query))
      const missing = await call('')
      const unknown = await call('?purpose=gmail-full-access')
      const inherited = await call('?purpose=constructor')
      console.log(JSON.stringify({
        missing: missing.status, unknown: unknown.status, inherited: inherited.status,
        body: (await unknown.json()).error,
      }))
    `)
    assert.equal(out.missing, 400)
    assert.equal(out.unknown, 400)
    assert.equal(out.inherited, 400)
    assert.equal(out.body, 'unknown purpose')
  })

  it('says the client is missing rather than redirecting nowhere useful', () => {
    const out = runWithTempDataDir<{ status: number; error: string }>(`
      delete process.env.SWARMCLAW_DEPLOY_MODE
      delete process.env.GOOGLE_OAUTH_CLIENT_WEB_ID
      delete process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET
      delete process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID
      delete process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET
      ${LOAD_ROUTES}
      const res = await start(new Request('http://127.0.0.1:4321/api/oauth/google/start?purpose=aisignal'))
      console.log(JSON.stringify({ status: res.status, error: (await res.json()).error }))
    `)
    assert.equal(out.status, 500)
    assert.equal(out.error, 'google_oauth_client_missing')
  })
})

describe('GET /api/oauth/google/callback', () => {
  it('stores the credential and sends the browser back to the extension page', () => {
    const out = runWithTempDataDir<{ status: number; location: string; ids: string[]; body: string }>(`
      ${DESKTOP_ENV}
      ${LOAD_ROUTES}
      const repo = await import('@/lib/server/credentials/credential-repository')
      const { loadCredentials } = repo.default || repo
      globalThis.fetch = async () => new Response(JSON.stringify({ refresh_token: 'rt-1', access_token: 'at-0', expires_in: 3600 }), { status: 200 })

      const started = await start(new Request('http://127.0.0.1:4321/api/oauth/google/start?purpose=aisignal'))
      const state = new URL(started.headers.get('location')).searchParams.get('state')
      const res = await callback(new Request('http://127.0.0.1:4321/api/oauth/google/callback?code=auth-code&state=' + encodeURIComponent(state)))
      console.log(JSON.stringify({
        status: res.status,
        location: res.headers.get('location') || '',
        ids: Object.keys(loadCredentials()),
        body: await res.text(),
      }))
    `)
    assert.equal(out.status, 302)
    assert.equal(out.location, 'http://127.0.0.1:4321/x/aisignal?connected=1')
    assert.deepEqual(out.ids, ['google-oauth:aisignal'])
    // The refresh token must not ride back out on the response in any form.
    assert.doesNotMatch(out.body, /rt-1/)
    assert.doesNotMatch(out.location, /rt-1/)
  })

  it('reports a denied consent as a denial, not as a missing parameter', () => {
    const out = runWithTempDataDir<{ denied: string; deniedStatus: number; odd: string }>(`
      ${DESKTOP_ENV}
      ${LOAD_ROUTES}
      const at = (query) => callback(new Request('http://127.0.0.1:4321/api/oauth/google/callback' + query))
      const denied = await at('?error=access_denied&state=whatever')
      const odd = await at('?error=' + encodeURIComponent('<script>alert(1)</script>'))
      console.log(JSON.stringify({
        denied: (await denied.json()).error, deniedStatus: denied.status, odd: (await odd.json()).error,
      }))
    `)
    assert.equal(out.deniedStatus, 400)
    assert.equal(out.denied, 'access_denied')
    assert.equal(out.odd, 'oauth_consent_failed')
  })

  it('rejects a callback with no state, an unknown state, or a replayed one', () => {
    const out = runWithTempDataDir<{ bare: string; unknown: string; replayed: string; firstStatus: number }>(`
      ${DESKTOP_ENV}
      ${LOAD_ROUTES}
      globalThis.fetch = async () => new Response(JSON.stringify({ refresh_token: 'rt-1', access_token: 'at-0', expires_in: 3600 }), { status: 200 })
      const at = (query) => callback(new Request('http://127.0.0.1:4321/api/oauth/google/callback' + query))

      const bare = await at('?code=auth-code')
      const unknown = await at('?code=auth-code&state=not-a-real-state')

      const started = await start(new Request('http://127.0.0.1:4321/api/oauth/google/start?purpose=aisignal'))
      const state = new URL(started.headers.get('location')).searchParams.get('state')
      const first = await at('?code=auth-code&state=' + encodeURIComponent(state))
      const replayed = await at('?code=auth-code&state=' + encodeURIComponent(state))

      console.log(JSON.stringify({
        bare: (await bare.json()).error,
        unknown: (await unknown.json()).error,
        replayed: (await replayed.json()).error,
        firstStatus: first.status,
      }))
    `)
    assert.equal(out.bare, 'oauth_callback_missing_params')
    assert.equal(out.unknown, 'oauth_state_invalid')
    assert.equal(out.firstStatus, 302)
    assert.equal(out.replayed, 'oauth_state_invalid')
  })
})
