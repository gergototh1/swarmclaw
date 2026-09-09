import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createSweep } from '../src/sweep.mjs'
import { gmailFakeMailbox, memStorage } from './helpers.mjs'

/**
 * A `mailbox` szerzodes kettose. A Gmail `labelIds` ES-szemantikajat utanzo
 * kozos duplo, NEM egy cimkere kozombos sajat: egy duplo, ami minden levelet
 * visszaad barmilyen cimkelistara, pontosan azt a hibat fedi el, amitol a
 * sopres elesben semmit nem hozott. Lasd `helpers.mjs`.
 */
const fakeMailbox = gmailFakeMailbox

function sweepOf(uzenetek, { settings = () => ({}), mailbox } = {}) {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = {
    repo, log: console, settings,
    contracts: { get: () => mailbox || fakeMailbox(uzenetek) },
  }
  return { sweep: createSweep(state), repo, state }
}

const LEVEL = (over) => ({
  id: 'msg_1', threadId: 'thr_1', labelIds: ['INBOX'], subject: 'Ajanlat',
  fromName: 'Morvai Dorina', fromEmail: 'dorina@morvai.hu',
  sentAt: '2026-09-01T10:00:00.000Z', text: 'Kerek egy ajanlatot.',
  textInAttachment: false, sizeEstimate: 100, ...over,
})

test('ismert cimrol jovo level az ugyfel idovonalara kerul', async () => {
  const { sweep, repo } = sweepOf([LEVEL()])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 1)
  assert.equal(r.unmatched, 0)
  const ev = repo.listEvents({ accountId: acc.id })[0]
  assert.equal(ev.kind, 'email_in')
  assert.equal(ev.source_system, 'gmail')
  assert.equal(ev.source_id, 'msg_1')
  assert.equal(repo.getEventBody(ev.id), 'Kerek egy ajanlatot.')
})

test('a sopres ketszer futtatva nem duplikal', async () => {
  const { sweep, repo } = sweepOf([LEVEL()])
  const acc = repo.createAccount({ name: 'X' })
  const con = repo.createContact({ accountId: acc.id, name: 'D' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  await sweep.runSweep({})
  const masodik = await sweep.runSweep({})
  assert.equal(masodik.recorded, 0, 'a masodik futas semmit nem ir')
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('ismeretlen felado a besorolatlan sorba megy, nem talalgatunk', async () => {
  const { sweep, repo } = sweepOf([LEVEL({ fromEmail: 'senki@sehol.hu' })])
  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0)
  assert.equal(r.unmatched, 1)
  assert.equal(repo.listUnmatched()[0].sender_address, 'senki@sehol.hu')
})

test('domain-egyezes tippel megy a besorolatlanba, nem az idovonalra', async () => {
  const { sweep, repo } = sweepOf([LEVEL({ fromEmail: 'konyveles@morvai.hu' })])
  const acc = repo.createAccount({ name: 'Morvai Kft.', domains: ['morvai.hu'] })

  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0, 'a tipp NEM sorol be')
  assert.equal(repo.listUnmatched()[0].guess_account_id, acc.id)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 0)
})

test('a szerzodes hianya nevesitett hiba, nem csendes nulla', async () => {
  const { sweep } = sweepOf([])
  sweep.__state.contracts = { get: () => null }
  await assert.rejects(() => sweep.runSweep({}), /crm_nincs_postafiok/)
})

// ---- C1: a sentAt nullazhato, es egy hibazo level nem allithatja meg a lapot ----

test('a sentAt nelkuli level kimarad es szamolodik, nem dobja el a sopres futasat', async () => {
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'msg_ok' }),
    LEVEL({ id: 'msg_null_sentat', sentAt: null, fromEmail: 'masik@morvai.hu' }),
  ])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.scanned, 2)
  assert.equal(r.recorded, 1, 'a rendes level bekerul')
  assert.equal(r.failed, 1, 'a nullazott sentAt-u level szamolt, nem dobott hibat')
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
  assert.equal(
    repo.listEvents({ accountId: acc.id }).some((e) => e.source_id === 'msg_null_sentat'),
    false,
    'a nullazott sentAt-u level nem talalgatott datummal kerult be',
  )
})

