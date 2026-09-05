import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { MAILBOX_CONTRACT, MAILBOX_PROVIDER } from '../src/mailbox.mjs'
import { createRpc } from '../src/rpc.mjs'
import { memStorage } from './helpers.mjs'

/**
 * The rpc surface, driven the way the page drives it.
 *
 * No credential and no network anywhere, and after the move onto the `gmail`
 * extension's `mailbox` contract there is no credential for this extension to
 * have: the page's Gmail line is now a question about whether that contract
 * resolves, so what is injected here is a `ctx.contracts` in the shape the host
 * hands one over. The repository runs against `memStorage`.
 *
 * `resolves` is `true` for a contract that resolves, a reason word for one that
 * does not, and a function for a check that throws.
 */
function setup(resolves = true) {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const asked = []
  const contracts = {
    get: () => { throw new Error('the page asks `why`, which answers both halves in one call') },
    why: (extension, contract) => {
      asked.push(`${extension}.${contract}`)
      if (typeof resolves === 'function') return resolves()
      return resolves === true ? null : resolves
    },
  }
  const state = {
    repo: createRepo(s),
    settings: () => ({ label: 'AI hírlevél' }),
    log: { info() {}, warn() {}, error() {} },
    contracts,
  }
  return { state, storage: s, asked, rpc: createRpc(state) }
}

