import assert from 'node:assert/strict'
import test from 'node:test'

import { errorText } from '../ui/api.ts'

/**
 * A host rpc route-ja (`src/app/api/extensions/[id]/call/[method]/route.ts`,
 * `rpcFailure`) `{ error: { code, message }, message }` alakban válaszol.
 * Ha `errorText` csak a string `error`-t ismeri fel, minden nevesített hiba
 * eltűnik, és a felhasználó csak egy HTTP státuszkódot lát.
 */

test('errorText kiolvassa az objektum error.message-et', () => {
  const body = { error: { code: 'not_found', message: 'crm_ismeretlen_ugyfel' }, message: 'crm_ismeretlen_ugyfel' }
  assert.equal(errorText(body), 'crm_ismeretlen_ugyfel')
})

test('errorText a régi string error alakot is felismeri', () => {
  assert.equal(errorText({ error: 'crm_ismeretlen_esemeny' }), 'crm_ismeretlen_esemeny')
})

test('errorText a felső szintű message-re esik vissza, ha az error objektumban nincs message', () => {
  const body = { error: { code: 'internal' }, message: 'valami elromlott' }
  assert.equal(errorText(body), 'valami elromlott')
})

test('errorText üres stringet ad, ha semmi nevesíthető nincs a válaszban', () => {
  assert.equal(errorText(null), '')
  assert.equal(errorText(undefined), '')
  assert.equal(errorText({}), '')
  assert.equal(errorText({ error: {} }), '')
  assert.equal(errorText('crm_ismeretlen_ugyfel'), '')
})
