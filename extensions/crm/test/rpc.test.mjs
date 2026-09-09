import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createRpc } from '../src/rpc.mjs'
import { gmailFakeMailbox, memStorage } from './helpers.mjs'

function rpcOf() {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const state = { storage: S, repo: createRepo(S), settings: () => ({}), log: console }
  return { rpc: createRpc(state), repo: state.repo }
}

/** Ugyanaz, mint `rpcOf`, de a state-en van egy `contracts` dublőr, amit a hívó ad meg. */
function rpcWithContracts(contracts) {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const state = { storage: S, repo: createRepo(S), settings: () => ({}), log: console, contracts }
  return { rpc: createRpc(state), repo: state.repo }
}

/** Egy ideiglenes könyvtár, ami a tesztfuttatással együtt eltűnik. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crm-rpc-'))
}

/**
 * Egy port-fájl, amit a `hostFetch` élőnek fogad el: a JELEN teszt-folyamat
 * pid-je, és egy `startedAt`, ami a boot-tolerancián belülre esik. `elo:
 * false` egy olyat ír, ami a boot-idő ellenőrzésen elbukik -- lásd
 * `src/rpc.mjs` `portFajlElo`. Ugyanaz a minta, mint a testvér `gmail`
 * extension `test/rpc.test.mjs` `irPortFajlt`-je.
 */
function irPortFajlt(dir, { elo = true, pid = process.pid } = {}) {
  const file = path.join(dir, 'port.json')
  fs.writeFileSync(file, JSON.stringify({
    port: 3456,
    pid,
    startedAt: elo ? Date.now() : 0,
  }))
  return file
}

/**
 * A `/api/projects` GET egy sora, ahogy a host `findManagedProject`-je
 * (`src/lib/server/extension-managed-resources.ts`) illeszti: mindhárom mező
 * kell, `extensionId`, `resourceKind` és `resourceKey`, nem csak a
 * `resourceKey`.
 */
const projektSor = (id, extensionId, resourceKey, resourceKind = 'project') => ({
  id, managedByExtension: { extensionId, resourceKind, resourceKey },
})

test('a board egy hívásból adja a lap alapállapotát', async () => {
  const { rpc, repo } = rpcOf()
  repo.createAccount({ name: 'Morvai Kft.', status: 'client' })
  const board = await rpc.board({})
  assert.equal(board.accounts.length, 1)
  assert.deepEqual(board.unmatched, [])
  assert.deepEqual(board.suggestions, [])
})

test('az account-lap az összefoglaló frissességét is viszi', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
                     excerpt: 'e1', sourceSystem: 'manual', sourceId: 'n1' })
  repo.writeSummary({ accountId: acc.id, text: 'régi', agentId: 'ag1' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-05T10:00:00.000Z',
                     excerpt: 'e2', sourceSystem: 'manual', sourceId: 'n2' })

  const page = await rpc.account({ accountId: acc.id })
  assert.equal(page.summary.stale, true)
  assert.equal(page.summary.newerEvents, 1)
  assert.equal(page.events.length, 2)
})

test('a jegyzet eseményt ír, kézi forrással', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  const res = await rpc.addNote({ accountId: acc.id, text: 'Telefonon egyeztettünk.' })
  assert.equal(res.event.kind, 'note')
  assert.equal(res.event.source_system, 'manual')
  assert.equal(repo.getEventBody(res.event.id), 'Telefonon egyeztettünk.')
})

test('a besorolatlan hozzárendelése tanult címet ír, es magat az uzenetet is felviszi az idovonalra', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't1',
    senderAddress: 'dorina@morvai.hu', subject: 'Ajanlat kerese', excerpt: 'Kerek egy ajanlatot.',
    receivedAt: '2026-09-01T10:00:00.000Z', threadId: 'thr_1' })

  await rpc.assignUnmatched({ unmatchedId: row.id, contactId: con.id })

  assert.equal(repo.contactByEmail('dorina@morvai.hu').id, con.id, 'a cim tanult')
  assert.equal(repo.listUnmatched().length, 0, 'a sor kiurult')

  const events = repo.listEvents({ accountId: acc.id })
  assert.equal(events.length, 1, 'a besorolt uzenet felkerult az idovonalra')
  assert.equal(events[0].kind, 'email_in')
  assert.equal(events[0].title, 'Ajanlat kerese')
  assert.equal(events[0].source_system, 'gmail')
  assert.equal(events[0].source_id, 't1')
  assert.equal(events[0].thread_id, 'thr_1')
  assert.equal(events[0].contact_id, con.id)

  // Ujra behuzva ugyanaz a forras (source_system, source_id) -- a
  // recordEvent idempotens, tehat egy kesobbi ujra-sopres nem duplikal.
  const ismet = repo.recordEvent({ accountId: acc.id, contactId: con.id, kind: 'email_in',
    occurredAt: '2026-09-01T10:00:00.000Z', title: 'Ajanlat kerese', sourceSystem: 'gmail', sourceId: 't1' })
  assert.equal(ismet.created, false)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('a besorolatlan hozzarendelese ugyfel nelkuli kapcsolathoz tanul, de esemenyt nem visz fel', async () => {
  const { rpc, repo } = rpcOf()
  const con = repo.createContact({ name: 'Ismeretlen kapcsolat' }) // nincs accountId
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't5',
    senderAddress: 'valaki@sehol.hu', subject: 'Erdeklodes', receivedAt: '2026-09-01T10:00:00.000Z' })

  const res = await rpc.assignUnmatched({ unmatchedId: row.id, contactId: con.id })

  assert.equal(repo.contactByEmail('valaki@sehol.hu').id, con.id, 'a cim akkor is tanult')
  assert.equal(repo.listUnmatched().length, 0, 'a sor akkor is kiurul')
  // Nincs ugyfel, amire az esemenyt irni lehetne (`account_id NOT NULL`) --
  // ez a dontes, nem baleset: a matching.mjs sem ad 'exact' talalatot ugyfel
  // nelkuli kapcsolatra, es assignUnmatched ugyanezt a szabalyt koveti, es ezt
  // a valaszban is jelzi, nem csendben hagyja el.
  assert.equal(res.eventFiled, false)
  assert.equal(res.event, null)
})

test('a contactsForPicker minden kapcsolatot ad, az ügyfél nevével', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const c1 = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  const c2 = repo.createContact({ name: 'Ügyfél nélküli' })
  const lista = await rpc.contactsForPicker({})
  const byId = Object.fromEntries(lista.map((c) => [c.id, c]))
  assert.equal(byId[c1.id].accountName, 'Morvai Kft.')
  assert.equal(byId[c2.id].accountName, '')
})