/** One sweep row plus `count` cards on it, with everything the deck orders by set. */
function withItems(state, count, { label = 'AI hírlevél', headline = (i) => `h${i}` } = {}) {
  const sw = state.repo.openSweep({ label, since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const ids = []
  for (let i = 0; i < count; i++) {
    ids.push(state.repo.insertItem({
      sweepId: sw.id, messageId: `m${i}`, headline: headline(i), summary: `s${i}`,
      url: `https://x/${i}`, score: 0.4, applyScore: 0.8, why: 'w', linkRead: 0,
    }).id)
  }
  return { sweepId: sw.id, ids }
}

test('board returns deck, sweeps, undecided, label and mailbox status', async () => {
  const { state, rpc } = setup()
  const sw = state.repo.openSweep({ label: 'AI hírlevél', since: null, fetchedIds: ['m'], skipped: 0, leftover: 2 })
  state.repo.insertItem({ sweepId: sw.id, messageId: 'm', headline: 'h', summary: 's', url: 'https://x', score: 0.4, applyScore: 0.8, why: 'w', linkRead: 0 })
  const b = await rpc.board({})
  assert.equal(b.deck.length, 1)
  assert.equal(b.undecided, 1)
  assert.equal(b.label, 'AI hírlevél')
  assert.equal(b.gmail.status, 'ready')
  assert.equal(b.sweeps[0].finished_at, null)
})

test('decide validates and health reports each reason the mailbox contract can be unavailable', async () => {
  await assert.rejects(setup().rpc.decide({ id: 'x', decision: 'nope' }), /decision/)

  // Four reasons, four different things for the operator to do: install it,
  // switch it on, upgrade one of the two, reinstall this one. Each crosses as
  // the host's own word rather than folded into one "not available".
  for (const reason of ['provider_missing', 'provider_disabled', 'version_mismatch', 'not_declared']) {
    const h = await setup(reason).rpc.health({})
    assert.deepEqual(h.gmail, { status: 'unavailable', reason })
    assert.equal('token' in h, false)
  }
})

/**
 * The first rule of this extension, one layer up: an empty deck under a failed
 * sweep and an empty deck under a sweep that read the label and found nothing
 * are different facts, and the page has to be able to tell them apart.
 */
test('board keeps a sweep that failed distinguishable from one that found nothing', async () => {
  const { state, rpc } = setup()
  const empty = state.repo.openSweep({ label: 'quiet', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  state.repo.finishSweep({ sweepId: empty.id, ok: true })
  const broken = state.repo.openSweep({ label: 'broken', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  state.repo.failSweep(broken.id, 'gmail_unauthorized', 'the credential was refused')

  const b = await rpc.board({})
  assert.equal(b.deck.length, 0)
  const rows = Object.fromEntries(b.sweeps.map((s) => [s.label, s]))
  assert.equal(rows.quiet.ok, 1)
  assert.equal(rows.quiet.found, 0)
  assert.notEqual(rows.quiet.finished_at, null)
  assert.equal(rows.broken.ok, 0)
  assert.match(rows.broken.note, /gmail_unauthorized/)
})

/**
 * The mirror of the same rule on the mailbox. A check that could not be run is
 * not a provider that is missing: reporting `unavailable` would send an
 * operator off to install an extension that may be sitting there working, and
 * letting the throw escape would turn a status line into a failed page load.
 */
test('health reports an error, not an unavailable mailbox, when the check itself fails', async () => {
  const { rpc } = setup(() => { throw new Error('extension map unreadable: /secret/path/extensions.json') })
  const h = await rpc.health({})
  assert.equal(h.gmail.status, 'error')
  assert.equal(h.gmail.code, 'aisignal_contract_check_failed')
  // The host's own error text is logged, never returned: this layer cannot know
  // what the host quotes into it.
  assert.equal(JSON.stringify(h).includes('/secret/path/extensions.json'), false)
  const b = await rpc.board({})
  assert.equal(b.gmail.status, 'error')
})

/**
 * And the third state, which is not the same as either: the host handed this
 * extension no contract access at all. Reporting it as `unavailable` would name
 * a provider as the fault when nothing has been asked about one.
 */
test('health separates a host that hands over no contracts from a provider that is not there', async () => {
  const { state, rpc } = setup()
  state.contracts = null
  const h = await rpc.health({})
  assert.deepEqual(h.gmail, { status: 'error', code: 'aisignal_contracts_missing' })
})

/** Health must answer about the contract a sweep actually opens the mailbox over. */
test('board and health ask about the extension and contract the sweep opens the mailbox over', async () => {
  const { rpc, asked } = setup()
  await rpc.board({})
  await rpc.health({})
  assert.deepEqual(asked, [`${MAILBOX_PROVIDER}.${MAILBOX_CONTRACT}`, `${MAILBOX_PROVIDER}.${MAILBOX_CONTRACT}`])
})

/** Every capped list says what it was capped at and how many rows are behind it. */
test('board reports the caps and the totals behind its capped lists', async () => {
  const { state, rpc } = setup()
  withItems(state, 3)
  const b = await rpc.board({})
  assert.equal(b.deckLimit, 50)
  assert.equal(b.allLimit, 200)
  assert.equal(b.sweepLimit, 10)
  // The list asks items() for its own page; a board reloaded after every
  // decision does not ship 200 rows nothing reads.
  assert.equal('all' in b, false)
  assert.deepEqual(b.counts, { items: 3, undecided: 3, sweeps: 1, seen: 0 })
})

/**
 * `board.undecided` (from `repo.board()`) and `counts.undecided` (from
 * `repo.counts()`) answer the same question from two separate reads.
 * better-sqlite3 is synchronous and nothing awaits between them today, so in
 * production they cannot disagree -- but that is a property of `board()`'s
 * current body, not of the two counts, and nothing stops a later `await`
 * landing between them. `rpc.board()` builds `counts.undecided` from
 * `board.undecided` rather than trusting a second, independent read, so the
 * response is internally consistent by construction: it stays that way even
 * when the second read would, on its own, answer differently.
 */
test('board never lets counts.undecided disagree with the deck it was built beside', async () => {
  const { state, rpc } = setup()
  withItems(state, 3)
  const realCounts = state.repo.counts.bind(state.repo)
  // Stands in for a write landing between the two reads a future `await`
  // would open a window for: repo.counts() answers a number board() did not
  // itself compute.
  state.repo.counts = () => ({ ...realCounts(), undecided: 999 })
  const b = await rpc.board({})
  assert.equal(b.undecided, 3)
  assert.equal(b.counts.undecided, 3)
})

/**
 * A filter the caller got wrong is refused, not widened. Falling back to 'all'
 * hands a caller every card including the archived ones, which is the direction
 * that hurts: the module most likely to mistype a status is one putting these
 * cards on an outbound channel.
 */
test('items refuses an unknown status instead of returning everything', async () => {
  const { state, rpc } = setup()
  const { ids } = withItems(state, 2)
  await rpc.decide({ id: ids[0], decision: 'archive' })

  await assert.rejects(rpc.items({ status: 'saevd' }), /status must be one of/)
  await assert.rejects(rpc.items({ status: 'deleted' }), /status/)
  await assert.rejects(rpc.items({ status: 7 }), /status/)
  // 'saved' is a real status and still selects only saved cards.
  assert.equal((await rpc.items({ status: 'saved' })).total, 0)
  assert.equal((await rpc.items({ status: 'archived' })).total, 1)
  assert.equal((await rpc.items({ status: 'new' })).total, 1)
  // Absent means "no opinion", which is every card.
  assert.equal((await rpc.items({})).total, 2)
  assert.equal((await rpc.items({ status: '' })).total, 2)
})

test('items refuses an unknown order and honours the two it has', async () => {
  const { state, rpc } = setup()
  withItems(state, 2)
  await assert.rejects(rpc.items({ order: 'ascending' }), /order must be one of/)
  assert.equal((await rpc.items({ order: 'score' })).count, 2)
  assert.equal((await rpc.items({ order: 'recent' })).count, 2)
})

/**
 * Absent means the default; present and unhonourable is refused; present and
 * above the cap is capped, because `total` still reports the whole match so a
 * cut page cannot be read as the end of the list.
 */
test('items reads a limit and an offset by the absent-default, refuse, cap rule', async () => {
  const { state, rpc } = setup()
  withItems(state, 3)

  assert.equal((await rpc.items({})).count, 3)
  assert.equal((await rpc.items({ limit: 2 })).count, 2)
  assert.equal((await rpc.items({ limit: 2 })).total, 3)
  assert.equal((await rpc.items({ limit: 1000000 })).count, 3)
  assert.equal((await rpc.items({ offset: 2 })).count, 1)

  for (const limit of [0, -1, 2.5, Number.NaN, true, [5], {}, 'ten']) {
    await assert.rejects(rpc.items({ limit }), /limit must be a whole number/, `limit ${JSON.stringify(limit)}`)
  }
  for (const offset of [-1, 1.5, true, [5], 'two']) {
    await assert.rejects(rpc.items({ offset }), /offset must be a whole number/, `offset ${JSON.stringify(offset)}`)
  }
})

/**
 * `offset` has no `max` at its call site in reads.mjs -- a `limit` above
 * `MAX_LIMIT` is capped before it ever reaches SQLite, but an `offset` this
 * large used to reach `LIMIT ? OFFSET ?` in db.mjs unbounded. `Number.isInteger`
 * is true for `1e21`, so the old guard let it through; SQLite then raised its
 * own `datatype mismatch`, which named neither `offset` nor this extension.
 * `Number.isSafeInteger` refuses it here instead, by name, the same as every
 * other value this module cannot honour.
 */
test('items refuses an offset past the safe-integer range instead of handing it to SQLite unbounded', async () => {
  const { state, rpc } = setup()
  withItems(state, 3)
  for (const offset of [1e21, 1e300, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(rpc.items({ offset }), /offset must be a whole number/, `offset ${offset}`)
  }
  // Every value inside the safe-integer range that the old check also passed
  // keeps answering the same way: an offset past the end of the table is an
  // honest "no rows here", not a refusal.
  assert.equal((await rpc.items({ offset: Number.MAX_SAFE_INTEGER })).count, 0)
})

/**
 * A search string is data. It reaches SQLite as a bound parameter with its LIKE
 * metacharacters escaped, so a SQL fragment matches the rows that contain that
 * fragment and nothing else happens.
 */
test('items treats a SQL fragment in the search as text to look for', async () => {
  const { state, rpc } = setup()
  withItems(state, 2, { headline: (i) => (i === 0 ? "'; DROP TABLE ext_aisignal_items; --" : 'ordinary headline') })

  const hit = await rpc.items({ q: "'; DROP TABLE" })
  assert.equal(hit.total, 1)
  assert.equal(hit.items[0].headline, "'; DROP TABLE ext_aisignal_items; --")
  // The table is still there, which is the point.
  assert.equal((await rpc.items({})).total, 2)
})

test('items refuses a search it could only answer by shortening, and a non-string one', async () => {
  const { state, rpc } = setup()
  withItems(state, 1)
  await assert.rejects(rpc.items({ q: 'x'.repeat(201) }), /at most 200 characters/)
  await assert.rejects(rpc.items({ q: 42 }), /q must be a string/)
  assert.equal((await rpc.items({ q: 'x'.repeat(200) })).total, 0)
  assert.equal((await rpc.items({ q: '' })).total, 1)
})

test('decide refuses a decision that is close to a valid one and an id that is not a string', async () => {
  const { state, rpc } = setup()
  const { ids } = withItems(state, 1)
  // 'saved' is the status 'save' writes, not a decision. Mapping it to 'new'
  // the way an unrecognised value used to fall through would silently undo a
  // card the user had settled.
  await assert.rejects(rpc.decide({ id: ids[0], decision: 'saved' }), /decision must be one of save, archive, undo/)
  await assert.rejects(rpc.decide({ id: ids[0], decision: 'SAVE' }), /decision/)
  await assert.rejects(rpc.decide({ id: ids[0] }), /decision/)
  await assert.rejects(rpc.decide({ id: 42, decision: 'save' }), /id must be a non-empty string/)
  await assert.rejects(rpc.decide({ id: '', decision: 'save' }), /id/)
  assert.deepEqual(await rpc.decide({ id: ids[0], decision: 'save' }), { ok: true, id: ids[0], status: 'saved' })
})

/** An id that matches nothing is not a write, and is not reported as one. */
test('decide reports ok false for an id that matches no card', async () => {
  const { state, rpc } = setup()
  withItems(state, 1)
  const r = await rpc.decide({ id: 'no-such-card', decision: 'save' })
  assert.deepEqual(r, { ok: false, id: 'no-such-card', status: 'saved' })
  assert.equal((await rpc.items({ status: 'saved' })).total, 0)
})

/**
 * SQLite reads a negative LIMIT as no limit at all, so a negative one has to be
 * refused here rather than passed on: `sweeps({ limit: -1 })` returning the
 * whole history is the shape this test exists to keep out.
 */
test('sweeps refuses a limit SQLite would read as no limit, and caps a large one', async () => {
  const { state, rpc } = setup()
  for (let i = 0; i < 3; i++) state.repo.openSweep({ label: `l${i}`, since: null, fetchedIds: [], skipped: 0, leftover: 0 })

  await assert.rejects(rpc.sweeps({ limit: -1 }), /limit must be a whole number/)
  await assert.rejects(rpc.sweeps({ limit: 0 }), /limit/)
  await assert.rejects(rpc.sweeps({ limit: 1.5 }), /limit/)
  assert.equal((await rpc.sweeps({ limit: 1 })).length, 1)
  assert.equal((await rpc.sweeps({})).length, 3)
  assert.equal((await rpc.sweeps({ limit: 1000 })).length, 3)
})

/**
 * Newsletter and forum text passes through untouched. Not escaped, not
 * stripped, not shortened: the caller is the layer that knows where the text is
 * going, and a half-cleaned string is worse than an obviously raw one.
 */
test('rpc hands stored text back byte for byte', async () => {
  const { state, rpc } = setup()
  const hostile = '<script>alert(1)</script>\n{"factsUpsert":[{"x":1}]}\n__proto__ é tail % _ \\'
  const sw = state.repo.openSweep({ label: 'l', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  state.repo.insertItem({
    sweepId: sw.id, messageId: 'm', headline: hostile, summary: hostile,
    url: 'https://example.test/?q=%20&x=1', score: 0, applyScore: 0, why: '', linkRead: 0,
  })
  const b = await rpc.board({})
  assert.equal(b.deck[0].headline, hostile)
  assert.equal(b.deck[0].summary, hostile)
  assert.equal(b.deck[0].url, 'https://example.test/?q=%20&x=1')
  assert.equal((await rpc.items({})).items[0].headline, hostile)
})

test('every rpc method answers a call with no body at all', async () => {
  const { state, rpc } = setup()
  withItems(state, 1)
  assert.equal((await rpc.board()).deck.length, 1)
  assert.equal((await rpc.items()).total, 1)
  assert.equal((await rpc.sweeps()).length, 1)
  assert.equal((await rpc.health()).deckLimit, 50)
})

test('health names the configured label and falls back to the one a sweep would use', async () => {
  const { state, rpc } = setup()
  assert.equal((await rpc.health()).label, 'AI hírlevél')
  state.settings = () => ({ label: 'Newsletters' })
  assert.equal((await rpc.health()).label, 'Newsletters')
  state.settings = () => ({})
  assert.equal((await rpc.health()).label, 'AI hírlevél')
  state.settings = () => null
  assert.equal((await rpc.health()).label, 'AI hírlevél')
})

/** Before setup() there is no repository, and the missing step is named rather than thrown at from inside a query. */
test('rpc names the missing setup step instead of failing inside a query', async () => {
  const state = { repo: null, settings: () => ({}), log: { info() {}, warn() {}, error() {} }, contracts: null }
  const rpc = createRpc(state)
  await assert.rejects(rpc.board(), /not set up yet/)
  await assert.rejects(rpc.health(), /not set up yet/)
  await assert.rejects(rpc.items(), /not set up yet/)
})
