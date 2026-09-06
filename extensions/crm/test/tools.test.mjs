import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createTools } from '../src/tools.mjs'
import { memStorage } from './helpers.mjs'

function toolsOf(contracts) {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const state = { storage: S, repo: createRepo(S), log: console, contracts }
  const list = createTools(state)
  return { byName: Object.fromEntries(list.map((t) => [t.name, t])), repo: state.repo, list }
}

test('a CRM-3 tizenegy eszkozt ad: negy olvasot, a sopres inditasat, a figyelem-listat, es ot iro eszkozt', () => {
  const { list } = toolsOf()
  assert.deepEqual(list.map((t) => t.name).sort(),
    ['crm_account', 'crm_attention', 'crm_commitment_link', 'crm_commitment_write',
     'crm_event_body', 'crm_note', 'crm_search', 'crm_suggestion_write', 'crm_summary_write',
     'crm_sweep', 'crm_timeline'])
})

test('a CRM-3 utan a crm_attention es az iro eszkozok is a listaban vannak', () => {
  const { list } = toolsOf()
  const names = list.map((t) => t.name)
  assert.ok(names.includes('crm_attention'))
  for (const iro of ['crm_note', 'crm_summary_write', 'crm_commitment_write',
                      'crm_commitment_link', 'crm_suggestion_write']) {
    assert.ok(names.includes(iro), `${iro} hianyzik`)
  }
})

test('a covers_event_id-t a SZERVER belyegzi, az ugynok nem adhatja meg', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
    excerpt: 'e1', sourceSystem: 'manual', sourceId: 'n1' })

  // Az ugynok megprobalja allitani, hogy tobbet fedett le:
  await byName.crm_summary_write.execute(
    { accountId: acc.id, text: 'osszefoglalo', coversEventId: 'evt_hazugsag', covers_event_id: 'evt_hazugsag' },
    { session: { agentId: 'ag1' } })

  const s = repo.latestSummary(acc.id)
  assert.notEqual(s.summary.covers_event_id, 'evt_hazugsag')
  assert.equal(s.summary.covers_event_at, '2026-09-01T10:00:00.000Z')
})

test('az osszefoglalo rogziti, MELYIK ugynok irta', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  await byName.crm_summary_write.execute({ accountId: acc.id, text: 'x' }, { session: { agentId: 'ugyfelkezelo' } })
  assert.equal(repo.latestSummary(acc.id).summary.generated_by_agent_id, 'ugyfelkezelo')
})

test('az ugynok tovabbra sem lephet at a kapun', () => {
  const { byName } = toolsOf()
  for (const tiltott of ['crm_create_account', 'crm_close_deal', 'crm_assign_unmatched',
                         'crm_attach_email', 'crm_create_deal', 'crm_accept_suggestion',
                         'crm_advance_deal']) {
    assert.equal(byName[tiltott], undefined, `${tiltott} nem lehet az ugynok kezeben`)
  }
})

test('a crm_note esemenyt rogzit az idovonalra, es a szoveget mind kivonatkent, mind teljes torzskent tarolja', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })

  const out = await byName.crm_note.execute(
    { accountId: acc.id, text: 'ez egy jegyzet' }, { session: { agentId: 'ag1' } })
  assert.equal(out.created, true)
  assert.equal(out.event.kind, 'note')
  assert.equal(out.event.source_system, 'agent')

  const events = repo.listEvents({ accountId: acc.id })
  assert.equal(events.length, 1)
  assert.equal(repo.getEventBody(out.event.id), 'ez egy jegyzet')
})

test('a crm_note ismeretlen ugyfelre elutasit', async () => {
  const { byName } = toolsOf()
  await assert.rejects(
    byName.crm_note.execute({ accountId: 'acc_nincs', text: 'x' }, { session: { agentId: 'ag1' } }),
    /crm_ismeretlen_ugyfel/,
  )
})

/**
 * A `crm_note` `sourceId`-je ügynök+időbélyeg -- de az esemény `(source_system,
 * source_id)` egyedi, és a Gmail-söpréstől eltérően itt a névtelen ütközés
 * ADATVESZTÉS volna, nem védelem: két, ugyanabban az ezredmásodpercben írt
 * jegyzet közül a második `recordEvent` némán `created: false`-t adna, a
 * jegyzet szövege sosem kerülne az idővonalra. A `Date` befagyasztásával
 * determinisztikusan pont ezt az ezredmásodperc-egyezést szimuláljuk --
 * időzítésre várakozás nélkül, gépfüggetlenül.
 */
