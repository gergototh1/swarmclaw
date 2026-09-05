import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MAILBOX_CONTRACT,
  MAILBOX_CONTRACT_VERSION,
  OUTBOX_MEZOK,
  createMailboxContract,
} from '../src/contract.mjs'
import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { GmailError } from '../src/hibak.mjs'
import { UZENET_MEZOK } from '../src/olvasas.mjs'
import { memStorage } from './helpers.mjs'

/**
 * The contract boundary: which methods exist, and which fields cross.
 *
 * NOTHING HERE REACHES GOOGLE. Every case runs against a client double injected
 * through `clientFactory`, and several of them deliberately answer with MORE
 * fields than the boundary declares, because the property being pinned is that
 * the extra ones do not travel.
 *
 * The two things these cases exist to catch are the two that a reviewer cannot
 * see by reading one file: a method appearing on the contract that belongs to
 * the operator's own page, and a field reaching a consumer because it was added
 * to a shared answer somewhere below.
 */

/** The six, in the order design spec 6.1 lists them. Written out rather than derived: this list is the boundary. */
const HAT_METODUS = ['mailbox', 'labels', 'list', 'get', 'draft', 'outbox']

/** Names that are on the rpc and must never be on the contract. */
const TILTOTT_METODUSOK = ['releaseDraft', 'discardDraft', 'label', 'addRecipient', 'retireRecipient', 'health', 'mcpConfig', 'board', 'attempts', 'liveDraft', 'search', 'read']

const TARGY = 'Havi jelentes'
const TORZS = 'Szia, itt a jelentes.'

/** A client double. Each answer carries a field the boundary does not declare, so a pass-through would show. */
function ketto({ profil = 'operator@example.test', uzenet, cimkek, lap, draftHiba } = {}) {
  const hivasok = { createDraft: [], list: [], get: [] }
  return {
    hivasok,
    async mailbox() { return profil },
    async labels() {
      return cimkek || [{ id: 'Label_1', name: 'AI Signal', type: 'user', color: 'piros' }]
    },
    async list(args) {
      hivasok.list.push(args)
      return lap || { ids: ['m1', 'm2'], nextCursor: 'kurzor-1', complete: false, stoppedOn: 'cap', rawPageCount: 2 }
    },
    async get(id) {
      hivasok.get.push(id)
      return uzenet || {
        id,
        threadId: 't1',
        labelIds: ['INBOX'],
        subject: 'Targy',
        fromName: 'Idegen',
        fromEmail: 'idegen@example.test',
        sentAt: '2026-09-01T10:00:00.000Z',
        text: 'Torzs',
        textInAttachment: false,
        sizeEstimate: 512,
        // Three fields the read layer's own projection drops. If any of them
        // reaches a consumer, the projection stopped being an allowlist.
        rfcMessageId: '<abc@example.test>',
        to: 'operator@example.test',
        authenticationResults: 'spf=pass',
      }
    },
    async createDraft({ raw }) {
      hivasok.createDraft.push(raw)
      if (draftHiba) throw draftHiba
      return { draftId: 'd1', messageId: 'md1' }
    },
  }
}

function fresh({ settings = {}, client = ketto() } = {}) {
  const storage = memStorage()
  for (const m of MIGRATIONS) storage.raw.exec(m.sql)
  const repo = createRepo(storage)
  const state = {
    repo,
    settings: () => settings,
    clientFactory: () => client,
    oauth: { getGoogleAccessToken: async () => 'token' },
    log: { info() {}, warn() {}, error() {} },
  }
  repo.addCimzett({ handle: 'dorina', cim: 'dorina@example.test' })
  return { storage, repo, state, client, contract: createMailboxContract(state) }
}

/** The refusal itself. `assert.rejects` answers nothing, and these cases read the code. */
async function dobas(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected a refusal, got a return')
}

test('the contract declares exactly the six methods of design spec 6.1', () => {
  const { contract } = fresh()
  assert.deepEqual(Object.keys(contract.methods), HAT_METODUS)
  assert.equal(MAILBOX_CONTRACT, 'mailbox')
  assert.equal(MAILBOX_CONTRACT_VERSION, 1)
  assert.equal(contract.version, MAILBOX_CONTRACT_VERSION)
})

test('the contract offers no method that sends, labels, writes the address book or reports the credential', () => {
  const { contract } = fresh()
  for (const nev of TILTOTT_METODUSOK) {
    assert.equal(contract.methods[nev], undefined, `${nev} must not be reachable through the contract`)
    assert.equal(Object.prototype.hasOwnProperty.call(contract.methods, nev), false)
  }
})