test('az ismeretlen ügyfél nevesített hibát ad, nem üres választ', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(() => rpc.account({ accountId: 'acc_nincs' }), /crm_ismeretlen_ugyfel/)
})

test('az ismeretlen ügy frissítése nevesített hibát ad, nem néma null-t', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(
    () => rpc.updateDeal({ dealId: 'deal_nincs', title: 'Új cím' }),
    /crm_ismeretlen_ugy/,
  )
})

test('az ismeretlen ügy lezárása nevesített hibát ad, nem néma null-t', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(
    () => rpc.closeDeal({ dealId: 'deal_nincs', stage: 'won', reason: 'x' }),
    /crm_ismeretlen_ugy/,
  )
})

test('az ismeretlen kapcsolathoz rendelés nevesített hibát ad, és a sor nyitva marad', async () => {
  const { rpc, repo } = rpcOf()
  repo.createAccount({ name: 'Morvai Kft.' })
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't2',
    senderAddress: 'ismeretlen@morvai.hu', receivedAt: '2026-09-01T10:00:00.000Z' })

  await assert.rejects(
    () => rpc.assignUnmatched({ unmatchedId: row.id, contactId: 'con_nincs' }),
    /crm_ismeretlen_kapcsolat/,
  )
  assert.ok(repo.listUnmatched().some((u) => u.id === row.id))
})

test('az ismeretlen kapcsolathoz email csatolása nevesített hibát ad', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(
    () => rpc.attachEmail({ contactId: 'con_nincs', address: 'x@y.hu' }),
    /crm_ismeretlen_kapcsolat/,
  )
})

test('az üres feladó-cím nélküli besorolatlan sor is feloldható, kivétel nélkül', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't3',
    receivedAt: '2026-09-01T10:00:00.000Z' })
  assert.equal(row.sender_address, '')

  await rpc.assignUnmatched({ unmatchedId: row.id, contactId: con.id })

  assert.ok(!repo.listUnmatched().some((u) => u.id === row.id))
})

test('az ismeretlen esemény törzsének kérése nevesített hibát ad, nem üres tartalmat', async () => {
  // Ugyanaz a szerződés, mint az ügynök felületén (src/tools.mjs
  // crm_event_body): egy ismeretlen eventId ugyanazt a hibát dobja, nem
  // { content: '' }-t.
  const { rpc } = rpcOf()
  await assert.rejects(() => rpc.eventBody({ eventId: 'ev_nincs' }), /crm_ismeretlen_esemeny/)
})

test('az esemény törzse visszaadódik ismert eseményre', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  const res = await rpc.addNote({ accountId: acc.id, text: 'A törzs szövege.' })
  const body = await rpc.eventBody({ eventId: res.event.id })
  assert.equal(body.content, 'A törzs szövege.')
})

test('az ügy lezárása csak won/lost szakaszt fogad el, mást nevesített hibával utasít el', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  const deal = repo.createDeal({ accountId: acc.id, kind: 'lead', title: 'Ajánlat' })

  await assert.rejects(
    () => rpc.closeDeal({ dealId: deal.id, stage: 'talking', reason: 'x' }),
    /crm_ismeretlen_ugy_szakasz/,
  )

  const closed = await rpc.closeDeal({ dealId: deal.id, stage: 'won', reason: 'aláírva' })
  assert.equal(closed.stage, 'won')
})

test('a mailboxHealth nevesített okot ad, ha a state-en egyáltalán nincs contracts', async () => {
  const { rpc } = rpcOf()            // a rpcOf nem ad contracts-ot
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, false)
  assert.equal(h.reason, 'crm_nincs_contracts')
})

test('a mailboxHealth a hoszt saját okkódját adja tovább, ha a get() null-t ad', async () => {
  const { rpc } = rpcWithContracts({
    get: () => null,
    why: () => 'provider_disabled',
  })
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, false)
  assert.equal(h.reason, 'provider_disabled')
})

test('a mailboxHealth a postafiók címét adja vissza, ha a szerződés feloldódik', async () => {
  const { rpc } = rpcWithContracts({
    get: (extensionId, contract) => {
      assert.equal(extensionId, 'gmail')
      assert.equal(contract, 'mailbox')
      return { mailbox: async () => ({ address: 'dorina@morvai.hu' }) }
    },
    why: () => null,
  })
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, true)
  assert.equal(h.address, 'dorina@morvai.hu')
})

test('a mailboxHealth nevesitett okot ad -- nem 500-at --, ha a szerzodes feloldodik de a hivas elhasal', async () => {
  const { rpc } = rpcWithContracts({
    get: () => ({ mailbox: async () => { throw new Error('lejart hitelesito') } }),
    why: () => null,
  })
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, false)
  assert.equal(h.reason, 'crm_postafiok_hiba')
  assert.equal(h.message, 'lejart hitelesito')
})

test('a mailboxHealth a gmail extension nevesitett hibajanak uzenetet is viszi, a stabil kod mellett', async () => {
  // Élő eset: a hoszton nincs Google OAuth kliens konfigurálva -- a `gmail`
  // extension saját `health` rpc-je ezt `google_oauth_client_missing`
  // kóddal jelzi, a `mailbox()` hívás pedig ugyanezzel a szöveggel utasít el.
  const { rpc } = rpcWithContracts({
    get: () => ({ mailbox: async () => { throw new Error('google_oauth_client_missing') } }),
    why: () => null,
  })
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, false)
  assert.equal(h.reason, 'crm_postafiok_hiba')
  assert.equal(h.message, 'google_oauth_client_missing')
})

/**
 * A `mailbox` szerződés dublőre, ugyanaz, mint a sweep saját tesztjeiben: a
 * Gmail `labelIds` ÉS-szemantikáját utánozza. Lásd `helpers.mjs`.
 */
const fakeMailbox = gmailFakeMailbox

const LEVEL = (over) => ({
  id: 'msg_1', threadId: 'thr_1', labelIds: ['INBOX'], subject: 'Ajanlat',
  fromName: 'Morvai Dorina', fromEmail: 'dorina@morvai.hu',
  sentAt: '2026-09-01T10:00:00.000Z', text: 'Kerek egy ajanlatot.',
  textInAttachment: false, sizeEstimate: 100, ...over,
})