test('a crm_note ket, ugyanabban az ezredmasodpercben irt jegyzetet sem nyel el', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })

  const fixed = '2026-09-01T10:00:00.000Z'
  const RealDate = Date
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]))
    }
    static now() { return new RealDate(fixed).getTime() }
  }
  global.Date = FrozenDate
  try {
    const first = await byName.crm_note.execute({ accountId: acc.id, text: 'elso' }, { session: { agentId: 'ag1' } })
    const second = await byName.crm_note.execute({ accountId: acc.id, text: 'masodik' }, { session: { agentId: 'ag1' } })
    assert.equal(first.created, true)
    assert.equal(second.created, true, 'a masodik jegyzetnek is le kell jonnie, nem nyelheti el egy id-utkozes')
    assert.notEqual(first.event.id, second.event.id)
  } finally {
    global.Date = RealDate
  }

  assert.equal(repo.listEvents({ accountId: acc.id }).length, 2)
})

test('a crm_summary_write ismeretlen ugyfelre elutasit', async () => {
  const { byName } = toolsOf()
  await assert.rejects(
    byName.crm_summary_write.execute({ accountId: 'acc_nincs', text: 'x' }, { session: { agentId: 'ag1' } }),
    /crm_ismeretlen_ugyfel/,
  )
})

test('a crm_commitment_write rogzit egy igeretet egy esemenyhez kotve', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
    excerpt: 'e', sourceSystem: 'manual', sourceId: 'n1' })

  const cmt = await byName.crm_commitment_write.execute(
    { accountId: acc.id, eventId: event.id, text: 'kuldunk arajanlatot', direction: 'ours', dueHint: 'penteken' },
    { session: { agentId: 'ag1' } })
  assert.equal(cmt.direction, 'ours')
  assert.equal(cmt.status, 'open')
  assert.equal(cmt.due_hint, 'penteken')
  assert.equal(repo.listCommitments({ accountId: acc.id }).length, 1)
})

test('a crm_commitment_write ismeretlen ugyfelre, esemenyre es iranyra is nevesitett hibat ad', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
    excerpt: 'e', sourceSystem: 'manual', sourceId: 'n1' })

  await assert.rejects(
    byName.crm_commitment_write.execute(
      { accountId: 'acc_nincs', eventId: event.id, text: 'x', direction: 'ours' }, { session: {} }),
    /crm_ismeretlen_ugyfel/,
  )
  await assert.rejects(
    byName.crm_commitment_write.execute(
      { accountId: acc.id, eventId: 'evt_nincs', text: 'x', direction: 'ours' }, { session: {} }),
    /crm_ismeretlen_esemeny/,
  )
  await assert.rejects(
    byName.crm_commitment_write.execute(
      { accountId: acc.id, eventId: event.id, text: 'x', direction: 'oldalt' }, { session: {} }),
    /crm_ismeretlen_igeret_irany/,
  )
})

test('a crm_commitment_link osszekoti az igeretet a feladattal, es utana mar nem "nyitott"', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
    excerpt: 'e', sourceSystem: 'manual', sourceId: 'n1' })
  const cmt = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'x', direction: 'ours' })

  const linked = await byName.crm_commitment_link.execute(
    { commitmentId: cmt.id, taskId: 'task_1' }, { session: {} })
  assert.equal(linked.task_id, 'task_1')
  assert.equal(repo.listCommitments({ accountId: acc.id, openOnly: true }).length, 0)
})

test('a crm_commitment_link ismeretlen igeretre nevesitett hibat ad', async () => {
  const { byName } = toolsOf()
  await assert.rejects(
    byName.crm_commitment_link.execute({ commitmentId: 'cmt_nincs', taskId: 'task_1' }, { session: {} }),
    /crm_ismeretlen_igeret/,
  )
})

test('a crm_suggestion_write rogziti az okot, a kivalto sort, es hogy melyik ugynok javasolta', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })

  const sug = await byName.crm_suggestion_write.execute(
    { accountId: acc.id, text: 'hivd fel', reason: 'harom napja nem valaszolt', triggerKind: 'silent_deal' },
    { session: { agentId: 'ugyfelkezelo' } })
  assert.equal(sug.text, 'hivd fel')
  assert.equal(sug.reason, 'harom napja nem valaszolt')
  assert.equal(sug.trigger_kind, 'silent_deal')
  assert.equal(sug.agent_id, 'ugyfelkezelo')
  assert.equal(sug.status, 'new')
})

test('a crm_suggestion_write ismeretlen ugyfelre elutasit', async () => {
  const { byName } = toolsOf()
  await assert.rejects(
    byName.crm_suggestion_write.execute({ accountId: 'acc_nincs', text: 'x' }, { session: { agentId: 'ag1' } }),
    /crm_ismeretlen_ugyfel/,
  )
})