test('the summary tells the operator the text is a stranger and the consumer guards it', () => {
  const { contract } = fresh()
  assert.match(contract.summary, /idegen/)
  assert.match(contract.summary, /a fogyasztó őrzi/)
  // And says the one thing a consumer must not assume it can do.
  assert.match(contract.summary, /Küldeni ez a szerződés nem tud/)
})

test('the contract and the page rpc share no code, so a field added for the page cannot join the contract', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const contractForras = fs.readFileSync(path.join(dir, 'contract.mjs'), 'utf8')
  const rpcForras = fs.readFileSync(path.join(dir, 'rpc.mjs'), 'utf8')
  assert.equal(/^import .*from '\.\/rpc\.mjs'/m.test(contractForras), false, 'contract.mjs must not import from rpc.mjs')
  assert.equal(/^import .*from '\.\/contract\.mjs'/m.test(rpcForras), false, 'rpc.mjs must not import from contract.mjs')
})

test('outbox hands over exactly OUTBOX_MEZOK, and neither the body nor the resolved addresses', async () => {
  const h = fresh()
  await h.contract.methods.draft({ cimzettHandlek: ['dorina'], targy: TARGY, szoveg: TORZS })
  const lap = await h.contract.methods.outbox({})
  assert.equal(lap.total, 1)
  assert.equal(lap.count, 1)
  const sor = lap.items[0]
  assert.deepEqual(Object.keys(sor), [...OUTBOX_MEZOK])
  for (const tiltott of ['torzs', 'cimzett_cimek', 'cimzettCimek', 'hibaSzoveg', 'hiba_szoveg', 'valaszUzenetId', 'konyvonKivul']) {
    assert.equal(Object.prototype.hasOwnProperty.call(sor, tiltott), false, `${tiltott} must not cross the contract`)
  }
  // The handles do cross, because the caller passed them in; the addresses they
  // resolve to do not, because the book is the gate.
  assert.deepEqual(sor.cimzettHandlek, ['dorina'])
  assert.equal(sor.ajto, 'szerzodes')
  assert.equal(sor.allapot, 'piszkozat')
  assert.equal(sor.targy, TARGY)
  assert.equal(typeof sor.torzsHash, 'string')
})

test('OUTBOX_MEZOK is the eleven names of design spec 6.1 and is frozen', () => {
  assert.deepEqual([...OUTBOX_MEZOK], [
    'id', 'allapot', 'cimzettHandlek', 'targy', 'torzsHash',
    'gmailDraftId', 'gmailMessageId', 'ajto', 'createdAt', 'kiadvaAt', 'hibaKod',
  ])
  assert.equal(Object.isFrozen(OUTBOX_MEZOK), true)
})

test('outbox carries the fifth state: a send that did not answer is neither sent nor failed', async () => {
  const h = fresh()
  await h.contract.methods.draft({ cimzettHandlek: ['dorina'], targy: TARGY, szoveg: TORZS })
  const [sor] = h.repo.kimenok({})
  h.repo.markBizonytalan(sor.id, { kod: 'gmail_timeout', szoveg: 'a keres nem ert veget' })

  const lap = await h.contract.methods.outbox({ allapot: 'bizonytalan' })
  assert.equal(lap.total, 1)
  const tetel = lap.items[0]
  assert.equal(tetel.allapot, 'bizonytalan')
  // Neither receipt of a send is invented for it, and the cause is a code, not
  // the transport's own sentence.
  assert.equal(tetel.gmailMessageId, null)
  assert.equal(tetel.kiadvaAt, null)
  assert.equal(tetel.hibaKod, 'gmail_timeout')
  assert.equal(Object.prototype.hasOwnProperty.call(tetel, 'hibaSzoveg'), false)

  // And it is not listed as a draft, so nothing that reads the queue for
  // releasable rows can find it.
  const piszkozatok = await h.contract.methods.outbox({ allapot: 'piszkozat' })
  assert.equal(piszkozatok.total, 0)
})

test('outbox refuses a state outside the vocabulary by name instead of answering an empty page', async () => {
  const h = fresh()
  const err = await dobas(h.contract.methods.outbox({ allapot: 'kiadvaa' }))
  assert.ok(err instanceof GmailError)
  assert.equal(err.code, 'gmail_allapot_ismeretlen')
})

test('a contract refusal throws rather than answering a value the caller could mistake for a result', async () => {
  const h = fresh()
  const err = await dobas(h.contract.methods.get({}))
  assert.ok(err instanceof GmailError)
  assert.equal(err.code, 'gmail_argumentum_alak')
  // The refusal is not wrapped as `{ error }` the way the rpc's answers are.
  assert.equal(typeof err.code, 'string')
})