test('a sweepNow ugyanazt a torzset hivja, mint az ugynok crm_sweep eszkoze', async () => {
  const uzenetek = [LEVEL()]
  const { rpc, repo } = rpcWithContracts({ get: () => fakeMailbox(uzenetek) })
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await rpc.sweepNow({ max: 50 })
  assert.equal(r.scanned, 1)
  assert.equal(r.recorded, 1)
  assert.equal(r.unmatched, 0)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('a sweepNow max nelkul is fut, 50-es alapertelmezettel', async () => {
  const uzenetek = [LEVEL({ id: 'msg_2', fromEmail: 'senki@sehol.hu' })]
  const { rpc } = rpcWithContracts({ get: () => fakeMailbox(uzenetek) })
  const r = await rpc.sweepNow({})
  assert.equal(r.scanned, 1)
  assert.equal(r.unmatched, 1)
})

test('a sweepNow a labelIds-t es a q-t is tovabbadja, nem csak a max-ot', async () => {
  // A diagnozis-ajto. Amig ez az rpc csak a `max`-ot adta tovabb, addig egy
  // ures sopres okat innen nem lehetett szukiteni: nem lehetett megkerdezni,
  // hoz-e a puszta INBOX levelet. Pontosan ez tette hosszuva a Gmail
  // ES-szemantikajabol eredo ures sopres diagnozisat.
  const kapott = []
  const uzenetek = [LEVEL()]
  const mailbox = {
    ...gmailFakeMailbox(uzenetek),
    list: async (args) => { kapott.push(args); return { ids: [], nextCursor: '', complete: true, stoppedOn: '' } },
  }
  const { rpc } = rpcWithContracts({ get: () => mailbox })
  await rpc.sweepNow({ max: 10, labelIds: ['INBOX'], q: 'newer_than:7d' })
  assert.deepEqual(kapott.map((k) => k.labelIds), [['INBOX']])
  assert.equal(kapott[0].q, 'newer_than:7d')
})

test('a sweepNow vesszos cimke-szoveget is elfogad', async () => {
  const kapott = []
  const mailbox = {
    list: async (args) => { kapott.push(args); return { ids: [], nextCursor: '', complete: true, stoppedOn: '' } },
    get: async () => null,
  }
  const { rpc } = rpcWithContracts({ get: () => mailbox })
  // Az alapertelmezettol KULONBOZO cimkek, kulonben a teszt akkor is zold
  // maradna, ha a vesszos szoveg elveszne es a default lepne a helyebe.
  await rpc.sweepNow({ labelIds: ' Ugyfelek , SENT ,, ' })
  assert.deepEqual(kapott.map((k) => k.labelIds), [['Ugyfelek'], ['SENT']])
})

test('a sweepNow ures labelIds-re az alapertelmezett cimkekre esik, NEM a teljes postafiokra', async () => {
  // Egy `labelIds: []` a `mailbox.list`-ben a teljes postafiokot sopornu --
  // ezt a vedokorlatot egy HTTP-hivo sem oldhatja fel egy ures tombbel.
  const kapott = []
  const mailbox = {
    list: async (args) => { kapott.push(args); return { ids: [], nextCursor: '', complete: true, stoppedOn: '' } },
    get: async () => null,
  }
  const { rpc } = rpcWithContracts({ get: () => mailbox })
  await rpc.sweepNow({ labelIds: [] })
  assert.deepEqual(kapott.map((k) => k.labelIds), [['INBOX'], ['SENT']])
})

test('a sweepNow szerzodes hianyaban nevesitett hibat ad', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(() => rpc.sweepNow({}), /crm_nincs_postafiok/)
})

test('az attention a beallitott kuszoboket hasznalja, nem beegetett szamokat', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = { storage: S, repo, log: console, settings: () => ({ nemaNapok: 1 }) }
  const rpc = createRpc(state)

  const acc = repo.createAccount({ name: 'X' })
  const deal = repo.createDeal({ accountId: acc.id, title: 'Nema ugy' })
  repo.recordEvent({ accountId: acc.id, dealId: deal.id, kind: 'note',
    occurredAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    excerpt: 'e', sourceSystem: 'manual', sourceId: 'n1' })

  const r = await rpc.attention({})
  assert.equal(r.kuszobok.nemaNapok, 1)
  assert.ok(r.sorok.some((s) => s.kind === 'nema_ugy' && s.dealId === deal.id))
})

test('az attention az alapertekekre esik vissza, ha a beallitas ures', async () => {
  const { rpc } = rpcOf()          // rpcOf settings-e ures objektumot ad
  const r = await rpc.attention({})
  assert.deepEqual(r.kuszobok, { nemaNapok: 9, valaszNapok: 3, igeretNapok: 2, idegenIgeretNapok: 7 })
})

/**
 * Nem ugyanaz, mint a fenti teszt: ott a mező HIÁNYZIK a settings
 * objektumból, itt az operátor kiürítette a mezőt, tehát üres string
 * érkezik. A `Number('')` 0, és egy naiv `Number(x) ?? alapertek` a 0-t
 * érvényes küszöbnek nézné -- ami azt jelentené, hogy minden nyitott ügyre
 * azonnal jelezne. A kiürítés nem ezt kéri, hanem az alapértéket.
 */
test('az attention a kiuritett (ures string) kuszobmezot is alapertekre valtja, nem nullara', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = { storage: S, repo, log: console, settings: () => ({ nemaNapok: '' }) }
  const rpc = createRpc(state)

  const acc = repo.createAccount({ name: 'X' })
  repo.createDeal({ accountId: acc.id, title: 'Ugy' })

  const r = await rpc.attention({})
  assert.equal(r.kuszobok.nemaNapok, 9)
})

/**
 * A `hostFetch` GET hívásain (pl. `/api/projects`) az `init`-nek nincs
 * `body`-ja -- a `fetchImpl`-nek ezt is ki kell bírnia, nem csak a POST-okat.
 * `projektSorok` a `/api/projects` GET válasza; alapból egy egyetlen, helyes
 * alakú CRM-sort ad (lásd `projektSor` fent), hogy egy `acceptSuggestion`-t
 * hívó teszt, aminek a projekt-illesztés nem a tárgya, ne akadjon el az új
 * `crm_projekt_nem_talalhato` hibán.
 */
function fetchImplNyomkovetve(hivasok, projektSorok = [projektSor('proj_crm', 'crm.mjs', 'crm')]) {
  return async (url, init) => {
    const rec = { url, method: init.method }
    if (init.body) rec.body = JSON.parse(init.body)
    hivasok.push(rec)
    if (url.endsWith('/api/projects')) return { ok: true, json: async () => projektSorok }
    if (url.endsWith('/api/tasks')) return { ok: true, json: async () => ({ id: 'task_uj' }) }
    throw new Error(`fetchImplNyomkovetve: varatlan ut -- ${url}`)
  }
}

