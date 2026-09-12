import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldSaveOnModeSwitch } from '../ui/editor-dirty.ts'

test('a round-trip with no edits does not trigger a save, even though the text changed', () => {
  // This is the observed bug: TipTap's own markdown round-trip turns
  // `|---|---|` into `| --- | --- |` with nobody having typed a thing.
  assert.equal(shouldSaveOnModeSwitch(false, '| --- | --- |', '|---|---|'), false)
})

test('a real edit triggers a save', () => {
  assert.equal(shouldSaveOnModeSwitch(true, 'changed text', 'original text'), true)
})

test('an edit that nets no change does not trigger a save', () => {
  assert.equal(shouldSaveOnModeSwitch(true, 'same', 'same'), false)
})

test('no edit and no drift does not trigger a save', () => {
  assert.equal(shouldSaveOnModeSwitch(false, 'same', 'same'), false)
})