test('egy hibazo uzenet nem allitja meg a lap tobbi levelenek behuzasat, es a kurzor akkor is frissul', async () => {
  const uzenetek = [
    LEVEL({ id: 'ok1' }),
    LEVEL({ id: 'bad' }),
    LEVEL({ id: 'ok2', fromEmail: 'masik@morvai.hu' }),
  ]
  const mailbox = {
    ...gmailFakeMailbox(uzenetek),
    get: async ({ id }) => {
      if (id === 'bad') throw new Error('gmail_fetch_failed')
      return uzenetek.find((u) => u.id === id)
    },
  }
  const { sweep, repo } = sweepOf(uzenetek, { mailbox })
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con1 = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con1.id, 'dorina@morvai.hu')
  const con2 = repo.createContact({ accountId: acc.id, name: 'Masik' })
  repo.attachEmail(con2.id, 'masik@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.scanned, 3)
  assert.equal(r.failed, 1, 'a hibazo level szamolt')
  assert.equal(r.recorded, 2, 'a ket ep level bekerult a hibazo ellenere')
  assert.deepEqual(
    repo.listEvents({ accountId: acc.id }).map((e) => e.source_id).sort(),
    ['ok1', 'ok2'],
  )
  assert.equal(repo.getSweepState('gmail:all').cursor, '', 'a kurzor akkor is frissult, ha volt hiba')
})

// ---- C2: a listazas hatarolt, es a sajat kimeno level nem kerul be email_in-kent ----

test('a SENT cimkeju level email_out-kent kerul be, nem email_in-kent es nem a besorolatlanba', async () => {
  const { sweep, repo } = sweepOf([LEVEL({ id: 'msg_sent', labelIds: ['SENT'] })])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0, 'a sajat kimeno level nem email_in-kent kerul az idovonalra')
  assert.equal(r.recordedOut, 1, 'a sajat kimeno level email_out-kent szamolodik')
  assert.equal(r.unmatched, 0, 'a sajat kimeno level a besorolatlanba sem kerul')
  const events = repo.listEvents({ accountId: acc.id })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'email_out')
  assert.equal(repo.listUnmatched().length, 0)
})

test('a kimeno level, aminek se pontos cime, se szala, a besorolatlanba sem kerul', async () => {
  // Ha bekerulne, a `sender_address` a MI cimunk volna, es az rpc
  // `assignUnmatched` ezt tanulna meg egy ugyfel cimekent -- csendben
  // elrontva a jovobeli cimillesztest. Lasd src/sweep.mjs.
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'm_out_arva', labelIds: ['SENT'], threadId: 'thr_arva', fromEmail: 'en@sajat.hu' }),
  ])
  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0)
  assert.equal(r.recordedOut, 0)
  assert.equal(r.unmatched, 0)
  assert.equal(repo.listUnmatched().length, 0)
  assert.equal(r.skippedOut, 1, 'a kimarado kimeno level szamolodik, nem tunik el nyomtalanul')
})

