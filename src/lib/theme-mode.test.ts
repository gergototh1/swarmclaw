import assert from 'node:assert/strict'
import test from 'node:test'

import { nextThemeMode, normalizeThemeMode, THEME_MODE_ORDER, type ThemeMode } from './theme-mode'

test('an absent or unrecognised stored mode means system, not dark', () => {
  assert.equal(normalizeThemeMode(undefined), 'system')
  assert.equal(normalizeThemeMode(null), 'system')
  assert.equal(normalizeThemeMode(''), 'system')
  assert.equal(normalizeThemeMode('sepia'), 'system')
  assert.equal(normalizeThemeMode(7), 'system')
})

test('a stored mode the user actually chose survives normalisation', () => {
  assert.equal(normalizeThemeMode('light'), 'light')
  assert.equal(normalizeThemeMode('dark'), 'dark')
  assert.equal(normalizeThemeMode('system'), 'system')
})

test('the rail button reaches every mode and returns to where it started', () => {
  let mode: ThemeMode = 'system'
  const walked: ThemeMode[] = []
  for (let i = 0; i < THEME_MODE_ORDER.length; i += 1) {
    mode = nextThemeMode(mode)
    walked.push(mode)
  }
  assert.deepEqual([...walked].sort(), ['dark', 'light', 'system'])
  assert.equal(mode, 'system', 'one full cycle returns to the starting mode')
})

test('the cycle is the declared order and skips nothing', () => {
  assert.equal(nextThemeMode('light'), 'dark')
  assert.equal(nextThemeMode('dark'), 'system')
  assert.equal(nextThemeMode('system'), 'light')
})

test('every mode in the cycle is one Settings also offers', () => {
  const settingsOffers: ThemeMode[] = ['light', 'dark', 'system']
  assert.deepEqual([...THEME_MODE_ORDER].sort(), [...settingsOffers].sort())
})
