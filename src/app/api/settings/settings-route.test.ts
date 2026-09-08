import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('settings route persists valid theme mode and normalizes invalid values to system', () => {
  const output = runWithTempDataDir<{
    lightMode: string | null
    invalidMode: string | null
  }>(`
    const routeMod = await import('./src/app/api/settings/route')
    const route = routeMod.default || routeMod

    await route.PUT(new Request('http://local/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeMode: 'light' }),
    }))
    const lightResponse = await route.GET()
    const lightSettings = await lightResponse.json()

    await route.PUT(new Request('http://local/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeMode: 'sepia' }),
    }))
    const invalidResponse = await route.GET()
    const invalidSettings = await invalidResponse.json()

    console.log(JSON.stringify({
      lightMode: lightSettings.themeMode || null,
      invalidMode: invalidSettings.themeMode || null,
    }))
  `, { prefix: 'swarmclaw-settings-theme-mode-' })

  assert.equal(output.lightMode, 'light')
  // 'system' rather than 'dark': an unrecognised or absent stored mode has to
  // mean "follow the OS", or the provider's defaultTheme never gets a chance --
  // GET always returns whatever this normalises to, and the shell replays it.
  assert.equal(output.invalidMode, 'system')
})
