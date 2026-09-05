import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { AJTOK, KIMENO_ALLAPOTOK, MAX_KISERLET_MIT, MIGRATIONS, canonicalJson, createRepo, sha256, torzsHashOf } from '../src/db.mjs'
import { memStorage } from './helpers.mjs'

function fresh() {
  const storage = memStorage()
  for (const m of MIGRATIONS) storage.raw.exec(m.sql)
  return { storage, repo: createRepo(storage) }
}

/** A draft row as the outbound layer will open one: the hash is computed, never supplied. */
function piszkozatRow(over = {}) {
  const cimek = over.cimek || ['dorina@example.test']
  const targy = over.targy || 'Havi jelentes'
  const torzs = over.torzs || 'Szia, itt a jelentes.'
  return {
    allapot: 'piszkozat',
    ajto: 'szerzodes',
    cimzettHandlek: over.handlek || ['dorina'],
    cimzettCimek: cimek,
    valaszUzenetId: over.valaszUzenetId || '',
    targy,
    torzs,
    torzsHash: torzsHashOf({ cimek, targy, torzs }),
  }
}

// --- the schema itself ---

test('every migration table uses the ext_gmail_ prefix', () => {
  for (const m of MIGRATIONS) {
    for (const t of m.sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) assert.match(t[1], /^ext_gmail_/)
    for (const i of m.sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)) assert.match(i[1], /^ext_gmail_/)
  }
})

test('the key list in db.mjs names every primary key and every unique index the schema actually has', () => {
  // The header calls itself "the whole key set: every primary key, every index,
  // and every lookup and every column that is read as one". That claim is what
  // a later reader trusts instead of reading the DDL, and on the AI Signal
  // module the entry that had gone stale was twice the one that mattered, so it
  // is pinned rather than believed: a key with no entry, or an entry whose
  // columns have drifted from the schema, fails here.
  const forras = fs.readFileSync(new URL('../src/db.mjs', import.meta.url), 'utf8')
  const kezdet = forras.indexOf('EVERY KEY IN THIS SCHEMA')
  const veg = forras.indexOf('export const MIGRATIONS')
  assert.ok(kezdet > 0 && veg > kezdet)
  const lista = forras.slice(kezdet, veg)
  const { storage } = fresh()
  const tablak = storage.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_gmail_%' ORDER BY name").map((r) => r.name)
  assert.deepEqual(tablak, ['ext_gmail_cimzettek', 'ext_gmail_kimeno', 'ext_gmail_kiserletek', 'ext_gmail_napi'])
  for (const tabla of tablak) {
    const pk = storage.all(`PRAGMA table_info(${tabla})`).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
    assert.ok(pk.length > 0, `${tabla} has no primary key`)
    assert.ok(lista.includes(`${tabla} -- PRIMARY KEY (${pk.join(', ')})`), `${tabla}: PRIMARY KEY (${pk.join(', ')}) is missing from the key list`)
    for (const idx of storage.all(`PRAGMA index_list(${tabla})`)) {
      const oszlopok = storage.all(`PRAGMA index_info(${idx.name})`).map((c) => c.name)
      // SQLite backs a non-integer PRIMARY KEY with an auto-index; that one is
      // the primary key already checked above, not a second key.
      if (idx.name.startsWith('sqlite_autoindex_') && oszlopok.join(', ') === pk.join(', ')) continue
      assert.ok(lista.includes(`${tabla} -- INDEX (${oszlopok.join(', ')})`), `${tabla}: INDEX (${oszlopok.join(', ')}) is missing from the key list`)
    }
  }
  // The two columns the list calls gates, and the one it calls reporting, are
  // named as such: a reviewer reads those three sentences instead of the DDL.
  assert.ok(lista.includes('ext_gmail_kimeno.torzs_hash -- a column read as a key'))
  assert.ok(lista.includes('ext_gmail_kimeno.allapot -- a column read as a key'))
  assert.match(lista, /ext_gmail_kiserletek -- PRIMARY KEY \(id\)\n \*     gates   NOTHING/)
})