test('get projects onto the ten read fields and drops the headers the read layer refuses to hand out', async () => {
  const h = fresh()
  const uzenet = await h.contract.methods.get({ id: 'm1' })
  assert.deepEqual(Object.keys(uzenet), [...UZENET_MEZOK])
  for (const tiltott of ['rfcMessageId', 'to', 'authenticationResults']) {
    assert.equal(Object.prototype.hasOwnProperty.call(uzenet, tiltott), false, `${tiltott} must not cross the contract`)
  }
})

test('list hands over the four page facts and nothing the client added beside them', async () => {
  const h = fresh()
  const lap = await h.contract.methods.list({ labelIds: ['INBOX'], q: 'from:idegen@example.test', max: 2 })
  assert.deepEqual(Object.keys(lap), ['ids', 'nextCursor', 'complete', 'stoppedOn'])
  assert.equal(lap.complete, false)
  assert.equal(lap.nextCursor, 'kurzor-1')
  assert.equal(lap.stoppedOn, 'cap')
  // The query reaches the client literally: a stored frontier depends on it.
  assert.equal(h.client.hivasok.list[0].q, 'from:idegen@example.test')
})

test('mailbox answers the address alone', async () => {
  const h = fresh()
  const valasz = await h.contract.methods.mailbox()
  assert.deepEqual(valasz, { address: 'operator@example.test' })
})

test('labels hands over id, name and type, and not the colour the client also had', async () => {
  const h = fresh()
  const cimkek = await h.contract.methods.labels()
  assert.deepEqual(cimkek, [{ id: 'Label_1', name: 'AI Signal', type: 'user' }])
})

test('draft answers the five fields the caller needs and records the contract door', async () => {
  const h = fresh()
  const valasz = await h.contract.methods.draft({ cimzettHandlek: ['dorina'], targy: TARGY, szoveg: TORZS })
  assert.deepEqual(Object.keys(valasz), ['kimenoId', 'gmailDraftId', 'cimzettek', 'targy', 'torzsHash'])
  // The caller's own recipients come back resolved, because the caller named
  // them: there is nothing here it did not already have.
  assert.deepEqual(valasz.cimzettek, [{ handle: 'dorina', cim: 'dorina@example.test' }])
  const [sor] = h.repo.kimenok({})
  assert.equal(sor.ajto, 'szerzodes')
  assert.equal(sor.allapot, 'piszkozat')
})

test('a draft from the contract cannot be released through the contract', async () => {
  const h = fresh()
  const { kimenoId } = await h.contract.methods.draft({ cimzettHandlek: ['dorina'], targy: TARGY, szoveg: TORZS })
  assert.equal(typeof kimenoId, 'string')
  // There is no method to call, and the row stays a draft: the only way out of
  // that state is the operator's own page.
  assert.equal(contractHasSend(h.contract), false)
  assert.equal(h.repo.kimeno(kimenoId).allapot, 'piszkozat')
})

/** True if any method name on the contract could plausibly send. A search, not a lookup, so a renamed release is still caught. */
function contractHasSend(contract) {
  return Object.keys(contract.methods).some((nev) => /send|kuld|release|kiad/i.test(nev))
}

test('a recipient that is not in the book refuses the whole draft and leaves an attempt row', async () => {
  const h = fresh()
  const err = await dobas(h.contract.methods.draft({
    cimzettHandlek: ['accounts@attacker.test'],
    targy: TARGY,
    szoveg: TORZS,
  }))
  assert.equal(err.code, 'gmail_cimzett_cim_literal')
  assert.equal(h.repo.kimenok({}).length, 0)
  const [kiserlet] = h.repo.kiserletek(10)
  assert.equal(kiserlet.kod, 'gmail_cimzett_cim_literal')
  assert.equal(kiserlet.ajto, 'szerzodes')
})

/**
 * The host's cap on `summary`, from `MAX_DECLARATION_TEXT` in
 * `src/lib/server/extensions/extension-contracts.ts`. Repeated as a literal
 * because an extension may not import from the host's `src/`.
 */
const MAX_DECLARATION_TEXT = 200

test('the contract summary fits the host cap, because a longer one stops the whole extension loading', () => {
  const { summary } = createMailboxContract({})
  // Found on a running host, not by a unit test: at 223 characters the host
  // refused the declaration at `load.contracts`, so the module had no contract,
  // no rpc and no page -- and three such loads disable the extension. The
  // length is the whole assertion; the wording is not this test's business.
  assert.ok(summary.length > 0, 'the summary is required')
  assert.ok(summary.length <= MAX_DECLARATION_TEXT, `summary is ${summary.length} characters, cap is ${MAX_DECLARATION_TEXT}`)
})