test('a javaslat elfogadasa feladatot ker a hosttol, es rogziti az azonositot', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve(hivasok),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldj ajanlatot', reason: '9 napja nema' })

  const out = await rpc.acceptSuggestion({ suggestionId: sug.id })

  assert.equal(out.taskId, 'task_uj')
  assert.equal(out.deduplicated, false, 'ez egy uj feladat volt, nem egy meglevo')
  assert.equal(repo.listSuggestions({ status: 'new' }).length, 0, 'a javaslat mar nem uj')
  // A hivasok koze idekozben bekerult a `/api/projects` GET is (a
  // `crmProjektId` lekerdezese) -- ezert a feladat-POST-ot az utvonala
  // alapjan keressuk, nem a tomb elso elemekent.
  const taskHivas = hivasok.find((h) => h.url.endsWith('/api/tasks'))
  assert.ok(taskHivas, 'a feladat-POST megtortent')
  const b = taskHivas.body
  // A cím az ügyfél nevével kezdődik -- lásd C1 a code review-ban: enélkül
  // két különböző ügyfél azonos szövegű javaslata (pl. "Kuldj ajanlatot")
  // egyetlen feladatba ütközne a hoszt saját, cím+agentId fingerprintjén. A cím
  // egy ` #<sug.id utolsó 8 karaktere>` szuffixszal zárul -- lásd I-NEW-1.
  assert.equal(b.title, `Morvai Kft. — Kuldj ajanlatot #${sug.id.slice(-8)}`)
  assert.equal(b.customFields.crm_account, acc.id)
  assert.deepEqual(b.tags, ['crm'])
  // Nincs `fingerprint` mező a törzsben -- a host úgyis felülírja a sajátjával
  // (lásd az `acceptSuggestion` doksiját), tehát a küldése csak látszólagos
  // garancia lenne.
  assert.ok(!('fingerprint' in b), 'nem küldünk fingerprint mezőt, amit a host úgyis felülír')
})

test('a javaslat cime 120 karakterre vagva, az ugyfel nevevel egyutt, es a megkulonbozteto id-szuffix tulel', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve(hivasok),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'A'.repeat(100) })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'B'.repeat(100) })

  await rpc.acceptSuggestion({ suggestionId: sug.id })

  const taskHivas = hivasok.find((h) => h.url.endsWith('/api/tasks'))
  assert.equal(taskHivas.body.title.length, 120)
  // I-NEW-1: nem eleg, hogy a cim pontosan 120 karakter -- annak is teljesulnie
  // kell, hogy a megkulonbozteto resz (a javaslat id-jenek utolso 8 karaktere)
  // tenyleg BENNE marad a vagott cimben, nem esik ki a vagas soran.
  assert.ok(taskHivas.body.title.endsWith(` #${sug.id.slice(-8)}`),
    'a javaslat-id-szuffix a vagott cim vegen tulel')
})

/**
 * I-NEW-1: egy elég hosszú ügyfélnév a régi kódban (`${acc.name} — ${sug.text}`.slice(0,120))
 * a javaslat szövegét TELJESEN kiszorítja a 120 karakterből -- ekkor minden,
 * ugyanahhoz az ügyfélhez tartozó javaslat cime egybeesett volna, es a hoszt
 * cim+agentId fingerprintje a masodik elfogadast az elso megismetlesenek
 * latta volna (deduplicated: true), holott ket KULONBOZO javaslatrol van szo.
 * A 86 karakteres nev es a ket idezett javaslat-szoveg valodi, C-NEW-1
 * jelentéséből szó szerint átvett reprodukció.
 */
test('hosszu ugyfelnev mellett ket kulonbozo javaslat cime SEM eshet egybe', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve(hivasok),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({
    name: 'Első Magyar Kereskedelmi és Szolgáltató Korlátolt Felelősségű Társaság Ipari Zrt.',
  })
  const sug1 = repo.writeSuggestion({ accountId: acc.id, text: 'Hívd fel a szerződés lejáratáról' })
  const sug2 = repo.writeSuggestion({ accountId: acc.id, text: 'Írj neki a szervizigényről' })

  await rpc.acceptSuggestion({ suggestionId: sug1.id })
  await rpc.acceptSuggestion({ suggestionId: sug2.id })

  const cimek = hivasok.filter((h) => h.url.endsWith('/api/tasks')).map((h) => h.body.title)
  assert.equal(cimek.length, 2)
  assert.notEqual(cimek[0], cimek[1], 'a ket cim egy hosszu ugyfelnev mellett sem eshet egybe')
})

test('ket kulonbozo ugyfel egyforma szovegu javaslata NEM utkozik a cimben', async () => {
  // C1: a host `findDuplicateTask`-ja (`src/lib/task-dedupe.ts`) a TELJES
  // feladat-tablan keres cim+agentId egyezest, ugyfelre nem szukitve. Az
  // ugyfel neve a cimben eppen ezt zarja ki.
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve(hivasok),
  }
  const rpc = createRpc(state)
  const morvai = repo.createAccount({ name: 'Morvai Kft.' })
  const kovacs = repo.createAccount({ name: 'Kovacs Bt.' })
  const sug1 = repo.writeSuggestion({ accountId: morvai.id, text: 'Kuldj ajanlatot' })
  const sug2 = repo.writeSuggestion({ accountId: kovacs.id, text: 'Kuldj ajanlatot' })

  await rpc.acceptSuggestion({ suggestionId: sug1.id })
  await rpc.acceptSuggestion({ suggestionId: sug2.id })

  const cimek = hivasok.filter((h) => h.url.endsWith('/api/tasks')).map((h) => h.body.title)
  assert.equal(cimek.length, 2)
  assert.notEqual(cimek[0], cimek[1], 'a ket cim nem eshet egybe')
})

/**
 * A host `deduplicated: true`-t ad vissza a `/api/tasks` válaszban, ha a
 * hoszt saját, cím+agentId fingerprintje egy már létező, még nem lezárt
 * feladatra illik. Ez a hívó (`acceptSuggestion`) szempontjából NEM hiba --
 * ugyanaz a javaslat kétszeri elfogadása erre a válaszra fut --, de a
 * felületnek tudnia kell, hogy nem született új feladat.
 */
test('az acceptSuggestion tovabbadja a hoszt deduplicated jelzeset', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: async (url, init) => {
      const rec = { url, method: init.method }
      if (init.body) rec.body = JSON.parse(init.body)
      hivasok.push(rec)
      if (url.endsWith('/api/projects')) return { ok: true, json: async () => [projektSor('proj_crm', 'crm.mjs', 'crm')] }
      if (url.endsWith('/api/tasks')) return { ok: true, json: async () => ({ id: 'task_regi', deduplicated: true }) }
      throw new Error(`varatlan ut -- ${url}`)
    },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldj ajanlatot' })

  const out = await rpc.acceptSuggestion({ suggestionId: sug.id })

  assert.equal(out.taskId, 'task_regi')
  assert.equal(out.deduplicated, true)
})

