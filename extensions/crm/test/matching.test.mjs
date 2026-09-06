import assert from 'node:assert/strict'
import test from 'node:test'

import { matchMessage, SOCIAL_DOMAINS } from '../src/matching.mjs'

/** Egy hívható `lookups` a megadott adatokból. Nincs adatbázis. */
function lookupsOf({ emails = {}, threads = {}, domains = {} } = {}) {
  return {
    contactByEmail: (a) => emails[String(a).toLowerCase()] || null,
    accountIdByThread: (t) => threads[t] || null,
    accountsByDomain: (d) => domains[d] || [],
  }
}

const ESETEK = [
  {
    nev: '1. lepes: pontos cim egyezes nyer mindent',
    msg: { fromEmail: 'Dorina@Morvai.HU', threadId: 't1' },
    lookups: {
      emails: { 'dorina@morvai.hu': { id: 'con_1', accountId: 'acc_1' } },
      threads: { t1: 'acc_MASIK' },
      domains: { 'morvai.hu': ['acc_HARMADIK'] },
    },
    vart: { kind: 'exact', accountId: 'acc_1', contactId: 'con_1' },
  },
  {
    nev: '1. lepes: ismert cim, de a kapcsolat meg nincs ugyfelhez kotve',
    msg: { fromEmail: 'x@y.hu', threadId: 't9' },
    lookups: { emails: { 'x@y.hu': { id: 'con_2', accountId: null } } },
    vart: { kind: 'none' },
  },
  {
    nev: '2. lepes: a szal korabbi uzenete mar be van sorolva',
    msg: { fromEmail: 'ismeretlen@gmail.com', threadId: 't2' },
    lookups: { threads: { t2: 'acc_2' } },
    vart: { kind: 'thread', accountId: 'acc_2' },
  },
  {
    nev: '2. lepes elkapja a szal kozbeni cimvaltast',
    msg: { fromEmail: 'dorina.maganemail@gmail.com', threadId: 't3' },
    lookups: {
      threads: { t3: 'acc_3' },
      domains: { 'gmail.com': ['acc_SOHA'] },
    },
    vart: { kind: 'thread', accountId: 'acc_3' },
  },
  {
    nev: '3. lepes: domain-egyezes csak TIPPET ad, nem besorolast',
    msg: { fromEmail: 'konyveles@morvai.hu', threadId: 't4' },
    lookups: { domains: { 'morvai.hu': ['acc_4'] } },
    vart: { kind: 'guess', guessAccountId: 'acc_4' },
  },
  {
    nev: '3. lepes: kozossegi domainre SOHA nem tippel',
    msg: { fromEmail: 'valaki@gmail.com', threadId: 't5' },
    lookups: { domains: { 'gmail.com': ['acc_5'] } },
    vart: { kind: 'none' },
  },
  {
    nev: '3. lepes: ket ugyfel ugyanazon a domainen -> nincs tipp',
    msg: { fromEmail: 'uj@kozos.hu', threadId: 't6' },
    lookups: { domains: { 'kozos.hu': ['acc_a', 'acc_b'] } },
    vart: { kind: 'none' },
  },
  {
    nev: '4. lepes: semmi nem talal',
    msg: { fromEmail: 'senki@sehol.hu', threadId: 't7' },
    lookups: {},
    vart: { kind: 'none' },
  },
  {
    nev: 'hianyzo felado nem borit fel semmit',
    msg: { fromEmail: '', threadId: 't8' },
    lookups: { threads: { t8: 'acc_8' } },
    vart: { kind: 'thread', accountId: 'acc_8' },
  },
]

for (const e of ESETEK) {
  test(e.nev, () => {
    const eredmeny = matchMessage(e.msg, lookupsOf(e.lookups))
    for (const [k, v] of Object.entries(e.vart)) {
      assert.equal(eredmeny[k], v, `${k}: ${eredmeny[k]} !== ${v}`)
    }
  })
}

test('a kozossegi domainek listaja tartalmazza a magyar szolgaltatokat is', () => {
  for (const d of ['gmail.com', 'freemail.hu', 'citromail.hu', 'outlook.com', 'yahoo.com', 'icloud.com']) {
    assert.ok(SOCIAL_DOMAINS.has(d), `hianyzik: ${d}`)
  }
})
