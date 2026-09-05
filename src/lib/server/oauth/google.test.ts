import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

/**
 * Every case runs in a subprocess with its own data dir, because the pending
 * state and the access-token cache are module-level maps: two cases in one
 * process would see each other's states. `fetchImpl` is injected everywhere —
 * no test reaches Google, and no real refresh token exists to leak.
 */
describe('google oauth', () => {
  it('builds a desktop auth url on the request origin and round-trips the callback into a credential', () => {
    const out = runWithTempDataDir<{ url: string; purpose: string; token: string; revoked: string }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'desktop'
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID = 'desk-id'
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET = 'desk-secret'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const { url, state } = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'http://127.0.0.1:4321', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] })
      const calls = []
      const fetchImpl = async (u, init) => {
        calls.push(String(u))
        const body = new URLSearchParams(String(init.body))
        if (body.get('grant_type') === 'authorization_code') return new Response(JSON.stringify({ refresh_token: 'rt-1', access_token: 'at-0', expires_in: 3600 }), { status: 200 })
        if (body.get('refresh_token') === 'rt-1') return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200 })
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }
      const { purpose } = await g.handleGoogleCallback({ code: 'c', state, fetchImpl })
      const token = await g.getGoogleAccessToken('aisignal', fetchImpl)
      let revoked = ''
      try { await g.getGoogleAccessToken('other', fetchImpl) } catch (e) { revoked = e.message }
      console.log(JSON.stringify({ url, purpose, token, revoked }))
    `)
    assert.match(out.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    assert.match(out.url, /client_id=desk-id/)
    assert.match(out.url, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A4321%2Fapi%2Foauth%2Fgoogle%2Fcallback/)
    assert.match(out.url, /access_type=offline/)
    assert.equal(out.purpose, 'aisignal'); assert.equal(out.token, 'at-1'); assert.equal(out.revoked, 'gmail_token_missing')
  })

  it('rejects an unknown or reused state', () => {
    const out = runWithTempDataDir<{ e1: string; e2: string }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const fetchImpl = async () => new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 1 }), { status: 200 })
      let e1 = ''; try { await g.handleGoogleCallback({ code: 'c', state: 'nope', fetchImpl }) } catch (e) { e1 = e.message }
      const { state } = g.buildGoogleAuthUrl({ purpose: 'p', origin: 'https://h', scopes: [] })
      await g.handleGoogleCallback({ code: 'c', state, fetchImpl })
      let e2 = ''; try { await g.handleGoogleCallback({ code: 'c', state, fetchImpl }) } catch (e) { e2 = e.message }
      console.log(JSON.stringify({ e1, e2 }))
    `)
    assert.equal(out.e1, 'oauth_state_invalid'); assert.equal(out.e2, 'oauth_state_invalid')
  })

  it('rejects a state that has outlived its ten minute window', () => {
    // Clock moved rather than waited on: the expiry is real wall-clock time.
    const out = runWithTempDataDir<{ error: string }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const { state } = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      const realNow = Date.now
      Date.now = () => realNow() + 11 * 60 * 1000
      let error = ''
      try {
        await g.handleGoogleCallback({ code: 'c', state, fetchImpl: async () => new Response('{}', { status: 200 }) })
      } catch (e) { error = e.message } finally { Date.now = realNow }
      console.log(JSON.stringify({ error }))
    `)
    assert.equal(out.error, 'oauth_state_invalid')
  })

  it('keeps two pending purposes apart so a state can only land on the purpose it was minted for', () => {
    const out = runWithTempDataDir<{ first: string; second: string; ids: string[] }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const repo = await import('@/lib/server/credentials/credential-repository')
      const { loadCredentials } = repo.default || repo
      const a = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      const b = g.buildGoogleAuthUrl({ purpose: 'other', origin: 'https://h', scopes: [] })
      const fetchImpl = async () => new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 60 }), { status: 200 })
      const second = (await g.handleGoogleCallback({ code: 'c', state: b.state, fetchImpl })).purpose
      const first = (await g.handleGoogleCallback({ code: 'c', state: a.state, fetchImpl })).purpose
      console.log(JSON.stringify({ first, second, ids: Object.keys(loadCredentials()).sort() }))
    `)
    assert.equal(out.first, 'aisignal')
    assert.equal(out.second, 'other')
    assert.deepEqual(out.ids, ['google-oauth:aisignal', 'google-oauth:other'])
  })

  it('binds the exchange to the pkce verifier the auth url advertised', () => {
    const out = runWithTempDataDir<{ challenge: string; method: string; verifierMatches: boolean }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'desktop'; process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID = 'd'; process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET = 's'
      const crypto = await import('node:crypto')
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const { url, state } = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      const params = new URL(url).searchParams
      let verifier = ''
      const fetchImpl = async (_u, init) => {
        verifier = new URLSearchParams(String(init.body)).get('code_verifier') || ''
        return new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 60 }), { status: 200 })
      }
      await g.handleGoogleCallback({ code: 'c', state, fetchImpl })
      const derived = crypto.createHash('sha256').update(verifier).digest('base64url')
      console.log(JSON.stringify({
        challenge: params.get('code_challenge') || '',
        method: params.get('code_challenge_method') || '',
        verifierMatches: Boolean(verifier) && derived === params.get('code_challenge'),
      }))
    `)
    assert.match(out.challenge, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(out.method, 'S256')
    assert.equal(out.verifierMatches, true)
  })

  it('refuses a consent that came back without a refresh token and leaves the stored one alone', () => {
    const out = runWithTempDataDir<{ error: string; token: string }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const withRefresh = async () => new Response(JSON.stringify({ refresh_token: 'rt-good', access_token: 'a', expires_in: 60 }), { status: 200 })
      const first = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      await g.handleGoogleCallback({ code: 'c', state: first.state, fetchImpl: withRefresh })

      const second = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      let error = ''
      try {
        await g.handleGoogleCallback({ code: 'c', state: second.state, fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a2', expires_in: 60 }), { status: 200 }) })
      } catch (e) { error = e.message }

      let token = ''
      const echoRefresh = async (_u, init) => {
        const sent = new URLSearchParams(String(init.body)).get('refresh_token') || ''
        return new Response(JSON.stringify({ access_token: 'seen:' + sent, expires_in: 60 }), { status: 200 })
      }
      token = await g.getGoogleAccessToken('aisignal', echoRefresh)
      console.log(JSON.stringify({ error, token }))
    `)
    assert.equal(out.error, 'gmail_token_missing')
    assert.equal(out.token, 'seen:rt-good')
  })

  it('reports a revoked grant distinctly from a refresh that merely failed', () => {
    const out = runWithTempDataDir<{ revoked: string; failed: string }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const connect = async (purpose) => {
        const { state } = g.buildGoogleAuthUrl({ purpose, origin: 'https://h', scopes: [] })
        await g.handleGoogleCallback({ code: 'c', state, fetchImpl: async () => new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 60 }), { status: 200 }) })
      }
      await connect('revoked'); await connect('broken')
      let revoked = ''
      try { await g.getGoogleAccessToken('revoked', async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 })) } catch (e) { revoked = e.message }
      let failed = ''
      try { await g.getGoogleAccessToken('broken', async () => new Response('upstream exploded', { status: 500 })) } catch (e) { failed = e.message }
      console.log(JSON.stringify({ revoked, failed }))
    `)
    assert.equal(out.revoked, 'gmail_token_revoked')
    assert.equal(out.failed, 'gmail_refresh_failed')
  })

  it('collapses concurrent refreshes for one purpose into a single token request', () => {
    const out = runWithTempDataDir<{ tokens: string[]; refreshCalls: number; cachedCalls: number }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const { state } = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      await g.handleGoogleCallback({ code: 'c', state, fetchImpl: async () => new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 60 }), { status: 200 }) })

      let refreshCalls = 0
      const slowRefresh = async () => {
        refreshCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 25))
        return new Response(JSON.stringify({ access_token: 'at-shared', expires_in: 3600 }), { status: 200 })
      }
      const tokens = await Promise.all([
        g.getGoogleAccessToken('aisignal', slowRefresh),
        g.getGoogleAccessToken('aisignal', slowRefresh),
        g.getGoogleAccessToken('aisignal', slowRefresh),
      ])
      const afterConcurrent = refreshCalls
      await g.getGoogleAccessToken('aisignal', slowRefresh)
      console.log(JSON.stringify({ tokens, refreshCalls: afterConcurrent, cachedCalls: refreshCalls }))
    `)
    assert.deepEqual(out.tokens, ['at-shared', 'at-shared', 'at-shared'])
    assert.equal(out.refreshCalls, 1)
    assert.equal(out.cachedCalls, 1, 'a live cached token must not trigger a fourth request')
  })

  it('does not leave a failed refresh in flight, so the next call retries', () => {
    const out = runWithTempDataDir<{ first: string; second: string; calls: number }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const { state } = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      await g.handleGoogleCallback({ code: 'c', state, fetchImpl: async () => new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 60 }), { status: 200 }) })
      let calls = 0
      const flaky = async () => {
        calls += 1
        if (calls === 1) return new Response('nope', { status: 503 })
        return new Response(JSON.stringify({ access_token: 'at-retry', expires_in: 3600 }), { status: 200 })
      }
      let first = ''
      try { await g.getGoogleAccessToken('aisignal', flaky) } catch (e) { first = e.message }
      const second = await g.getGoogleAccessToken('aisignal', flaky)
      console.log(JSON.stringify({ first, second, calls }))
    `)
    assert.equal(out.first, 'gmail_refresh_failed')
    assert.equal(out.second, 'at-retry')
    assert.equal(out.calls, 2)
  })

  it('keeps the Task 7 error contract when no client id is configured', () => {
    const out = runWithTempDataDir<{ resolveError: string; name: string; message: string; has: boolean }>(`
      delete process.env.SWARMCLAW_DEPLOY_MODE
      delete process.env.GOOGLE_OAUTH_CLIENT_WEB_ID
      delete process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET
      delete process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID
      delete process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      let resolveError = ''
      try { g.resolveGoogleClient() } catch (e) { resolveError = e.message }
      let name = ''; let message = ''
      try { await g.getGoogleAccessToken('aisignal', async () => new Response('{}', { status: 200 })) } catch (e) { name = e.name; message = e.message }
      console.log(JSON.stringify({ resolveError, name, message, has: g.hasGoogleCredential('aisignal') }))
    `)
    assert.equal(out.resolveError, 'google_oauth_client_missing')
    assert.equal(out.name, 'GoogleOAuthNotConfiguredError')
    assert.match(out.message, /not configured/i)
    assert.equal(out.has, false)
  })

  it('reports a configured client per deploy mode, and only from that mode\'s own pair', () => {
    // One subprocess for every combination on purpose: the predicate reads the
    // environment on each call, so mutating it between calls is exactly the
    // operator editing their env file, and a cached answer would show up here.
    const out = runWithTempDataDir<{
      desktopBoth: boolean; desktopIdOnly: boolean; desktopSecretOnly: boolean
      desktopFromWebPair: boolean; desktopBlank: boolean
      vpsBoth: boolean; vpsIdOnly: boolean; vpsSecretOnly: boolean; vpsFromDesktopPair: boolean
      neither: boolean
    }>(`
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const clear = () => {
        delete process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID
        delete process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET
        delete process.env.GOOGLE_OAUTH_CLIENT_WEB_ID
        delete process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET
      }

      process.env.SWARMCLAW_DEPLOY_MODE = 'desktop'
      clear(); const neither = g.isGoogleClientConfigured()
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID = 'desk-id'
      const desktopIdOnly = g.isGoogleClientConfigured()
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET = 'desk-secret'
      const desktopBoth = g.isGoogleClientConfigured()
      clear()
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET = 'desk-secret'
      const desktopSecretOnly = g.isGoogleClientConfigured()
      clear()
      // A whitespace-only value is a variable an operator set and left empty.
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID = '   '
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET = 'desk-secret'
      const desktopBlank = g.isGoogleClientConfigured()
      clear()
      process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'web-id'
      process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 'web-secret'
      const desktopFromWebPair = g.isGoogleClientConfigured()

      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'
      const vpsBoth = g.isGoogleClientConfigured()
      clear()
      process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'web-id'
      const vpsIdOnly = g.isGoogleClientConfigured()
      clear()
      process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 'web-secret'
      const vpsSecretOnly = g.isGoogleClientConfigured()
      clear()
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID = 'desk-id'
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET = 'desk-secret'
      const vpsFromDesktopPair = g.isGoogleClientConfigured()

      console.log(JSON.stringify({
        desktopBoth, desktopIdOnly, desktopSecretOnly, desktopFromWebPair, desktopBlank,
        vpsBoth, vpsIdOnly, vpsSecretOnly, vpsFromDesktopPair, neither,
      }))
    `)
    assert.equal(out.desktopBoth, true)
    assert.equal(out.vpsBoth, true)
    // Half a pair is not a client: consent would fail at the token exchange
    // instead of at the button, which is the later, more confusing place.
    assert.equal(out.desktopIdOnly, false)
    assert.equal(out.desktopSecretOnly, false)
    assert.equal(out.desktopBlank, false)
    assert.equal(out.vpsIdOnly, false)
    assert.equal(out.vpsSecretOnly, false)
    assert.equal(out.neither, false)
    // The pairs are not interchangeable. A Web client cannot serve a desktop
    // build's varying loopback port, so borrowing the other mode's pair would
    // enable a button that can only fail.
    assert.equal(out.desktopFromWebPair, false)
    assert.equal(out.vpsFromDesktopPair, false)
  })

  it('separates a missing client from a missing credential, which hasGoogleCredential alone cannot', () => {
    const out = runWithTempDataDir<{ configuredNoCredential: boolean; hasCredential: boolean; noClient: boolean }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'
      process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'web-id'
      process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 'web-secret'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const configuredNoCredential = g.isGoogleClientConfigured()
      const hasCredential = g.hasGoogleCredential('gmail')
      delete process.env.GOOGLE_OAUTH_CLIENT_WEB_ID
      delete process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET
      console.log(JSON.stringify({ configuredNoCredential, hasCredential, noClient: g.isGoogleClientConfigured() }))
    `)
    // Both facts are false-looking through hasGoogleCredential; only one of
    // them is fixed by pressing connect.
    assert.equal(out.hasCredential, false)
    assert.equal(out.configuredNoCredential, true)
    assert.equal(out.noClient, false)
  })

  it('picks the web client pair in vps mode and reports the credential once stored', () => {
    const out = runWithTempDataDir<{ mode: string; clientId: string; hasBefore: boolean; hasAfter: boolean }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'
      process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'web-id'
      process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 'web-secret'
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_ID = 'desk-id'
      process.env.GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET = 'desk-secret'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const client = g.resolveGoogleClient()
      const hasBefore = g.hasGoogleCredential('aisignal')
      const { state } = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://app.example.com', scopes: [] })
      let sentClientId = ''
      await g.handleGoogleCallback({ code: 'c', state, fetchImpl: async (_u, init) => {
        sentClientId = new URLSearchParams(String(init.body)).get('client_id') || ''
        return new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 60 }), { status: 200 })
      } })
      console.log(JSON.stringify({ mode: client.mode, clientId: sentClientId, hasBefore, hasAfter: g.hasGoogleCredential('aisignal') }))
    `)
    assert.equal(out.mode, 'vps')
    assert.equal(out.clientId, 'web-id')
    assert.equal(out.hasBefore, false)
    assert.equal(out.hasAfter, true)
  })

  it('never stores the refresh token in the clear', () => {
    const out = runWithTempDataDir<{ raw: string; decrypted: string; provider: string; name: string }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const repo = await import('@/lib/server/credentials/credential-repository')
      const { loadCredential, decryptKey } = repo.default || repo
      const { state } = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      await g.handleGoogleCallback({ code: 'c', state, fetchImpl: async () => new Response(JSON.stringify({ refresh_token: 'super-secret-refresh', access_token: 'a', expires_in: 60 }), { status: 200 }) })
      const cred = loadCredential('google-oauth:aisignal')
      console.log(JSON.stringify({ raw: String(cred.encryptedKey), decrypted: decryptKey(cred.encryptedKey), provider: cred.provider, name: cred.name }))
    `)
    assert.doesNotMatch(out.raw, /super-secret-refresh/)
    assert.match(out.raw, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)
    assert.equal(out.decrypted, 'super-secret-refresh')
    assert.equal(out.provider, 'google-oauth')
    assert.equal(out.name, 'aisignal')
  })

  it('stops handing out a cached access token as soon as the credential is deleted', () => {
    // A Google access token stays valid for about an hour, so a cache consulted
    // before the credential store would keep the mailbox readable for that long
    // after the user pressed disconnect.
    const out = runWithTempDataDir<{
      before: string; after: string; deleted: boolean; refreshCalls: number; has: boolean
    }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const svcMod = await import('@/lib/server/credentials/credential-service'); const svc = svcMod.default || svcMod
      const { state } = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      await g.handleGoogleCallback({ code: 'c', state, fetchImpl: async () => new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 3600 }), { status: 200 }) })

      let refreshCalls = 0
      const refresh = async () => {
        refreshCalls += 1
        return new Response(JSON.stringify({ access_token: 'at-live', expires_in: 3600 }), { status: 200 })
      }
      const before = await g.getGoogleAccessToken('aisignal', refresh)
      const deleted = svc.deleteCredentialRecord('google-oauth:aisignal')
      let after = ''
      try { after = await g.getGoogleAccessToken('aisignal', refresh) } catch (e) { after = 'threw:' + e.message }
      console.log(JSON.stringify({ before, after, deleted, refreshCalls, has: g.hasGoogleCredential('aisignal') }))
    `)
    assert.equal(out.before, 'at-live')
    assert.equal(out.deleted, true)
    assert.equal(out.after, 'threw:gmail_token_missing', 'a deleted credential must not be served from the access-token cache')
    assert.equal(out.refreshCalls, 1, 'the second call must fail on the missing credential, not send the deleted token to Google')
    assert.equal(out.has, false)
  })

  it('reports a rejected authorization code as its own failure, not as a revoked token', () => {
    // On an exchange `invalid_grant` means the code expired, was replayed, or
    // the two redirect_uri strings differed. Telling a first-time user to
    // re-grant access they never granted sends them nowhere.
    const out = runWithTempDataDir<{ exchange: string; refresh: string }>(`
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'; process.env.GOOGLE_OAUTH_CLIENT_WEB_ID = 'w'; process.env.GOOGLE_OAUTH_CLIENT_WEB_SECRET = 's'
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const invalidGrant = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })

      const stale = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      let exchange = ''
      try { await g.handleGoogleCallback({ code: 'stale-code', state: stale.state, fetchImpl: invalidGrant }) } catch (e) { exchange = e.message }

      const good = g.buildGoogleAuthUrl({ purpose: 'aisignal', origin: 'https://h', scopes: [] })
      await g.handleGoogleCallback({ code: 'c', state: good.state, fetchImpl: async () => new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 1 }), { status: 200 }) })
      let refresh = ''
      try { await g.getGoogleAccessToken('aisignal', invalidGrant) } catch (e) { refresh = e.message }
      console.log(JSON.stringify({ exchange, refresh }))
    `)
    assert.equal(out.exchange, 'oauth_code_invalid')
    assert.notEqual(out.exchange, 'gmail_token_revoked')
    // The refresh keeps the meaning it always had.
    assert.equal(out.refresh, 'gmail_token_revoked')
  })

  it('prefers a configured public origin over the Host header, and ignores a value that is not one', () => {
    const out = runWithTempDataDir<{
      configured: string; trailingSlash: string; withPath: string
      badScheme: string; blank: string; unset: string
    }>(`
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const at = (url, headers) => {
        const req = new Request(url)
        for (const [k, v] of Object.entries(headers || {})) req.headers.set(k, v)
        return g.resolveCallbackOrigin(req)
      }
      // nginx's default proxy_pass sends the upstream address as Host.
      const upstream = { host: '10.0.0.7:3456' }
      const set = (value) => { process.env.SWARMCLAW_PUBLIC_ORIGIN = value }
      set('https://app.example.com'); const configured = at('http://0.0.0.0:3456/api/oauth/google/start', upstream)
      set('https://app.example.com/'); const trailingSlash = at('http://0.0.0.0:3456/api/oauth/google/start', upstream)
      set('https://app.example.com/base'); const withPath = at('http://0.0.0.0:3456/api/oauth/google/start', { host: 'app.fallback.example' })
      set('ftp://app.example.com'); const badScheme = at('http://0.0.0.0:3456/api/oauth/google/start', { host: 'app.fallback.example' })
      set('   '); const blank = at('http://0.0.0.0:3456/api/oauth/google/start', { host: 'app.fallback.example' })
      delete process.env.SWARMCLAW_PUBLIC_ORIGIN
      const unset = at('http://0.0.0.0:3456/api/oauth/google/start', { host: 'app.fallback.example' })
      console.log(JSON.stringify({ configured, trailingSlash, withPath, badScheme, blank, unset }))
    `)
    assert.equal(out.configured, 'https://app.example.com')
    assert.equal(out.trailingSlash, 'https://app.example.com')
    // A half-usable value is ignored rather than trimmed into something else.
    assert.equal(out.withPath, 'http://app.fallback.example')
    assert.equal(out.badScheme, 'http://app.fallback.example')
    assert.equal(out.blank, 'http://app.fallback.example')
    assert.equal(out.unset, 'http://app.fallback.example')
  })

  it('ignores a configured public origin in desktop mode, where the loopback port changes every launch', () => {
    // A stray SWARMCLAW_PUBLIC_ORIGIN in a desktop user's environment would
    // otherwise build the redirect URI on someone else's origin, and the
    // loopback callback would never come back to this process.
    const out = runWithTempDataDir<{ desktop: string; vps: string; defaultMode: string }>(`
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const at = () => {
        const req = new Request('http://127.0.0.1:4321/api/oauth/google/start')
        req.headers.set('host', '127.0.0.1:4321')
        return g.resolveCallbackOrigin(req)
      }
      process.env.SWARMCLAW_PUBLIC_ORIGIN = 'https://app.example.com'
      process.env.SWARMCLAW_DEPLOY_MODE = 'desktop'
      const desktop = at()
      process.env.SWARMCLAW_DEPLOY_MODE = 'vps'
      const vps = at()
      delete process.env.SWARMCLAW_DEPLOY_MODE
      const defaultMode = at()
      console.log(JSON.stringify({ desktop, vps, defaultMode }))
    `)
    assert.equal(out.desktop, 'http://127.0.0.1:4321')
    // The vps path, and the vps default, are unchanged.
    assert.equal(out.vps, 'https://app.example.com')
    assert.equal(out.defaultMode, 'https://app.example.com')
  })

  it('builds the callback origin from the Host header and the forwarded scheme, not from what the server was started as', () => {
    // Next composes request.url from the *configured* hostname, which is
    // 0.0.0.0 in the Docker image. Only the Host header carries the public one.
    const out = runWithTempDataDir<{
      noHostHeader: string; dockerBind: string; tlsTerminated: string
      spoofedForwardedHost: string; junkProto: string; junkHost: string; hostWithPath: string
    }>(`
      const gm = await import('@/lib/server/oauth/google'); const g = gm.default || gm
      const at = (url, headers) => {
        const req = new Request(url)
        for (const [k, v] of Object.entries(headers || {})) req.headers.set(k, v)
        return g.resolveCallbackOrigin(req)
      }
      console.log(JSON.stringify({
        noHostHeader: at('http://127.0.0.1:4321/api/oauth/google/start'),
        dockerBind: at('http://0.0.0.0:3456/api/oauth/google/start', { host: 'app.example.com' }),
        tlsTerminated: at('http://0.0.0.0:3456/api/oauth/google/start', { host: 'app.example.com', 'x-forwarded-proto': 'https' }),
        spoofedForwardedHost: at('http://0.0.0.0:3456/api/oauth/google/start', { host: 'app.example.com', 'x-forwarded-host': 'evil.example' }),
        junkProto: at('http://0.0.0.0:3456/api/oauth/google/start', { host: 'app.example.com', 'x-forwarded-proto': 'javascript' }),
        junkHost: at('http://127.0.0.1:4321/api/oauth/google/start', { host: 'not a host' }),
        hostWithPath: at('http://127.0.0.1:4321/api/oauth/google/start', { host: 'evil.example/app.example.com' }),
      }))
    `)
    assert.equal(out.noHostHeader, 'http://127.0.0.1:4321')
    assert.equal(out.dockerBind, 'http://app.example.com')
    assert.equal(out.tlsTerminated, 'https://app.example.com')
    assert.equal(out.spoofedForwardedHost, 'http://app.example.com')
    assert.equal(out.junkProto, 'http://app.example.com')
    // Unparseable authority falls back to the request URL rather than to junk.
    assert.equal(out.junkHost, 'http://127.0.0.1:4321')
    assert.equal(out.hostWithPath, 'http://127.0.0.1:4321')
  })
})
