import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readArray, readBoolean, readEnum, readString, readWholeNumber } from '../src/args.mjs'
import { GmailError, HIBA_KODOK, guard, refuse } from '../src/hibak.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

/**
 * Source with its comments removed, so the grep below reads code and not the
 * prose that talks about the code -- this file's own doc comments name
 * `refuse(` several times.
 *
 * Block comments go, and so do lines that begin with `//`. A `/*` inside a
 * string literal would confuse this and no file in `src/` has one; a `//`
 * inside a string (a URL) is left alone precisely because whole lines rather
 * than trailing text are dropped.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

/** Runs a reader and returns the GmailError it threw, failing the test when it did not throw one. */
function refused(fn) {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof GmailError, `expected a GmailError, got ${err}`)
    return err
  }
  return assert.fail('expected a refusal')
}

// --- the error set ---

test('the error set is frozen, has no duplicates, and every code but the host s own carries the gmail_ prefix', () => {
  assert.ok(Object.isFrozen(HIBA_KODOK))
  assert.equal(new Set(HIBA_KODOK).size, HIBA_KODOK.length, 'a code is listed twice')
  const idegen = HIBA_KODOK.filter((code) => !code.startsWith('gmail_'))
  // Exactly one, and it is the host's own string rather than a spelling this
  // module chose: renaming it would mean the module and the host describe one
  // situation with two words, and the operator searches for the host's.
  assert.deepEqual(idegen, ['google_oauth_client_missing'])
})

test('the twelve inherited codes keep the spelling AI Signal s stored rows already carry', () => {
  // These are not this module's to respell. Stored sweep rows, a shipped page
  // and a 57-case suite in the aisignal extension speak them today, and a
  // rename here would make rows that are already on disk unreadable.
  for (const code of [
    'gmail_token_missing', 'gmail_scope_missing', 'gmail_label_missing', 'gmail_list_failed',
    'gmail_fetch_failed', 'gmail_profile_failed', 'gmail_timeout', 'gmail_unexpected',
    'gmail_token_invalid', 'gmail_token_unreadable', 'gmail_token_revoked', 'gmail_refresh_failed',
  ]) {
    assert.ok(HIBA_KODOK.includes(code), `${code} is missing from HIBA_KODOK`)
  }
})

test('every code literal in src/ is in the error set, and no refusal hides its code behind an expression', () => {
  // A grep rather than a runtime check, so a typo fails at the moment it is
  // written rather than at the moment a caller tries to branch on it. Two
  // literal forms carry a code in this module: the first argument of `refuse`,
  // and the `code = '...'` default of an argument reader that passes one
  // through. Both are collected; both have to be in the set.
  const sites = []
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs'))) {
    const source = stripComments(fs.readFileSync(path.join(SRC, name), 'utf8'))
    for (const hit of source.matchAll(/\brefuse\(\s*'([^']*)'/g)) sites.push({ name, code: hit[1], where: 'refuse()' })
    for (const hit of source.matchAll(/\bcode\s*=\s*'([^']*)'/g)) sites.push({ name, code: hit[1], where: "code = '...'" })
    // The one non-literal first argument this convention allows is the readers'
    // own `code` pass-through, whose default was collected above. Anything else
    // would be a code no reader of this module could enumerate.
    for (const hit of source.matchAll(/\brefuse\(\s*([^,\s)]+)/g)) {
      if (hit[1].startsWith("'")) continue
      assert.equal(hit[1], 'code', `${name}: refuse() takes a literal code or the pass-through 'code' option, not ${hit[1]}`)
    }
  }
  assert.ok(sites.length > 0, 'no code literals found; the grep is not looking where it thinks it is')
  for (const site of sites) {
    assert.ok(HIBA_KODOK.includes(site.code), `${site.name}: ${site.where} names '${site.code}', which is not in HIBA_KODOK`)
  }
})

test('guard turns a refusal into an error object, spreads extra beside it, and rethrows anything else', async () => {
  assert.deepEqual(await guard(() => 'ok'), 'ok')
  assert.deepEqual(
    await guard(() => refuse('gmail_cimzett_ismeretlen', 'ismeretlen cimzett-handle: dorina', { handle: 'dorina' })),
    { error: { code: 'gmail_cimzett_ismeretlen', message: 'ismeretlen cimzett-handle: dorina', handle: 'dorina' } },
  )
  // A bug in this module is not a refusal: it propagates, so the host's
  // failure counter sees it instead of a caller reading a crash as a designed
  // answer.
  await assert.rejects(() => guard(() => { throw new TypeError('boom') }), TypeError)
})