test('a listazas alapbol CIMKE NELKUL, a teljes postafiokra megy, 90 napra hatarolva', async () => {
  const kapott = []
  const uzenetek = [LEVEL()]
  const mailbox = {
    list: async (args) => {
      kapott.push(args)
      return { ids: uzenetek.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }
    },
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
  const { sweep } = sweepOf(uzenetek, { mailbox })
  await sweep.runSweep({})
  // EGY hivas, cimke NELKUL. A Gmailnek nincs `ALL_MAIL` cimkeje, tehat a
  // teljes postafiok -- benne az archivalt levellel -- egyetlen modja az,
  // hogy `labelIds` egyaltalan nem megy a hivasba.
  assert.equal(kapott.length, 1, 'egy menet, nem cimkenkent egy-egy')
  assert.equal(kapott[0].labelIds, undefined, 'nem megy cimkeszures a listazasba')
  assert.equal(kapott[0].q, 'newer_than:90d')
})

test('a tarolt sopresCimkek beallitas NEM szukiti a listazast, es ezt naplozza', async () => {
  // A CRM-2 alapertelmezese `'INBOX'` volt. Ha ezt a mezot az operator valaha
  // elmentette, a tiszteletben tartasa pontosan azt a vaksagot allitana
  // vissza, amit ez a sopres megszuntet: az archivalt level kimaradna.
  const kapott = []
  const naplo = []
  const uzenetek = [LEVEL()]
  const mailbox = {
    list: async (args) => {
      kapott.push(args)
      return { ids: [], nextCursor: '', complete: true, stoppedOn: '' }
    },
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
  const { sweep, state } = sweepOf(uzenetek, {
    mailbox,
    settings: () => ({ sopresCimkek: 'Ugyfelek, SENT', sopresCimke: 'INBOX' }),
  })
  state.log = { warn: (msg, meta) => naplo.push({ msg, meta }), info: () => {}, error: () => {} }
  await sweep.runSweep({})
  assert.equal(kapott[0].labelIds, undefined, 'a beallitas nem szurkiti a listazast')
  const fig = naplo.find((n) => n.msg.includes('figyelmen kivul'))
  assert.ok(fig, 'a figyelmen kivul hagyott beallitas nem tunhet el nemán')
  assert.equal(fig.meta.sopresCimkek, 'Ugyfelek, SENT')
})

test('a beallitott lekerdezes felulirja az alapertelmezettet, a cimke nem szamit', async () => {
  const kapott = []
  const uzenetek = [LEVEL()]
  const mailbox = {
    list: async (args) => {
      kapott.push(args)
      return { ids: uzenetek.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }
    },
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
  const { sweep } = sweepOf(uzenetek, {
    mailbox,
    settings: () => ({ sopresCimke: 'Ugyfelek', sopresLekerdezes: 'newer_than:30d' }),
  })
  await sweep.runSweep({})
  assert.equal(kapott[0].labelIds, undefined)
  assert.equal(kapott[0].q, 'newer_than:30d')
})

// ---- Task 1: kimeno levelek behuzasa ----

test('a sajat elkuldott level email_out-kent kerul be, nem email_in-kent', async () => {
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'm_in', labelIds: ['INBOX'], fromEmail: 'dorina@morvai.hu' }),
    LEVEL({ id: 'm_out', labelIds: ['SENT'], threadId: 'thr_1', fromEmail: 'en@sajat.hu' }),
  ])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  await sweep.runSweep({})
  const kinds = repo.listEvents({ accountId: acc.id }).map((e) => e.kind).sort()
  assert.deepEqual(kinds, ['email_in', 'email_out'])
})

test('a kimeno level akkor is a szalhoz kerul, ha a felado ismeretlen', async () => {
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'm_out', labelIds: ['SENT'], threadId: 'thr_x', fromEmail: 'en@sajat.hu' }),
  ])
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-09-01T09:00:00.000Z',
                     excerpt: 'e', sourceSystem: 'gmail', sourceId: 'korabbi', threadId: 'thr_x' })
  const r = await sweep.runSweep({})
  assert.equal(r.recordedOut, 1)
  assert.equal(repo.listEvents({ accountId: acc.id })[0].kind, 'email_out')
})

/**
 * A HIVO CIMKEJE SZUKITES, ES SZUKITESKENT IS KELL VISELKEDNIE.
 *
 * A sopres torzse nem olvas cimket a beallitasbol, de a hivo (rpc `sweepNow`)
 * meg mindig adhat egyet -- ez a diagnozis-ajto. Amit at kell adnia a Gmail
 * szemantikajabol: tobb cimke ES-kapcsolat, tehat `['INBOX','SENT']` garantalt
 * ures halmaz. Ez a hiba egyszer mar elesben elfogyasztott egy sopres-kort
 * ugy, hogy minden teszt zold volt; most legalabb nevesitve naplozzuk.
 */