test('a javaslat elfogadasa a CRM projektbe filezi a feladatot, akkor is, ha a board() sosem futott le', async () => {
  // Ez a teszt azt a hibaosztalyt fogja meg, amit a `state.crmProjectId`
  // mezore epito, `board()` altal vegzett elomelegites okozott: ha
  // `acceptSuggestion` ele nem fut le `board()` -- mas lap, szerver-ujrainditas
  // a lapmegnyitas es az elfogadas kattintas kozott, kozvetlen rpc-hivas --,
  // a projekt-lekerdezesnek MAGABAN az `acceptSuggestion`-ben kell megtortennie,
  // nem a `state.crmProjectId || null` kiertekelesenek egy sosem toltott
  // mezon.
  //
  // A HAROM DECOY SOR A HAROM MEZOT KULON-KULON PINELI. A `crmProjektId`
  // illesztese harom feltetel EGYUTTALLASA (`extensionId`, `resourceKind`,
  // `resourceKey`), ahogy a host `findManagedProject`-je is; egy olyan
  // teszt, ami csak egy decoy-t visz, a masik ket feltetel torleset zoldon
  // engedne at. Mindharom decoy a valodi sor ELOTT all, tehat ha a hozza
  // tartozo feltetel kiesne az illesztesbol, a `.find` OT valasztana:
  //
  //   proj_dontő      -- ugyanaz a resourceKey ('crm'), MASIK extension.
  //                      Ez az az eset, amikor egy masik extension is
  //                      `projectKey: 'crm'`-et deklaral (I2).
  //   proj_rossz_kind -- a MI extensionunk, ugyanaz a resourceKey, de
  //                      `resourceKind: 'agent'`. A host ugyanezen a nevteren
  //                      tartja a managed agenteket es utemezeseket is, es a
  //                      CRM-3 ota tenylegesen deklaralunk `crm-ugyfelkezelo`
  //                      agentet -- egy `/api/projects` valasz, ami barmilyen
  //                      okbol nem-projekt sort is visszaad, e nelkul a
  //                      feltetel nelkul egy AGENT azonositojat adna
  //                      projectId-nek a feladat-POST-ba.
  //   proj_mas_kulcs  -- a MI extensionunk, `resourceKind: 'project'`, de
  //                      masik `resourceKey`. Ha a CRM valaha egy masodik
  //                      projektet is deklaral, e nelkul a feltetel nelkul a
  //                      feladat abba kerulne.
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const projektSorok = [
    projektSor('proj_dontő', 'mas-extension', 'crm'),
    projektSor('proj_rossz_kind', 'crm.mjs', 'crm', 'agent'),
    projektSor('proj_mas_kulcs', 'crm.mjs', 'crm-archivum'),
    projektSor('proj_egyeb', 'mas', 'mas'),
    projektSor('proj_crm', 'crm.mjs', 'crm'),
  ]
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve(hivasok, projektSorok),
    // Szandekosan NINCS state.crmProjectId elore beallitva, es a `board()`
    // sem fut le -- ez a friss rpc-peldany egyenesen `acceptSuggestion`-t
    // hivja.
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldj ajanlatot', reason: '9 napja nema' })

  await rpc.acceptSuggestion({ suggestionId: sug.id })

  const taskHivas = hivasok.find((h) => h.url.endsWith('/api/tasks'))
  assert.ok(taskHivas, 'a feladat-POST megtortent')
  assert.equal(taskHivas.body.projectId, 'proj_crm',
    'a feladat a valodi CRM projektbe kerult, nem egy decoy sorba (idegen extension, nem-projekt resourceKind, masik resourceKey)')
})

/**
 * C-NEW-1: a host az extensiont a FÁJLNEVÉVEL azonosítja
 * (`src/lib/server/extensions.ts`), tehát a valódi `managedByExtension.extensionId`
 * ennek a telepítésnek `'crm.mjs'` -- ezt méri a fenti teszt. Ez a teszt a
 * másik, tolerált spellinget nézi (a puszta `'crm'`-et, ha valaha egy host-
 * verzió vagy egy másik telepítési út ezt írná), és hogy a döntő
 * `mas-extension` sor emellett is decoy marad -- a normalizálás a `crm`
 * résszel egyezik, nem a mezővel egyáltalán.
 */
test('a javaslat elfogadasa a CRM projektbe filezi a feladatot, ha a hoszt a puszta "crm" alakot irja extensionId-kent', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const projektSorok = [
    projektSor('proj_dontő', 'mas-extension', 'crm'),
    projektSor('proj_rossz_kind', 'crm', 'crm', 'agent'),
    projektSor('proj_mas_kulcs', 'crm', 'crm-archivum'),
    projektSor('proj_crm', 'crm', 'crm'),
  ]
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve(hivasok, projektSorok),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldj ajanlatot' })

  await rpc.acceptSuggestion({ suggestionId: sug.id })

  const taskHivas = hivasok.find((h) => h.url.endsWith('/api/tasks'))
  assert.equal(taskHivas.body.projectId, 'proj_crm')
})

test('az igeretbol szuletett javaslat elfogadasa LEZARJA az igeretet is', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve(hivasok),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const igeret = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldom', direction: 'ours' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldd el', commitmentId: igeret.id })

  assert.equal(repo.listCommitments({ openOnly: true }).length, 1, 'elotte meg nyitott')
  await rpc.acceptSuggestion({ suggestionId: sug.id })
  assert.equal(repo.listCommitments({ openOnly: true }).length, 0,
    'az igeret lezarult, tehat nem jon vissza a figyelem-listara')
})

/**
 * M5: a `commitmentId`-t az ügynök a JAVASLAT ÍRÁSAKOR adta meg, és a
 * `crm_suggestion_write` akkor ellenőrizte, hogy az ígéret a javaslat
 * ügyfeléhez tartozik (I4). Az ELFOGADÁS egy KÉSŐBBI pillanatban történik --
 * ez a teszt azt az esetet fogja meg, amikor időközben (kézi javítással) az
 * ígéret már egy MÁSIK ügyfélhez tartozik: az elfogadásnak ekkor NEM szabad
 * lezárnia az idegen ügyfél ígéretét, csak névvel naplóznia, hogy miért nem.
 */