test('guard maps a host contract failure onto one named code and carries the reason as why', async () => {
  // Nothing in this module consumes a contract today, so nothing reaches this
  // branch on this checkout. It is pinned because the alternative to a code is
  // an uncoded throw the moment this module ever does consume one.
  const contractError = Object.assign(new Error('mailbox is not available'), {
    code: 'provider_disabled', extensionId: 'valami.mjs', consumerId: 'gmail.mjs', reason: 'provider_disabled',
  })
  assert.deepEqual(await guard(() => { throw contractError }), {
    error: { code: 'gmail_szerzodes_hiba', message: 'mailbox is not available', extension: 'valami.mjs', why: 'provider_disabled' },
  })
})

// --- readString ---

test('readString: absent means no opinion, a good value comes back, and a present bad one is refused by name', () => {
  assert.equal(readString('targy', undefined), undefined)
  assert.equal(readString('targy', null), undefined)
  assert.equal(readString('targy', 'Havi jelentes'), 'Havi jelentes')
  assert.match(refused(() => readString('targy', 42)).message, /^targy szoveg kell legyen, nem number$/)
  assert.equal(refused(() => readString('targy', 42)).code, 'gmail_argumentum_alak')
  assert.match(refused(() => readString('targy', ['a'])).message, /nem array$/)
})

test('readString: a value over max is refused, not cut, and the refusal names the bound', () => {
  assert.equal(readString('torzs', 'abcde', { max: 5 }), 'abcde')
  const err = refused(() => readString('torzs', 'abcdef', { max: 5, code: 'gmail_szoveg_tul_hosszu' }))
  assert.equal(err.code, 'gmail_szoveg_tul_hosszu')
  assert.match(err.message, /legfeljebb 5 karakter lehet, 6 erkezett/)
  // The refusal names the length, never the text: the text was written by a
  // stranger and a message that quoted it would carry that text onward as if
  // it were this module's own words.
  assert.ok(!err.message.includes('abcdef'))
})

test('readString: a blank is absent for required and is returned as sent otherwise', () => {
  assert.equal(readString('targy', ''), '')
  assert.equal(readString('targy', '   '), '   ')
  assert.match(refused(() => readString('targy', '  ', { required: true })).message, /nem lehet ures/)
  assert.match(refused(() => readString('targy', undefined, { required: true })).message, /kotelezo/)
})

// --- readEnum ---

test('readEnum: absent takes the fallback, a member comes back, a non-member is refused with the whole list', () => {
  assert.equal(readEnum('allapot', undefined, ['piszkozat', 'kiadva'], { fallback: 'piszkozat' }), 'piszkozat')
  assert.equal(readEnum('allapot', '', ['piszkozat', 'kiadva'], { fallback: 'piszkozat' }), 'piszkozat')
  assert.equal(readEnum('allapot', undefined, ['piszkozat']), undefined)
  assert.equal(readEnum('allapot', 'kiadva', ['piszkozat', 'kiadva']), 'kiadva')
  const err = refused(() => readEnum('allapot', 'archivalt', ['piszkozat', 'kiadva'], { code: 'gmail_allapot_ismeretlen' }))
  assert.equal(err.code, 'gmail_allapot_ismeretlen')
  assert.match(err.message, /piszkozat, kiadva/)
  // The list is named so a caller that misspelt a member can see what it may
  // send; what it did send is not echoed back.
  assert.ok(!err.message.includes('archivalt'))
  assert.match(refused(() => readEnum('allapot', 7, ['piszkozat'])).message, /piszkozat/)
})

// --- readWholeNumber ---

test('readWholeNumber: absent takes the fallback, a whole number comes back, a non-number is refused', () => {
  assert.equal(readWholeNumber('max', undefined, { min: 1, max: 500, fallback: 50 }), 50)
  assert.equal(readWholeNumber('max', null, { min: 1, max: 500, fallback: 50 }), 50)
  assert.equal(readWholeNumber('max', '', { min: 1, max: 500, fallback: 50 }), 50)
  assert.equal(readWholeNumber('max', 120, { min: 1, max: 500, fallback: 50 }), 120)
  assert.equal(readWholeNumber('max', '120', { min: 1, max: 500, fallback: 50 }), 120)
  // `true` is 1 and `[5]` is 5 to `Number`, and a caller that sent either made
  // a mistake this reader must not hide.
  assert.match(refused(() => readWholeNumber('max', true, { min: 1, max: 500, fallback: 50 })).message, /nem boolean$/)
  assert.match(refused(() => readWholeNumber('max', [5], { min: 1, max: 500, fallback: 50 })).message, /nem array$/)
})