function naplozoSweep(uzenetek, settings) {
  const naplo = []
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const state = {
    repo: createRepo(S),
    log: { warn: (msg, meta) => naplo.push({ msg, meta }), info: () => {}, error: () => {} },
    settings,
    contracts: { get: () => fakeMailbox(uzenetek) },
  }
  return { sweep: createSweep(state), naplo }
}

test('a hivo tobb cimket adott listaja nevesitett figyelmeztetest kap (ES-kapcsolat)', async () => {
  const { sweep, naplo } = naplozoSweep([], () => ({}))
  await sweep.runSweep({ labelIds: ['INBOX', 'SENT'] })
  const fig = naplo.find((n) => n.msg.includes('ES-kapcsolat'))
  assert.ok(fig, 'a metszet-szemantika nem jelent meg a logban')
  assert.deepEqual(fig.meta.labelIds, ['INBOX', 'SENT'])
})

test('egyetlen cimke atadasa nem ir figyelmeztetest', async () => {
  const { sweep, naplo } = naplozoSweep([], () => ({}))
  await sweep.runSweep({ labelIds: ['INBOX'] })
  assert.equal(naplo.some((n) => n.msg.includes('ES-kapcsolat')), false)
})

test('cimke nelkuli futas nem ir figyelmeztetest', async () => {
  const { sweep, naplo } = naplozoSweep([], () => ({}))
  await sweep.runSweep({})
  assert.equal(naplo.length, 0)
})

/**
 * A REGRESSZIO, AMI ELESBEN NEM SOPORT SEMMIT.
 *
 * A Gmail `users.messages.list` `labelIds` parametere ES-kapcsolat. A sopres
 * alapertelmezese `['INBOX','SENT']` volt, egyetlen listazasban atadva, es
 * mivel egy level sosem all egyszerre a beerkezettben ES az elkuldottben, a
 * valodi Gmail uresen felelt: nulla level, nulla esemeny, nulla nyom.
 * Ezek a tesztek a `gmailFakeMailbox`-szal futnak, ami ezt a szemantikat
 * utanozza -- a cimkere kozombos dublovel mindegyik zold maradna.
 */
test('az alapertelmezett cimkelista mellett a bejovo ES a kimeno level is bekerul', async () => {
  const uzenetek = [
    LEVEL({ id: 'be_1', threadId: 'thr_1', labelIds: ['INBOX'] }),
    LEVEL({ id: 'ki_1', threadId: 'thr_1', labelIds: ['SENT'], fromEmail: 'en@sajat.hu', sentAt: '2026-09-02T10:00:00.000Z' }),
  ]
  const { sweep, repo } = sweepOf(uzenetek, { mailbox: gmailFakeMailbox(uzenetek) })
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.scanned, 2, 'mindket cimke menete lefutott')
  assert.equal(r.recorded, 1, 'a bejovo level az idovonalra kerult')
  assert.equal(r.recordedOut, 1, 'a kimeno level a szalon keresztul az idovonalra kerult')
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 2)
})

test('egy menet, egy kurzor: minden a gmail:all kulcson', async () => {
  const uzenetek = [LEVEL({ id: 'be_1', labelIds: ['INBOX'] })]
  const { sweep, repo } = sweepOf(uzenetek, { mailbox: gmailFakeMailbox(uzenetek) })
  await sweep.runSweep({})
  assert.ok(repo.getSweepState('gmail:all'), 'a teljes postafiok menetenek egyetlen kurzorsora van')
  assert.equal(repo.getSweepState('gmail:INBOX'), null, 'cimkenkenti kurzor mar nem szuletik')
  assert.equal(repo.getSweepState('gmail:SENT'), null, 'cimkenkenti kurzor mar nem szuletik')
  assert.equal(repo.getSweepState('gmail'), null, 'a regi, kozos kulcs sem szuletik ujra')
})