test('ha a javaslathoz tartozo igeret idokozben mas ugyfelhez kerult, az elfogadas NEM zarja le', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const naplo = []
  const state = {
    storage: S, repo, settings: () => ({}),
    log: { warn: (msg, meta) => naplo.push({ msg, meta }), info() {}, error() {} },
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve([]),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const masikAcc = repo.createAccount({ name: 'Masik' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const igeret = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldom', direction: 'ours' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldd el', commitmentId: igeret.id })

  // Kezi "adatjavitas": az igeret idokozben a masik ugyfelhez kerul.
  S.raw.exec(`UPDATE ext_crm_commitment SET account_id = '${masikAcc.id}' WHERE id = '${igeret.id}'`)

  await rpc.acceptSuggestion({ suggestionId: sug.id })

  const friss = repo.getCommitment(igeret.id)
  assert.equal(friss.task_id, null, 'az idegen ugyfelhez kerult igeret nem zarult le')
  assert.ok(naplo.some((n) => n.msg.includes('acceptSuggestion') && n.meta?.commitmentId === igeret.id),
    'a kihagyas nevesitve a logba kerult')
})

/**
 * M6: a sorrend `linkCommitmentTask` ELŐBB, `setSuggestionStatus('accepted')`
 * UTÁNA. Ha a kettő közt bármi elhasal, a javaslat 'new' marad -- nem pedig
 * elfogadottá jelölve egy soha le nem zárt ígéret mögött, ami pontosan az az
 * állapot, amit a 7. feladat meg akart szüntetni.
 */
test('ha az igeret lezarasa elhasal, a javaslat NEM valik elfogadotta', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const eredetiLink = repo.linkCommitmentTask
  repo.linkCommitmentTask = () => { throw new Error('adatbazis-hiba') }
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: fetchImplNyomkovetve([]),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const igeret = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldom', direction: 'ours' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldd el', commitmentId: igeret.id })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /adatbazis-hiba/)

  repo.linkCommitmentTask = eredetiLink
  assert.equal(repo.listSuggestions({ status: 'new' }).some((s) => s.id === sug.id), true,
    'a javaslat nem valt elfogadotta, mert az igeret lezarasa elhasalt')
})

test('ismeretlen javaslatra nevesitett hiba', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: 'sug_nincs' }), /crm_ismeretlen_javaslat/)
})

/**
 * I1: ha a CRM projekt nem allapithato meg (barmilyen okbol -- hianyzo
 * port-fajl, elhasalo hivas, meg nem rekonicialt projekt), az
 * `acceptSuggestion` nevesitett hibaval all meg, nem filez `projectId:
 * null`-lal csendben a CRM projekten kivulre.
 */
test('az acceptSuggestion nevesitett hibat ad, ha a CRM projekt nem allapithato meg', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const naplo = []
  const state = {
    storage: S, repo, settings: () => ({}),
    log: { warn: (msg, meta) => naplo.push({ msg, meta }), info() {}, error() {} },
    // Szandekosan nincs portFile: a `/api/projects` GET emiatt elhasal.
    fetchImpl: async () => { throw new Error('nem kellene hivni') },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldj ajanlatot' })

  await assert.rejects(
    () => rpc.acceptSuggestion({ suggestionId: sug.id }),
    /crm_projekt_nem_talalhato/,
  )
  assert.ok(naplo.some((n) => n.msg.includes('crmProjektId') && n.meta?.reason === 'crm_nincs_port_fajl'),
    'a konkret ok (hianyzo port-fajl) nevesitve a logba kerult')
})

test('a crmProjektId nevesitett figyelmeztetest ir a logba, ha a projekt meg nincs rekonicialva -- de a board() ettol meg betolt', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const naplo = []
  const state = {
    storage: S, repo, settings: () => ({}),
    log: { warn: (msg, meta) => naplo.push({ msg, meta }), info() {}, error() {} },
    portFile: irPortFajlt(tempDir()),
    fetchImpl: async (url) => {
      if (url.endsWith('/api/projects')) return { ok: true, json: async () => [] }
      throw new Error(`varatlan ut -- ${url}`)
    },
  }
  const rpc = createRpc(state)
  repo.createAccount({ name: 'X' })

  const board = await rpc.board({})

  assert.deepEqual(board.accounts.map((a) => a.name), ['X'], 'a lap ettol fuggetlenul betoltott')
  assert.ok(naplo.some((n) => n.msg.includes('crmProjektId') && n.msg.includes('rekonciliálva')),
    'a nevesitett figyelmeztetes bekerult a logba')
})

/**
 * I3 / M1: a port-fájl olvashatatlansága és egy elhasaló feladat-POST most
 * már valódi teszttel elérhető, nem csak a produkciós kódban élő, de
 * tesztből sosem futtatott ágakként.
 */
test('crm_olvashatatlan_port_fajl, ha a port-fajl nem ervenyes JSON', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const dir = tempDir()
  const file = path.join(dir, 'port.json')
  fs.writeFileSync(file, 'ez nem json')
  const naplo = []
  const state = {
    storage: S, repo, settings: () => ({}), portFile: file,
    log: { warn: (msg, meta) => naplo.push({ msg, meta }), info() {}, error() {} },
    fetchImpl: async () => { throw new Error('nem kellene hivni') },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /crm_projekt_nem_talalhato/)
  assert.ok(naplo.some((n) => n.meta?.reason === 'crm_olvashatatlan_port_fajl'))
})

/**
 * I3: egy visszamaradt port-fájl -- akkor is, ha még mindig valid JSON --,
 * ami MÁS pid-et vagy egy korábbi rendszerindítást ír le, nem fogadható el
 * élőnek. Enélkül egy szerver-újraindítás után visszamaradt fájl a jelenlegi
 * (más folyamat által birtokolt) port felé küldene feladat-létrehozó POST-ot.
 */
test('crm_regi_port_fajl, ha a port-fajl mas pid-et ir le', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const idegenPid = process.pid + 1
  const file = irPortFajlt(tempDir(), { pid: idegenPid })
  const naplo = []
  const state = {
    storage: S, repo, settings: () => ({}), portFile: file,
    log: { warn: (msg, meta) => naplo.push({ msg, meta }), info() {}, error() {} },
    fetchImpl: async () => { throw new Error('nem kellene hivni') },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /crm_projekt_nem_talalhato/)
  assert.ok(naplo.some((n) => n.meta?.reason === 'crm_regi_port_fajl'))
})

test('crm_regi_port_fajl, ha a port-fajl startedAt-ja a jelen boot elotti', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const file = irPortFajlt(tempDir(), { elo: false })
  const naplo = []
  const state = {
    storage: S, repo, settings: () => ({}), portFile: file,
    log: { warn: (msg, meta) => naplo.push({ msg, meta }), info() {}, error() {} },
    fetchImpl: async () => { throw new Error('nem kellene hivni') },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /crm_projekt_nem_talalhato/)
  assert.ok(naplo.some((n) => n.meta?.reason === 'crm_regi_port_fajl'))
})