test('the two closed vocabularies are frozen and say what the schema stores', () => {
  assert.ok(Object.isFrozen(KIMENO_ALLAPOTOK) && Object.isFrozen(AJTOK))
  // Five, not four: a send that was asked for and not answered is neither
  // `kiadva` nor `hiba`, and calling it either would be a false report about the
  // one operation in this module that cannot be taken back.
  assert.deepEqual(KIMENO_ALLAPOTOK, ['piszkozat', 'kiadva', 'elvetve', 'hiba', 'bizonytalan'])
  // The door, not the caller. No verifiable caller identity reaches this
  // module, so there are exactly two values and each is a constant in one file.
  assert.deepEqual(AJTOK, ['szerzodes', 'rpc'])
})

// --- the fingerprint ---

test('canonicalJson sorts object keys, keeps array order, and renders undefined as null', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }))
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.notEqual(canonicalJson(['a', 'b']), canonicalJson(['b', 'a']))
  assert.equal(canonicalJson({ a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1}}')
  assert.equal(canonicalJson(undefined), 'null')
  assert.equal(canonicalJson(null), 'null')
  assert.equal(canonicalJson('x'), '"x"')
})

test('torzsHashOf is order independent on the addresses and sensitive to every one of the three values', () => {
  const a = torzsHashOf({ cimek: ['b@example.test', 'a@example.test'], targy: 'T', torzs: 'B' })
  const b = torzsHashOf({ cimek: ['a@example.test', 'b@example.test'], targy: 'T', torzs: 'B' })
  // One set of recipients has one fingerprint however it was ordered:
  // re-reading the draft out of Gmail returns them in an order this module did
  // not choose, and without the sort every multi-recipient release would be
  // refused as stale.
  assert.equal(a, b)
  assert.notEqual(a, torzsHashOf({ cimek: ['a@example.test'], targy: 'T', torzs: 'B' }))
  assert.notEqual(a, torzsHashOf({ cimek: ['b@example.test', 'a@example.test'], targy: 'T2', torzs: 'B' }))
  assert.notEqual(a, torzsHashOf({ cimek: ['b@example.test', 'a@example.test'], targy: 'T', torzs: 'B ' }))
  assert.equal(a, sha256(canonicalJson({ cimek: ['a@example.test', 'b@example.test'], targy: 'T', torzs: 'B' })))
})

test('torzsHashOf does not reorder the caller s array, and refuses a cimek that is not one', () => {
  const cimek = ['b@example.test', 'a@example.test']
  torzsHashOf({ cimek, targy: 'T', torzs: 'B' })
  assert.deepEqual(cimek, ['b@example.test', 'a@example.test'])
  assert.throws(() => torzsHashOf({ cimek: 'a@example.test', targy: 'T', torzs: 'B' }), /cimek to be an array/)
})

// --- key 1: the address book gates who a draft may be addressed to ---

test('the address book answers a retired entry as retired rather than as missing, so the two codes stay tellable apart', () => {
  const { repo } = fresh()
  assert.equal(repo.cimzett('dorina'), null)
  assert.equal(repo.eloCimzettCount(), 0)

  repo.addCimzett({ handle: 'dorina', cim: 'dorina@example.test', megjegyzes: 'a konyvelo' })
  assert.equal(repo.cimzett('dorina').cim, 'dorina@example.test')
  assert.equal(repo.cimzett('dorina').visszavonva_at, null)
  assert.equal(repo.eloCimzettCount(), 1)

  const retired = repo.retireCimzett('dorina')
  // The row STAYS: an outbound row that named this handle has to stay
  // readable. What changes is that it no longer counts as live, which is what
  // gates a new draft.
  assert.ok(retired.visszavonva_at)
  assert.equal(repo.cimzett('dorina').cim, 'dorina@example.test')
  assert.equal(repo.eloCimzettCount(), 0)

  // Retiring twice does not move the moment the operator actually withdrew it.
  const at = retired.visszavonva_at
  assert.equal(repo.retireCimzett('dorina').visszavonva_at, at)
  // A handle nobody ever added is null, not a blank row.
  assert.equal(repo.retireCimzett('nincs-ilyen'), null)
})

test('the killswitch: retiring every handle leaves no live recipient, without disabling the extension', () => {
  const { repo } = fresh()
  repo.addCimzett({ handle: 'dorina', cim: 'dorina@example.test' })
  repo.addCimzett({ handle: 'peter', cim: 'peter@example.test' })
  assert.equal(repo.eloCimzettCount(), 2)
  assert.equal(repo.cimzettek({ elo: true }).length, 2)
  repo.retireCimzett('dorina')
  repo.retireCimzett('peter')
  assert.equal(repo.eloCimzettCount(), 0)
  assert.deepEqual(repo.cimzettek({ elo: true }), [])
  // The whole book is still readable, so the page can show what was retired.
  assert.equal(repo.cimzettek().length, 2)
})