test('el nem fogyott lap nem mondja keszre a futast, es a kurzort megtartja', async () => {
  const uzenetek = [LEVEL({ id: 'be_1', labelIds: ['INBOX'] })]
  const alap = gmailFakeMailbox(uzenetek)
  const mailbox = {
    ...alap,
    list: async (args) => ({ ...(await alap.list(args)), nextCursor: 'kov', complete: false }),
  }
  const { sweep, repo } = sweepOf(uzenetek, { mailbox })
  const r = await sweep.runSweep({})
  assert.equal(r.complete, false, 'a felben allo lapozas nem kesz futas')
  assert.equal(r.cursor, 'kov', 'a kurzor megmarad a kovetkezo futasnak')
  assert.equal(repo.getSweepState('gmail:all').cursor, 'kov')
})

test('a max egeszben megy az egyetlen menetbe, nem elosztva', async () => {
  const kert = []
  const mailbox = {
    list: async ({ labelIds, max }) => {
      kert.push({ labelIds, max })
      return { ids: [], nextCursor: '', complete: true, stoppedOn: '' }
    },
    get: async () => null,
  }
  const { sweep } = sweepOf([], { mailbox })
  await sweep.runSweep({ max: 50 })
  assert.deepEqual(kert, [{ labelIds: undefined, max: 50 }])
})

// ---- Task: az archivalt level is latszik ----

/**
 * AZ ARCHIVALT LEVEL AZ IDOVONALRA VALO, A BESOROLATLANBA NEM.
 *
 * Geri munkamodszere az, hogy amit elintezett, azt kiarchivalja: a level
 * INBOX-ot nem visel, csak `IMPORTANT` / `CATEGORY_PERSONAL` cimket. Az
 * `['INBOX','SENT']` alapertelmezes ezert szerkezetileg vak volt pont arra a
 * levelezesre, amibol egy idovonal all.
 */
test('archivalt level ISMERT kapcsolattartotol bekerul esemenykent', async () => {
  const uzenetek = [LEVEL({ id: 'arch_1', labelIds: ['IMPORTANT', 'CATEGORY_PERSONAL'] })]
  const { sweep, repo } = sweepOf(uzenetek, { mailbox: gmailFakeMailbox(uzenetek) })
  const acc = repo.createAccount({ name: 'Denes Architects' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 1, 'az archivalt level az idovonalra kerult')
  const ev = repo.listEvents({ accountId: acc.id })[0]
  assert.equal(ev.kind, 'email_in')
  assert.equal(ev.source_id, 'arch_1')
})

test('archivalt level ISMERETLEN feladotol nem kerul a besorolatlanba, de szamolt', async () => {
  // A besorolatlan doboz TEENDO-lista, nem archivum: azt kerdezi, hogy "ki
  // ez?", es ennek csak olyan levelnel van ertelme, amivel meg dolgunk van.
  const uzenetek = [
    LEVEL({ id: 'arch_hirlevel', labelIds: ['CATEGORY_PROMOTIONS'], fromEmail: 'noreply@mymedio.hu' }),
    LEVEL({ id: 'inbox_ismeretlen', labelIds: ['INBOX'], fromEmail: 'valaki@ismeretlen.hu' }),
  ]
  const { sweep, repo } = sweepOf(uzenetek, { mailbox: gmailFakeMailbox(uzenetek) })

  const r = await sweep.runSweep({})
  assert.equal(r.scanned, 2)
  assert.equal(r.unmatched, 1, 'csak az INBOX-ban levo ismeretlen level kerult be')
  assert.equal(r.skippedUnmatchedArchived, 1, 'a kihagyas nem nema')
  assert.deepEqual(
    repo.listUnmatched({}).map((u) => u.source_id),
    ['inbox_ismeretlen'],
  )
})