test('crm_host_hivas_sikertelen, ha a feladat-POST elhasal', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: async (url) => {
      if (url.endsWith('/api/projects')) return { ok: true, json: async () => [projektSor('proj_crm', 'crm.mjs', 'crm')] }
      if (url.endsWith('/api/tasks')) return { ok: false, json: async () => ({}) }
      throw new Error(`varatlan ut -- ${url}`)
    },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /crm_host_hivas_sikertelen/)
})

/**
 * M4: a `crmProjektId` sikeres találata a `state.crmProjectId`-n marad
 * gyorsítótárazva a folyamat élettartamára. Ha a mögötte álló projektet
 * időközben törölték és egy MÁSIK id-vel rekonciliálták újra, a
 * gyorsítótárazott id halott -- a `/api/tasks` POST erre elhasal. Enélkül a
 * javítás nélkül MINDEN további elfogadás ugyanezzel a halott id-vel
 * próbálkozna újra, örökre. A teszt ezt úgy szimulálja, hogy az ELSŐ
 * `/api/tasks` hívás elhasal (halott id), a MÁSODIK viszont sikeres --
 * de csak akkor, ha a `/api/projects` GET időközben újra lefut, és egy ÚJ
 * projekt-id-t ad vissza.
 */
test('egy sikertelen feladat-POST utan a crmProjectId gyorsitotar torlodik, a kovetkezo elfogadas ujra lekerdez', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  let projektLekerdezesSzam = 0
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: async (url, init) => {
      const rec = { url, method: init.method }
      if (init.body) rec.body = JSON.parse(init.body)
      hivasok.push(rec)
      if (url.endsWith('/api/projects')) {
        projektLekerdezesSzam += 1
        // Az elso lekerdezes egy azota torolt projektet ad, a masodik mar
        // az ujonnan rekoncilialtat.
        const id = projektLekerdezesSzam === 1 ? 'proj_halott' : 'proj_uj'
        return { ok: true, json: async () => [projektSor(id, 'crm.mjs', 'crm')] }
      }
      if (url.endsWith('/api/tasks')) {
        const body = JSON.parse(init.body)
        // A "halott" projektbe iranyulo POST elhasal -- ez szimulalja, hogy
        // a gyorsitotarazott projectId mar nem letezik a hoszton.
        if (body.projectId === 'proj_halott') return { ok: false, json: async () => ({}) }
        return { ok: true, json: async () => ({ id: 'task_uj' }) }
      }
      throw new Error(`varatlan ut -- ${url}`)
    },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug1 = repo.writeSuggestion({ accountId: acc.id, text: 'elso' })
  const sug2 = repo.writeSuggestion({ accountId: acc.id, text: 'masodik' })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug1.id }), /crm_host_hivas_sikertelen/)
  assert.equal(state.crmProjectId, null, 'a sikertelen POST utan a gyorsitotar torlodott')

  const out = await rpc.acceptSuggestion({ suggestionId: sug2.id })
  assert.equal(out.taskId, 'task_uj', 'a masodik elfogadas mar az uj projekt-id-vel sikerult')
  assert.equal(projektLekerdezesSzam, 2, 'a masodik elfogadas ujra lekerdezte a projekt-listat')
})

test('crm_feladat_nem_jott_letre, ha a hoszt valasza nem tartalmaz id-t', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: async (url) => {
      if (url.endsWith('/api/projects')) return { ok: true, json: async () => [projektSor('proj_crm', 'crm.mjs', 'crm')] }
      if (url.endsWith('/api/tasks')) return { ok: true, json: async () => ({}) }
      throw new Error(`varatlan ut -- ${url}`)
    },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /crm_feladat_nem_jott_letre/)
})

/**
 * I3: időtúllépés. `state.hostFetchTimeoutMs` a teszt varrata -- enélkül ezt
 * a 10 másodperces valódi alapértelmezettel kellene kivárni. A `fetchImpl` a
 * valódi `fetch` viselkedését utánozza: sosem oldódik fel magától, csak az
 * `AbortSignal` `abort` eseményére utasítja el, ahogy egy igazi hálózati
 * hívás tenné egy megszakított kéréssel.
 *
 * A `keepAlive` egy saját, ref'd időzítő: az `AbortSignal.timeout` belső
 * időzítője unref'd (nem tartja életben a folyamatot), ami egy valódi
 * `fetch` hívásnál nem számít -- a hálózati socket amúgy is életben tartja
 * az eseményhurkot --, de ez a dublőr önmagában semmi mást nem csinál, és
 * enélkül a teszt folyamata azt hinné, nincs több dolga, mielőtt az abort
 * egyáltalán bekövetkezne.
 */
test('crm_host_hivas_sikertelen, ha a feladat-POST idotullepi a hatarido', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    hostFetchTimeoutMs: 20,
    // A `/api/projects` hivast megspekeljuk a gyorsitotarral, hogy csak a
    // feladat-POST idozitese legyen a teszt targya.
    crmProjectId: 'proj_crm',
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 200)
      if (init.signal) {
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive)
          reject(new DOMException('idotullepes', 'TimeoutError'))
        })
      }
      // Sosem oldodik fel magatol -- csak az abort szabaditja fel.
    }),
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  // Finding 9: a `fetchImpl` fent SOSEM oldódik fel magától -- kizárólag az
  // `AbortSignal` `abort` eseménye szabadítja fel. Ha egy jövőbeli módosítás
  // kivenné a `signal`-t a `hostFetch` fetch-hívásából, ez a promise örökre
  // függve maradna, és a node:test futtató ezt NEM egy nevesített hibaként
  // ("# fail"), hanem "# cancelled"-ként jelentené -- egy "# fail" mintára
  // grep-elő CI-kapu ezt észrevétlenül átengedné (kipróbálva: egy örökre
  // pending promise `test()`-je `# cancelled 1`-et ad, `# fail 0` mellett,
  // MÉG egy explicit `{ timeout }` teszt-opcióval is). A `Promise.race` egy
  // saját, rövid, NEVESÍTETT hibával utasítja el a tesztet, mielőtt ez a
  // félreértés bekövetkezhetne.
  await Promise.race([
    assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /crm_host_hivas_sikertelen/),
    new Promise((_resolve, reject) => setTimeout(
      () => reject(new Error('hostFetch nem reagalt az AbortSignal-ra idoben -- a timeout-vezetek eltunhetett')),
      2000,
    )),
  ])
})