/**
 * A 7. feladat előfeltétele: a javaslat rögzíti, melyik ígéretből született,
 * hogy az elfogadás (rpc.mjs acceptSuggestion) le tudja zárni az ígéretet is.
 */
test('a crm_suggestion_write rogziti a commitmentId-t, ha az igeretbol szuletett', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const igeret = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldom', direction: 'ours' })

  const sug = await byName.crm_suggestion_write.execute(
    { accountId: acc.id, text: 'Kuldd el', commitmentId: igeret.id },
    { session: { agentId: 'ugyfelkezelo' } })
  assert.equal(sug.commitment_id, igeret.id)
})

test('a crm_suggestion_write commitmentId nelkul null-t rogzit', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  const sug = await byName.crm_suggestion_write.execute(
    { accountId: acc.id, text: 'Hivd fel' }, { session: { agentId: 'ag1' } })
  assert.equal(sug.commitment_id, null)
})

test('a crm_suggestion_write ismeretlen commitmentId-re nevesitett hibat ad', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  await assert.rejects(
    byName.crm_suggestion_write.execute(
      { accountId: acc.id, text: 'Kuldd el', commitmentId: 'cmt_nincs' },
      { session: { agentId: 'ugyfelkezelo' } }),
    /crm_ismeretlen_igeret/,
  )
})

/**
 * I4: a `commitmentId` az ügynöktől jön, tehát ellenőrizni kell, hogy a
 * megadott ígéret TÉNYLEG ehhez az ügyfélhez tartozik-e -- ugyanaz az elv,
 * ami miatt a `covers_event_id`-t a `writeSummary` maga bélyegzi (lásd
 * `src/db.mjs`), nem a hívó. Enélkül egy ügynök egy MÁSIK ügyfél nyitott
 * ígéretét zárhatná le csendben, amikor az operátor egy teljesen más
 * javaslatot fogad el.
 */
test('a crm_suggestion_write elutasitja a mas ugyfelhez tartozo commitmentId-t', async () => {
  const { byName, repo } = toolsOf()
  const sajat = repo.createAccount({ name: 'Sajat ugyfel' })
  const masik = repo.createAccount({ name: 'Masik ugyfel' })
  const { event } = repo.recordEvent({ accountId: masik.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const masikIgeret = repo.writeCommitment({ accountId: masik.id, eventId: event.id, text: 'Kuldom', direction: 'ours' })

  await assert.rejects(
    byName.crm_suggestion_write.execute(
      { accountId: sajat.id, text: 'Kuldd el', commitmentId: masikIgeret.id },
      { session: { agentId: 'ugyfelkezelo' } }),
    /crm_igeret_mas_ugyfele/,
  )
  // A tevesen atadott igeret erintetlen marad -- nem lett hozza feladat rendelve.
  assert.equal(repo.listCommitments({ accountId: masik.id, openOnly: true }).length, 1)
})

test('a keresés névre és címre is talál', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const byNev = await byName.crm_search.execute({ query: 'morvai' }, { session: { agentId: 'ag1' } })
  assert.equal(byNev.accounts[0].id, acc.id)

  const byCim = await byName.crm_search.execute({ query: 'dorina@morvai.hu' }, { session: { agentId: 'ag1' } })
  assert.equal(byCim.contacts[0].id, con.id)
})

test('a keresés a kapcsolat nevén is talál, még ha az ügyfél neve nem egyezik', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'Acme Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina Nagy' })
  repo.attachEmail(con.id, 'dorina@acme.hu')

  const result = await byName.crm_search.execute({ query: 'dorina nagy' }, { session: {} })
  assert.equal(result.contacts.length, 1)
  assert.equal(result.contacts[0].id, con.id)
})

test('az ügyfél nélküli kapcsolat is megtalálható névre', async () => {
  const { byName, repo } = toolsOf()
  const con = repo.createContact({ name: 'Ismeretlen Sandor' })

  const result = await byName.crm_search.execute({ query: 'ismeretlen sandor' }, { session: {} })
  assert.equal(result.contacts.length, 1)
  assert.equal(result.contacts[0].id, con.id)
})