test('a handle already in the book hits the primary key rather than being silently upserted', () => {
  const { repo } = fresh()
  repo.addCimzett({ handle: 'dorina', cim: 'dorina@example.test' })
  // Reviving a retired handle is a decision for whoever can ask the operator,
  // not a silent ON CONFLICT DO UPDATE here.
  assert.throws(() => repo.addCimzett({ handle: 'dorina', cim: 'masik@example.test' }), /UNIQUE|PRIMARY/i)
  repo.retireCimzett('dorina')
  assert.throws(() => repo.addCimzett({ handle: 'dorina', cim: 'masik@example.test' }), /UNIQUE|PRIMARY/i)
  assert.equal(repo.cimzett('dorina').cim, 'dorina@example.test')
})

// --- key 2 and 3: the body hash gates the release, the state gates the second one ---

test('an outbound row is opened before the Gmail call, with no draft id, and the id arrives afterwards', () => {
  const { repo } = fresh()
  const { id } = repo.insertKimeno(piszkozatRow())
  const row = repo.kimeno(id)
  // The write order is what makes a half-made draft visible instead of
  // stranded: a row with no draft id is renderable and clearable, a draft in
  // Gmail that no row names is neither.
  assert.equal(row.gmail_draft_id, '')
  assert.equal(row.allapot, 'piszkozat')
  assert.equal(row.ajto, 'szerzodes')
  assert.equal(row.gmail_message_id, null)
  assert.equal(row.szerkesztve_at, null)
  assert.deepEqual(JSON.parse(row.cimzett_handlek), ['dorina'])
  assert.deepEqual(JSON.parse(row.cimzett_cimek), ['dorina@example.test'])
  assert.deepEqual(JSON.parse(row.cimzett_konyvon_kivul), [])

  repo.setKimenoDraftId(id, 'r-123')
  assert.equal(repo.kimeno(id).gmail_draft_id, 'r-123')
  assert.equal(repo.kimeno('nincs-ilyen'), null)
})

test('the stored hash is the fingerprint of what would go out, and an edit in Gmail moves both together', () => {
  const { repo } = fresh()
  const { id } = repo.insertKimeno(piszkozatRow())
  const eredeti = repo.kimeno(id).torzs_hash
  assert.equal(eredeti, torzsHashOf({ cimek: ['dorina@example.test'], targy: 'Havi jelentes', torzs: 'Szia, itt a jelentes.' }))

  // The operator edited the draft in their own client. That is not a refusal:
  // the credential lives only in this module, so the only hand that can have
  // done it is theirs. The row catches up and records that it happened.
  const cimek = ['dorina@example.test', 'peter@example.test']
  repo.markSzerkesztve(id, { targy: 'Havi jelentes v2', torzs: 'Mas szoveg.', cimzettCimek: cimek, torzsHash: torzsHashOf({ cimek, targy: 'Havi jelentes v2', torzs: 'Mas szoveg.' }) })
  const row = repo.kimeno(id)
  assert.notEqual(row.torzs_hash, eredeti)
  assert.equal(row.torzs_hash, torzsHashOf({ cimek, targy: row.targy, torzs: row.torzs }))
  assert.ok(row.szerkesztve_at)
  assert.equal(row.allapot, 'piszkozat', 'an edit does not close the row')
})

test('a release closes the row with the message id and the addresses that were not in the book', () => {
  const { repo } = fresh()
  const { id } = repo.insertKimeno(piszkozatRow())
  repo.setKimenoDraftId(id, 'r-123')
  repo.markKiadva(id, { gmailMessageId: 'm-9', konyvonKivul: ['idegen@example.test'], kiadvaAt: '2026-09-05T10:00:00.000Z' })
  const row = repo.kimeno(id)
  assert.equal(row.allapot, 'kiadva')
  assert.equal(row.gmail_message_id, 'm-9')
  assert.equal(row.kiadva_at, '2026-09-05T10:00:00.000Z')
  // Stored rather than refused: an address the operator typed into their own
  // mailbox is a decision, and only a person can tell that apart from one that
  // appeared without one. Storing it is what puts both in front of that person.
  assert.deepEqual(JSON.parse(row.cimzett_konyvon_kivul), ['idegen@example.test'])
})

