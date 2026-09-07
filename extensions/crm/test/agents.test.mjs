import assert from 'node:assert/strict'
import test from 'node:test'

import crm from '../index.mjs'
import { AGENTS, SCHEDULES } from '../src/agents.mjs'

test('egy ugynok van deklaralva, es a manifest ot viszi', () => {
  assert.equal(AGENTS.length, 1)
  assert.equal(AGENTS[0].agentKey, 'crm-ugyfelkezelo')
  assert.deepEqual(crm.managedResources.agents, AGENTS)
})

test('a heartbeat KI van kapcsolva -- az utemezes hajtja', () => {
  assert.equal(AGENTS[0].heartbeatEnabled, false,
    'CLI-provideren a host minden betolteskor false-ra allitana; az utemezes az egyetlen mukodo ut')
})

test('a deklaracio NEM nevez meg mcpServerIds-t', () => {
  assert.equal('mcpServerIds' in AGENTS[0], false,
    'a szerver azonositoja telepitesenkent mas; az operator rendeli hozza')
})

test('a rutin az ugynokre hivatkozik es napi cronon fut', () => {
  assert.equal(SCHEDULES.length, 1)
  const s = SCHEDULES[0]
  assert.equal(s.agentRef.resourceKey, 'crm-ugyfelkezelo')
  assert.equal(s.scheduleType, 'cron')
  assert.match(s.cron, /^\d+ \d+ \* \* \*$/)
  assert.equal(s.timezone, 'Europe/Budapest')
})

test('a rutin promptja a crm_attention-t nevezi meg kiindulasnak', () => {
  assert.match(SCHEDULES[0].taskPrompt, /crm_attention/)
})

test('az ugynok promptja megtiltja a talalgatast', () => {
  assert.match(AGENTS[0].systemPrompt, /crm_attention/)
  assert.match(AGENTS[0].systemPrompt, /ne (talalgass|találgass)/i)
})

/**
 * I5: az `agent.tools` a hostnal capability-csoport azonositot VAGY egy
 * extension-fajlnevet vesz (`src/lib/capability-selection.ts`
 * `isExternalExtensionId`: `.js`/`.mjs` vegzodes), es a
 * `listScopedToolAccessExtensionIds` (`src/lib/server/universal-tool-access.ts`)
 * mindent CSENDBEN eldob, ami nincs ebben az univerzumban. A `crm_*`
 * tool-nevek egyike sem az; a CRM retegenek helyes irasmodja a telepitett
 * fajlnev, `crm.mjs`.
 */
test('a tools csak host altal ertelmezett erteket sorol -- tool-nevet nem', () => {
  for (const grant of AGENTS[0].tools) {
    assert.equal(/^crm_/.test(grant), false,
      `"${grant}" egy tool neve, nem host capability -- a host csendben eldobna`)
  }
  assert.ok(AGENTS[0].tools.includes('crm.mjs'),
    'a CRM reteget a telepitett extension fajlneve hozza, nem a benne lako toolok nevei')
})

/**
 * I4: a teszt targya az, hogy MINDEN megadott kepessegnek legyen megnevezett
 * ALKALMA a promptban -- nem az, hogy ket hardcode-olt nev szerepel benne. Az
 * `ALKALOM` terkep ezert a grant -> promptban kotelezoen megnevezett eszkozok
 * iranyt rogziti: egy uj grant (`execute`, `browser`) nem "csendben atmegy",
 * hanem elbukik, mert nincs bejegyzese.
 *
 * A CRM tool-nevei I5 ota nem a `tools`-ban allnak (ott a `crm.mjs` all), hanem
 * itt -- ez a helyuk: a `tools` a hostnak szol, ez a lista a promptnak.
 */
const ALKALOM = Object.freeze({
  'crm.mjs': ['crm_attention', 'crm_account', 'crm_timeline', 'crm_event_body', 'crm_search',
              'crm_summary_write', 'crm_commitment_write', 'crm_suggestion_write'],
  memory: ['memory_search', 'memory_update'],
})

test('minden granted tool-nak van megnevezett alkalma a promptban', () => {
  assert.ok(AGENTS[0].tools.length > 0, 'ures tools-listan a teszt semmit nem allitana')
  for (const grant of AGENTS[0].tools) {
    const alkalmak = ALKALOM[grant]
    assert.ok(alkalmak,
      `a(z) "${grant}" grantnak nincs megnevezett alkalma: vagy vedd ki a tools-bol, ` +
      'vagy ird meg a promptban, mikor hasznalja -- es vedd fel ide')
    assert.ok(alkalmak.length > 0, `a(z) "${grant}" bejegyzese ures, tehat semmit nem kovetel`)
    for (const nev of alkalmak) {
      assert.ok(AGENTS[0].systemPrompt.includes(nev),
        `a(z) "${nev}" eszkoznek meg kell jelennie a promptban, nem csak a grantban (grant: ${grant})`)
    }
  }
})