test('a pontos email-találat egyszer szerepel, még ha a névtalálat is ugyanő', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  // A kapcsolat neve tartalmazza a saját email-címét, hogy a névkeresés
  // (LOWER(name) LIKE '%anna@x.hu%') és az email-keresés (contactByEmail)
  // ténylegesen ugyanarra a rekordra találjon rá.
  const con = repo.createContact({ accountId: acc.id, name: 'Kiss Anna anna@x.hu' })
  repo.attachEmail(con.id, 'anna@x.hu')

  // Előbb ellenőrizzük, hogy a két keresési út valóban átfedi egymást --
  // ha bármelyik üres lenne, a fixtúra még mindig nem tesztelne semmit.
  const emailFound = repo.contactByEmail('anna@x.hu')
  const nameFound = repo.searchContacts('anna@x.hu')
  assert.equal(emailFound?.id, con.id)
  assert.ok(nameFound.some((c) => c.id === con.id))

  const result = await byName.crm_search.execute({ query: 'anna@x.hu' }, { session: {} })
  assert.equal(result.contacts.length, 1)
  assert.equal(result.contacts[0].id, con.id)
})

test('a crm_timeline ismeretlen ügyfélre elutasít', async () => {
  const { byName } = toolsOf()
  await assert.rejects(
    byName.crm_timeline.execute({ accountId: 'acc_nincs' }, { session: {} }),
    /crm_ismeretlen_ugyfel/,
  )
})

test('a crm_event_body ismeretlen eseményre elutasít', async () => {
  const { byName } = toolsOf()
  await assert.rejects(
    byName.crm_event_body.execute({ eventId: 'evt_nincs' }, { session: {} }),
    /crm_ismeretlen_esemeny/,
  )
})

test('az idővonal nem hozza a teljes szöveget; azt külön kell kérni', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'note',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'rövid',
    sourceSystem: 'manual', sourceId: 'n1', body: 'a teljes szöveg' })

  const tl = await byName.crm_timeline.execute({ accountId: acc.id }, { session: {} })
  assert.equal('content' in tl.events[0], false)

  const body = await byName.crm_event_body.execute({ eventId: event.id }, { session: {} })
  assert.equal(body.content, 'a teljes szöveg')
})

test('a crm_timeline elfogadja és érvényesíti a beforeId-t egy egy másodpercen osztozó csoportnál', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  const t = '2026-09-01T10:00:00.000Z'
  const { event: a } = await repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: t,
    excerpt: 'a', sourceSystem: 'manual', sourceId: 'tie_a' })
  const { event: b } = await repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: t,
    excerpt: 'b', sourceSystem: 'manual', sourceId: 'tie_b' })

  const page1 = await byName.crm_timeline.execute({ accountId: acc.id, limit: 1 }, { session: {} })
  assert.equal(page1.events.length, 1)
  const legregebbi = page1.events[0]

  const page2 = await byName.crm_timeline.execute(
    { accountId: acc.id, before: legregebbi.occurred_at, beforeId: legregebbi.id, limit: 1 },
    { session: {} },
  )
  assert.equal(page2.events.length, 1)
  assert.notEqual(page2.events[0].id, legregebbi.id)
  assert.deepEqual([page1.events[0].id, page2.events[0].id].sort(), [a.id, b.id].sort())
})

/** A `mailbox` szerződés dublőre, ugyanaz az alak, mint a sweep sajét tesztjeiben. */
function fakeMailbox(uzenetek) {
  return {
    list: async () => ({ ids: uzenetek.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }),
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
}

const LEVEL = (over) => ({
  id: 'msg_1', threadId: 'thr_1', labelIds: ['INBOX'], subject: 'Ajanlat',
  fromName: 'Morvai Dorina', fromEmail: 'dorina@morvai.hu',
  sentAt: '2026-09-01T10:00:00.000Z', text: 'Kerek egy ajanlatot.',
  textInAttachment: false, sizeEstimate: 100, ...over,
})

test('a crm_sweep ugyanazt a torzset hivja, mint az operator gombja', async () => {
  const uzenetek = [LEVEL()]
  const { byName, repo } = toolsOf({ get: () => fakeMailbox(uzenetek) })
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await byName.crm_sweep.execute({}, { session: {} })
  assert.equal(r.scanned, 1)
  assert.equal(r.recorded, 1)
  assert.equal(r.unmatched, 0)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('a crm_sweep masodszor futtatva nem duplikal', async () => {
  const uzenetek = [LEVEL()]
  const { byName, repo } = toolsOf({ get: () => fakeMailbox(uzenetek) })
  const acc = repo.createAccount({ name: 'X' })
  const con = repo.createContact({ accountId: acc.id, name: 'D' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  await byName.crm_sweep.execute({}, { session: {} })
  const masodik = await byName.crm_sweep.execute({}, { session: {} })
  assert.equal(masodik.recorded, 0)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('a crm_sweep szerzodes hianyaban nevesitett hibat ad', async () => {
  const { byName } = toolsOf()
  await assert.rejects(byName.crm_sweep.execute({}, { session: {} }), /crm_nincs_postafiok/)
})