test('the state column is the second-release gate, and this layer writes it without a guard on purpose', () => {
  const { repo } = fresh()
  const { id } = repo.insertKimeno(piszkozatRow())
  repo.markKiadva(id, { gmailMessageId: 'm-9' })
  assert.equal(repo.kimeno(id).allapot, 'kiadva')
  // The refusal for a second release belongs to the caller, which can say
  // `gmail_kimeno_allapot` by name. This layer writes unconditionally, so a
  // write that matched no row can never report success for something that did
  // not happen -- and a caller that skips the check overwrites rather than
  // being stopped here. The comment in db.mjs says exactly this, and this case
  // is what keeps the two in step.
  repo.markElvetve(id)
  assert.equal(repo.kimeno(id).allapot, 'elvetve')
})

test('a failed draft closes as an error with its code, so the page stops offering to release it', () => {
  const { repo } = fresh()
  const { id } = repo.insertKimeno(piszkozatRow())
  repo.setKimenoHiba(id, 'gmail_draft_failed', 'Gmail 503')
  const row = repo.kimeno(id)
  assert.equal(row.allapot, 'hiba')
  assert.equal(row.hiba_kod, 'gmail_draft_failed')
  assert.equal(row.hiba_szoveg, 'Gmail 503')
  assert.equal(row.gmail_draft_id, '', 'the row that never got a draft id is the one this state is for')
})

test('two identical drafts are two rows: nothing is keyed on the subject and body pair', () => {
  const { repo } = fresh()
  const a = repo.insertKimeno(piszkozatRow())
  const b = repo.insertKimeno(piszkozatRow())
  assert.notEqual(a.id, b.id)
  // Two drafts are two decisions for the operator. A quiet merge would take
  // away exactly the thing worth seeing, which is that something ran twice.
  assert.equal(repo.countKimeno({ allapot: 'piszkozat' }), 2)
  assert.equal(repo.kimeno(a.id).torzs_hash, repo.kimeno(b.id).torzs_hash)
})

test('the outbox pages and counts by state', () => {
  const { repo } = fresh()
  const first = repo.insertKimeno(piszkozatRow())
  repo.insertKimeno(piszkozatRow({ targy: 'Masodik' }))
  repo.markKiadva(first.id, { gmailMessageId: 'm-1' })
  assert.equal(repo.countKimeno(), 2)
  assert.equal(repo.countKimeno({ allapot: 'piszkozat' }), 1)
  assert.equal(repo.countKimeno({ allapot: 'kiadva' }), 1)
  assert.equal(repo.kimenok().length, 2)
  assert.equal(repo.kimenok({ allapot: 'kiadva' }).length, 1)
  assert.equal(repo.kimenok({ limit: 1 }).length, 1)
  assert.equal(repo.kimenok({ limit: 1, offset: 2 }).length, 0)
})

// --- the attempts table reports and gates nothing ---

test('a refused request becomes a row, and the raw text of the request is cut rather than refused', () => {
  const { repo } = fresh()
  repo.insertKiserlet({ ajto: 'rpc', kod: 'gmail_cimzett_cim_literal', mit: 'valaki@idegen.test' })
  repo.insertKiserlet({ ajto: 'szerzodes', kod: 'gmail_piszkozat_keret_kimerult', mit: 'x'.repeat(MAX_KISERLET_MIT + 500) })
  const rows = repo.kiserletek(10)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.kod).sort(), ['gmail_cimzett_cim_literal', 'gmail_piszkozat_keret_kimerult'])
  const hosszu = rows.find((r) => r.kod === 'gmail_piszkozat_keret_kimerult')
  // Cut, not refused: this text is not used for anything, it is a line the
  // operator reads to recognise the attempt, and declining to record the
  // longest attempts would be precisely backwards.
  assert.equal(hosszu.mit.length, MAX_KISERLET_MIT)
  assert.equal(repo.kiserletek(1).length, 1)
})

// --- key 4: the daily counters gate volume ---

