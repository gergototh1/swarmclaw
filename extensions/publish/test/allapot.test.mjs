import assert from 'node:assert/strict'
import test from 'node:test'

import { kiadasAllapot } from '../src/allapot.mjs'

/**
 * Task 2's own tests, from the brief verbatim (task-2-brief.md 2.1) -- the
 * one rule the page, the scheduler and the report all ask, so it gets pinned
 * here once rather than reimplemented three times.
 */

const ag = (platform, allapot) => ({ platform, allapot })

test('minden összekötött ág kiment: kesz', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'kesz')]), 'kesz')
})
test('egy kiment, egy elbukott: reszben — és NEM kesz', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'hiba')]), 'reszben')
})
test('egyik sem ment ki: hiba', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'hiba'), ag('tiktok', 'hiba')]), 'hiba')
})
test('a fiók nélküli ág nem várakoztat és nem buktat', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'nincs_fiok')]), 'kesz')
})
test('EGYETLEN fiók sincs összekötve: nincs_hova, nem kesz', () => {
  // Ez a modul legrosszabb hazugsága lenne: nulla ágból nulla ment ki, tehát
  // a "minden ág kiment" ÜRESEN igaz, és a lap azt írná, publikálva van
  // valami, ami sehol nincs fent.
  assert.equal(kiadasAllapot([ag('youtube', 'nincs_fiok'), ag('tiktok', 'nincs_fiok')]), 'nincs_hova')
  assert.equal(kiadasAllapot([]), 'nincs_hova')
})
test('amíg bármelyik vár, a kiadás utemezve', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'var')]), 'utemezve')
})
