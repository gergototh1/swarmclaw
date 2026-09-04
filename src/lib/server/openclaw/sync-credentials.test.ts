import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

/**
 * `pushCredentialsToOpenClaw` decrypts every credential and writes the plaintext
 * to `auth-profiles.json`, and `POST /api/openclaw/sync` reaches it with
 * `{action:'push', types:['credentials']}`. A Google refresh token is a
 * long-lived key to the user's mailbox and must not travel that route.
 *
 * Each case runs in a subprocess with its own data dir and its own workspace, so
 * nothing here can touch a real `~/.openclaw`. The token values are obvious
 * dummies.
 */
describe('openclaw credential push', () => {
  it('leaves google oauth refresh tokens out of the pushed auth profiles', () => {
    const out = runWithTempDataDir<{
      written: boolean; keys: string[]; leaked: boolean; openaiValue: string
    }>(`
      process.env.OPENCLAW_STATE_DIR = process.env.WORKSPACE_DIR
      const fs = await import('node:fs')
      const path = await import('node:path')
      const repoMod = await import('@/lib/server/credentials/credential-repository'); const repo = repoMod.default || repoMod
      const syncMod = await import('@/lib/server/openclaw/sync'); const sync = syncMod.default || syncMod

      const now = Date.now()
      const store = (id, provider, name, secret) => repo.saveCredential(id, {
        id, provider, name, encryptedKey: repo.encryptKey(secret), createdAt: now,
      })
      store('cred-openai', 'openai', 'OpenAI', 'dummy-openai-api-key')
      store('google-oauth:aisignal', 'google-oauth', 'aisignal', 'dummy-refresh-token-aisignal')
      store('google-oauth:other', 'google-oauth', 'other', 'dummy-refresh-token-other')

      const result = sync.pushCredentialsToOpenClaw()
      const file = path.join(String(process.env.OPENCLAW_STATE_DIR), 'auth-profiles.json')
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      const profiles = JSON.parse(text || '{}')
      console.log(JSON.stringify({
        written: result.written,
        keys: Object.keys(profiles).sort(),
        leaked: text.includes('dummy-refresh-token'),
        openaiValue: profiles.openai || '',
      }))
    `)
    assert.equal(out.written, true)
    // Both google rows share the provider 'google-oauth', so an unfiltered push
    // would also have collapsed them onto one key and passed it on as an api key.
    assert.deepEqual(out.keys, ['openai'], 'only real api-key providers belong in auth-profiles.json')
    assert.equal(out.leaked, false, 'a google refresh token must never be written to the workspace')
    assert.equal(out.openaiValue, 'dummy-openai-api-key', 'the push still carries genuine api keys')
  })

  it('writes no auth profiles file at all when google oauth is the only credential', () => {
    const out = runWithTempDataDir<{ written: boolean; exists: boolean }>(`
      process.env.OPENCLAW_STATE_DIR = process.env.WORKSPACE_DIR
      const fs = await import('node:fs')
      const path = await import('node:path')
      const repoMod = await import('@/lib/server/credentials/credential-repository'); const repo = repoMod.default || repoMod
      const syncMod = await import('@/lib/server/openclaw/sync'); const sync = syncMod.default || syncMod

      repo.saveCredential('google-oauth:aisignal', {
        id: 'google-oauth:aisignal', provider: 'google-oauth', name: 'aisignal',
        encryptedKey: repo.encryptKey('dummy-refresh-token-aisignal'), createdAt: Date.now(),
      })

      const result = sync.pushCredentialsToOpenClaw()
      const file = path.join(String(process.env.OPENCLAW_STATE_DIR), 'auth-profiles.json')
      console.log(JSON.stringify({ written: result.written, exists: fs.existsSync(file) }))
    `)
    assert.equal(out.written, false)
    assert.equal(out.exists, false, 'an excluded credential must not even create the file')
  })
})