test('bumpNapi creates the day s row on the first call and adds to it afterwards, one counter at a time', () => {
  const { repo } = fresh()
  // A day with no row reads as zeros, so the first call of a day is not a
  // missing-row special case at every caller.
  assert.deepEqual(repo.napi('2026-09-05'), { nap: '2026-09-05', piszkozat: 0, kiadas: 0 })

  assert.deepEqual(repo.bumpNapi('2026-09-05', 'piszkozat'), { nap: '2026-09-05', piszkozat: 1, kiadas: 0 })
  // The upsert is what makes two overlapping increments sum rather than
  // overwrite: the second call adds to the row the first one created instead of
  // replacing it, and it does not fail on the existing key either.
  assert.deepEqual(repo.bumpNapi('2026-09-05', 'piszkozat'), { nap: '2026-09-05', piszkozat: 2, kiadas: 0 })
  assert.deepEqual(repo.bumpNapi('2026-09-05', 'kiadas'), { nap: '2026-09-05', piszkozat: 2, kiadas: 1 })
  assert.deepEqual(repo.napi('2026-09-05'), { nap: '2026-09-05', piszkozat: 2, kiadas: 1 })

  // The two counters are separate because a draft and a release are two
  // different risks, and the day is separate because the key is the day.
  assert.deepEqual(repo.napi('2026-09-06'), { nap: '2026-09-06', piszkozat: 0, kiadas: 0 })
})

test('bumpNapi never interpolates a column name from its argument', () => {
  const { repo } = fresh()
  // A column name cannot be a bound parameter, so the only safe spelling is the
  // one where no caller-supplied byte reaches the SQL text at all: the field
  // chooses between two literal statements. An unknown field is a bug at the
  // call site rather than a caller problem, so it throws instead of refusing.
  assert.throws(() => repo.bumpNapi('2026-09-05', 'piszkozat = piszkozat + 100'), /unknown field/)
  assert.throws(() => repo.bumpNapi('2026-09-05', 'kiadas; DROP TABLE ext_gmail_napi'), /unknown field/)
  assert.deepEqual(repo.napi('2026-09-05'), { nap: '2026-09-05', piszkozat: 0, kiadas: 0 })
  assert.equal(repo.counts().cimzettek, 0, 'the table is still there')
})

test('counts reports what is stored', () => {
  const { repo } = fresh()
  repo.addCimzett({ handle: 'dorina', cim: 'dorina@example.test' })
  repo.addCimzett({ handle: 'peter', cim: 'peter@example.test' })
  repo.retireCimzett('peter')
  const a = repo.insertKimeno(piszkozatRow())
  repo.insertKimeno(piszkozatRow({ targy: 'Masodik' }))
  repo.markKiadva(a.id, { gmailMessageId: 'm-1' })
  repo.insertKiserlet({ ajto: 'rpc', kod: 'gmail_cimzett_ismeretlen', mit: 'nincs-ilyen' })
  assert.deepEqual(repo.counts(), {
    cimzettek: 2, eloCimzettek: 1, piszkozat: 1, kiadva: 1, elvetve: 0, hiba: 0, bizonytalan: 0, kiserletek: 1,
  })
})

test('an unknown send outcome is closed as neither sent nor failed, and keeps no receipt it does not have', () => {
  const { repo } = fresh()
  const { id } = repo.insertKimeno(piszkozatRow())
  repo.setKimenoDraftId(id, 'r-123')

  // The claim: written before the send is asked for, so a process that dies
  // mid-send leaves the state that is true of it.
  repo.markBizonytalan(id)
  assert.equal(repo.kimeno(id).allapot, 'bizonytalan')
  assert.equal(repo.kimeno(id).hiba_kod, '')

  // The second write adds the cause. The state does not change, because the
  // cause is what Gmail said and the state is what we know.
  repo.markBizonytalan(id, { kod: 'gmail_timeout', szoveg: 'a hatarido letelt' })
  const row = repo.kimeno(id)
  assert.equal(row.allapot, 'bizonytalan')
  assert.equal(row.hiba_kod, 'gmail_timeout')
  assert.equal(row.hiba_szoveg, 'a hatarido letelt')
  // Neither receipt of a send that is known to have happened is invented here.
  assert.equal(row.gmail_message_id, null)
  assert.equal(row.kiadva_at, null)
  assert.equal(repo.counts().bizonytalan, 1)
  assert.equal(repo.counts().hiba, 0, 'an unknown outcome is not counted as a failure')
  assert.equal(repo.counts().kiadva, 0, 'and it is not counted as a send either')
})