test('readWholeNumber: above max is CAPPED and below min is REFUSED, which is the module s one asymmetry', () => {
  // Capping is honest exactly here: a page cut short is reported by the
  // listing's own `complete` field, so a caller that asked for 5000 and got
  // 500 can still tell a truncated page from a small one.
  assert.equal(readWholeNumber('max', 5000, { min: 1, max: 500, fallback: 50 }), 500)
  assert.equal(readWholeNumber('max', '9007199254740991', { min: 1, max: 500, fallback: 50 }), 500)
  // Below the floor buys nothing by being guessed at.
  assert.match(refused(() => readWholeNumber('max', 0, { min: 1, max: 500, fallback: 50 })).message, /legalabb 1/)
  assert.match(refused(() => readWholeNumber('max', -3, { min: 1, max: 500, fallback: 50 })).message, /legalabb 1/)
  assert.match(refused(() => readWholeNumber('max', 2.5, { min: 1, max: 500, fallback: 50 })).message, /legalabb 1/)
  // isSafeInteger rather than isInteger, so 1e21 cannot pass as a whole number
  // and reach SQLite as one.
  refused(() => readWholeNumber('offset', 1e21, { min: 0, fallback: 0 }))
})

test('readWholeNumber: with no max nothing is capped, and a missing min is a bug at the call site, not a refusal', () => {
  assert.equal(readWholeNumber('offset', 900, { min: 0, fallback: 0 }), 900)
  assert.throws(() => readWholeNumber('offset', 5, { fallback: 0 }), /needs a numeric min bound/)
  assert.throws(() => readWholeNumber('offset', 5, { min: 0, max: 'sok', fallback: 0 }), /needs max to be a number/)
})

// --- readArray ---

test('readArray: absent yields the empty list, a list comes back, and a value over max is refused', () => {
  assert.deepEqual(readArray('labelIds', undefined), [])
  assert.deepEqual(readArray('labelIds', null), [])
  assert.deepEqual(readArray('labelIds', ''), [])
  assert.deepEqual(readArray('labelIds', []), [])
  assert.deepEqual(readArray('labelIds', ['INBOX', 'UNREAD']), ['INBOX', 'UNREAD'])
  assert.match(refused(() => readArray('cimzettHandlek', undefined, { required: true })).message, /kotelezo/)
  const err = refused(() => readArray('cimzettHandlek', ['a', 'b', 'c'], { max: 2 }))
  assert.match(err.message, /legfeljebb 2 elem lehet, 3 erkezett/)
})

test('readArray: a string is REFUSED rather than wrapped, which is the bug this reader exists for', () => {
  // Wrapping 'INBOX' into ['INBOX'] looks helpful right up to the caller that
  // sends 'INBOX,UNREAD': iterating that string yields its characters, the
  // query then carries one label filter per letter, and Gmail answers an empty
  // list rather than an error. A false "no mail" is exactly the answer this
  // module must never produce.
  const err = refused(() => readArray('labelIds', 'INBOX,UNREAD'))
  assert.equal(err.code, 'gmail_argumentum_alak')
  assert.equal(err.message, 'labelIds tomb kell legyen, nem string')
  assert.match(refused(() => readArray('labelIds', { 0: 'INBOX' })).message, /nem object$/)
  assert.match(refused(() => readArray('labelIds', 7)).message, /nem number$/)
})

// --- readBoolean ---

test('readBoolean: absent takes the fallback, a boolean comes back, and a stringy one is refused', () => {
  assert.equal(readBoolean('elo', undefined, { fallback: false }), false)
  assert.equal(readBoolean('elo', null, { fallback: true }), true)
  assert.equal(readBoolean('elo', true, { fallback: false }), true)
  assert.equal(readBoolean('elo', false, { fallback: true }), false)
  // 'false' is truthy, so the coercion every shortcut reaches for would turn
  // "no" into "yes".
  assert.match(refused(() => readBoolean('elo', 'false', { fallback: true })).message, /true vagy false kell legyen/)
  assert.match(refused(() => readBoolean('elo', 1, { fallback: true })).message, /nem number$/)
})