/**
 * M2: a `hostFetch` fetch-hívása körüli catch korábban MINDEN dobott hibát
 * `crm_host_hivas_sikertelen`-né alakított -- egy programozási hiba (itt egy
 * `TypeError`, ami NEM a jellemző `fetch failed` üzenetet viseli) ugyanazt a
 * hálózat-alakú kódot kapta volna, mint egy valódi elutasított kapcsolat.
 */
test('egy nem halozati alaku hiba a sajat nevén surran at, nem crm_host_hivas_sikertelen-kent', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: async (url) => {
      if (url.endsWith('/api/projects')) return { ok: true, json: async () => [projektSor('proj_crm', 'crm.mjs', 'crm')] }
      if (url.endsWith('/api/tasks')) throw new TypeError('Cannot read properties of undefined (reading \'x\')')
      throw new Error(`varatlan ut -- ${url}`)
    },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await assert.rejects(
    () => rpc.acceptSuggestion({ suggestionId: sug.id }),
    /Cannot read properties of undefined/,
  )
})

/**
 * M1: egy 200-as válasz, aminek a törzse mégsem érvényes JSON (pl. egy proxy
 * vagy middleware hibaoldala), korábban egy nyers `SyntaxError`-t dobott
 * volna a `res.json()`-ból -- ezt a magyar hibatábla (`ui/ma.tsx`) nem tudta
 * lefordítani.
 */
test('crm_ervenytelen_host_valasz, ha a feladat-POST 200-at ad, de a torzse nem ervenyes JSON', async () => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    portFile: irPortFajlt(tempDir()),
    fetchImpl: async (url) => {
      if (url.endsWith('/api/projects')) return { ok: true, json: async () => [projektSor('proj_crm', 'crm.mjs', 'crm')] }
      if (url.endsWith('/api/tasks')) return { ok: true, json: async () => { throw new SyntaxError('Unexpected token') } }
      throw new Error(`varatlan ut -- ${url}`)
    },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /crm_ervenytelen_host_valasz/)
})

/**
 * I-NEW-3: ha a `process.env.PORT` érvényes portra mutat, a hívásnak EZT kell
 * használnia, még akkor is, ha `state.portFile` hiányzik vagy egy elavult
 * (más pid-ről szóló) fájlra mutat -- a `PORT` env a SAJÁT folyamatunké,
 * definíció szerint nem lehet elavult, tehát elsőbbséget élvez a port-fájl
 * bármelyik hibaágával szemben.
 */
test('a PORT kornyezeti valtozo elsobbseget elvez a port-fajllal szemben', async (t) => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const hivasok = []
  const eredetiPort = process.env.PORT
  process.env.PORT = '4321'
  t.after(() => {
    if (eredetiPort === undefined) delete process.env.PORT
    else process.env.PORT = eredetiPort
  })
  const state = {
    storage: S, repo, log: console, settings: () => ({}),
    // Szandekosan NINCS portFile beallitva -- a fajl-alapu agnak itt
    // `crm_nincs_port_fajl`-lal kellene elhasalnia, ha a PORT env nem
    // elozne meg.
    fetchImpl: async (url, init) => {
      hivasok.push({ url, init })
      if (url.endsWith('/api/projects')) return { ok: true, json: async () => [projektSor('proj_crm', 'crm.mjs', 'crm')] }
      if (url.endsWith('/api/tasks')) return { ok: true, json: async () => ({ id: 'task_uj' }) }
      throw new Error(`varatlan ut -- ${url}`)
    },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await rpc.acceptSuggestion({ suggestionId: sug.id })

  assert.ok(hivasok.every((h) => h.url.startsWith('http://127.0.0.1:4321/')),
    'minden hivas a PORT env altal megadott portra ment')
})

/**
 * I-NEW-3: ha a `process.env.PORT` nincs beállítva (vagy érvénytelen), a
 * régi, port-fájl-alapú út marad a fallback -- ez a teszt bizonyítja, hogy a
 * változtatás nem távolította el a fájl-alapú ágat, csak másodikra tette.
 */
test('PORT env nelkul a port-fajl marad a fallback', async (t) => {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const eredetiPort = process.env.PORT
  delete process.env.PORT
  t.after(() => {
    if (eredetiPort !== undefined) process.env.PORT = eredetiPort
  })
  const state = {
    storage: S, repo, settings: () => ({}),
    log: { warn: () => {}, info() {}, error() {} },
    // Szandekosan nincs portFile: a `/api/projects` GET emiatt elhasal, es
    // ennek a PORT env hianyaban a regi, nevesitett hibat kell adnia.
    fetchImpl: async () => { throw new Error('nem kellene hivni') },
  }
  const rpc = createRpc(state)
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'x' })

  await assert.rejects(() => rpc.acceptSuggestion({ suggestionId: sug.id }), /crm_projekt_nem_talalhato/)
})

/**
 * AZ ELFOGADASNAK EGY AJTAJA VAN.
 *
 * A `setSuggestionStatus` egy oszlopot ir at, semmi mast. Az `acceptSuggestion`
 * kimondott invarianca, hogy elfogadott javaslat MOGOTT ALL EGY FELADAT: a cim,
 * a projekt, a `crm_account` custom field es -- igeretbol szuletett javaslatnal
 * -- az igeret lezarasa mind ott keletkezik. Ha a status-ajto atengedne az
 * `'accepted'`-et, egy hivas "elfogadott" javaslatot hagyna feladat nelkul: a
 * sor eltunne a lap javaslat-listajarol (az csak a `status = 'new'` sorokat
 * mutatja), az igeret nyitva maradna, es semmi nem mondana meg, hogy a munka
 * elveszett.
 */
test('a setSuggestionStatus NEM fogad el "accepted"-et -- az elfogadas az acceptSuggestion dolga', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldj ajanlatot' })

  await assert.rejects(
    () => rpc.setSuggestionStatus({ suggestionId: sug.id, status: 'accepted' }),
    /crm_elfogadas_csak_acceptSuggestion/,
  )
  assert.equal(repo.listSuggestions({}).find((s) => s.id === sug.id).status, 'new',
    'az elutasitott hivas nem valtoztathatja meg a tarolt allapotot')
})

test('a setSuggestionStatus tovabbra is elveszi a "dismissed"-et', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Kuldj ajanlatot' })

  await rpc.setSuggestionStatus({ suggestionId: sug.id, status: 'dismissed' })
  assert.equal(repo.listSuggestions({ status: 'dismissed' }).some((s) => s.id === sug.id), true)
})

test('a setSuggestionStatus ismeretlen allapotra a sajat, kulon nevesitett hibajat adja', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Valami' })
  await assert.rejects(
    () => rpc.setSuggestionStatus({ suggestionId: sug.id, status: 'valami_mas' }),
    /crm_ismeretlen_javaslat_allapot/,
  )
})
