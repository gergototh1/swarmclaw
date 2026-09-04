import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { shouldOpenExternally } from './external-navigation'

const APP = 'http://127.0.0.1:4321'

describe('desktop external navigation routing', () => {
  it('sends a navigation off the app origin to the system browser', () => {
    // The consent screen is the reason this exists: Google answers an in-app
    // click on /api/oauth/google/start with a 302 to accounts.google.com, and
    // refuses to render it inside Electron.
    assert.equal(shouldOpenExternally('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', APP), true)
    assert.equal(shouldOpenExternally('https://swarmclaw.ai/docs', APP), true)
  })

  it('leaves navigation within the app in the app window', () => {
    assert.equal(shouldOpenExternally(APP, APP), false)
    assert.equal(shouldOpenExternally(`${APP}/x/aisignal?connected=1`, APP), false)
    assert.equal(shouldOpenExternally(`${APP}/api/oauth/google/start?purpose=aisignal`, APP), false)
  })

  it('does not treat a longer port as the app origin', () => {
    // A startsWith test on the app url would let this through as in-app.
    assert.equal(shouldOpenExternally('http://127.0.0.1:43210/steal', APP), true)
    assert.equal(shouldOpenExternally('http://127.0.0.1.evil.example/steal', APP), true)
  })

  it('distinguishes host and scheme, not just the path', () => {
    assert.equal(shouldOpenExternally('https://127.0.0.1:4321/x', APP), true)
    assert.equal(shouldOpenExternally('http://localhost:4321/x', APP), true)
  })

  it('refuses to externalise anything it cannot read as a web origin', () => {
    // Left to Electron's own handling rather than turned into a shell request.
    assert.equal(shouldOpenExternally('about:blank', APP), false)
    assert.equal(shouldOpenExternally('file:///etc/passwd', APP), false)
    assert.equal(shouldOpenExternally('javascript:alert(1)', APP), false)
    assert.equal(shouldOpenExternally('not a url', APP), false)
    assert.equal(shouldOpenExternally('https://accounts.google.com', 'not a url'), false)
  })
})
