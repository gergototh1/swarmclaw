import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAIL_KIND, MIGRATIONS, createRepo } from '../src/db.mjs'
import { memStorage } from './helpers.mjs'

/**
 * The mailbox a source belongs to, and the shape a source is named in.
 *
 * The frontier is keyed on the whole resolved source -- kind, account and
 * source id -- so a test that opens a sweep or reads a frontier names all
 * three. `sourceId` stands in for a Gmail label id here; the label *name* is
 * reporting on the sweep row and is not part of the key.
 */
const ACCOUNT = 'owner@example.test'
const src = (sourceId, account = ACCOUNT) => ({ account, sourceId })
const frontierOf = (repo, sourceId, { kind = MAIL_KIND, account = ACCOUNT } = {}) => repo.frontier({ kind, account, sourceId })

/**
 * The space a message id is unique in, which is what the dedup is keyed on: the
 * kind and the mailbox, and deliberately not the label the sweep read. See THE
 * DEDUP KEY.
 */
const space = (account = ACCOUNT, kind = MAIL_KIND) => ({ kind, account })

/** A storage handle with the schema applied, plus the repository over it. */
function fresh() {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  return createRepo(s)
}

/** Same, but keeps the storage handle so a test can read rows the repo does not expose. */
function freshWithStorage() {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  return { storage: s, repo: createRepo(s) }
}

test('every migration table uses the ext_aisignal_ prefix', () => {
  for (const m of MIGRATIONS) {
    for (const t of m.sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) assert.match(t[1], /^ext_aisignal_/)
  }
})

test('every migration index uses the ext_aisignal_ prefix so uninstall drops it', () => {
  // dropExtensionStorage selects sqlite_master by name prefix. An index whose
  // name misses the prefix survives an uninstall and makes the reinstall's
  // CREATE INDEX fail, so the names matter as much as the table names do.
  for (const m of MIGRATIONS) {
    for (const i of m.sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)) assert.match(i[1], /^ext_aisignal_/)
  }
})

test('an install that migrates onto the explicit frontier starts at the whole source', () => {
  // Migration 2 seeds nothing. The alternative was to compute a starting value
  // out of the sweep rows already there, which would mean re-implementing the
  // inference the migration exists to delete -- and a seed even one sweep too
  // new skips mail permanently, while a seed that is too wide costs one
  // re-listing that lands on the dedup.
  //
  // The row is written the way a v1 install wrote it, straight into a table
  // that has no frontier_after column yet, so this really is the old schema.
  const s = memStorage()
  s.raw.exec(MIGRATIONS[0].sql)
  s.exec('INSERT INTO ext_aisignal_sweeps (id, ran_at, label, since, leftover, ok, note, finished_at) VALUES (?,?,?,?,?,?,?,?)',
    ['stale', '2026-08-02', 'x', '2026-08-01', 0, 1, '', '2026-08-02'])

  for (const m of MIGRATIONS.slice(1)) s.raw.exec(m.sql)
  const after = createRepo(s)

  assert.equal(frontierOf(after, 'x'), null)
  assert.equal(s.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier').c, 0)
  // The rows themselves survive, they just stop being the frontier's source.
  assert.equal(after.counts().sweeps, 1)
  assert.equal(s.get('SELECT frontier_after FROM ext_aisignal_sweeps WHERE id = ?', ['stale']).frontier_after, null)
})

test('an install that already holds a kind-keyed frontier row migrates to an empty label-keyed table', () => {
  // Migration 3 re-keys the frontier on (kind, label), which SQLite cannot do
  // in place, and it seeds nothing for the same reason migration 2 did not: the
  // old row does not record which label earned it, and a value handed to the
  // wrong label would be a frontier one sweep too new for that label, which
  // skips its mail permanently. No row reads as null, null is the whole label,
  // and the cost of that is one re-listing per label that lands on the dedup.
  //
  // The sweep the old row's `sweep_id` names is really here, with a label on
  // it, because the rejected alternative was a rename-copy-drop that carried
  // rows over on an INNER JOIN to exactly that row. Without it the fixture only
  // proves an *orphaned* row is dropped, and the carry-over this comment
  // rejects would pass. That carry-over is unsafe on its own terms: under the
  // old keying this sweep's `since` came from the single shared row and may
  // have been another label's much newer value, so its `ran_at` can be far
  // newer than 'AI hirlevel' was ever swept to.
  const s = memStorage()
  s.raw.exec(MIGRATIONS[0].sql)
  s.raw.exec(MIGRATIONS[1].sql)
  s.exec('INSERT INTO ext_aisignal_sweeps (id, ran_at, label, since, leftover, ok, note, finished_at, frontier_after) VALUES (?,?,?,?,?,?,?,?,?)',
    ['old', '2026-09-01T00:00:00.000Z', 'AI hirlevel', '2026-08-20T00:00:00.000Z', 0, 1, '', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'])
  s.exec('INSERT INTO ext_aisignal_frontier (kind, frontier, moved_at, sweep_id) VALUES (?,?,?,?)',
    ['mail', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'old'])

  s.raw.exec(MIGRATIONS[2].sql)

  assert.equal(s.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier').c, 0)
  assert.equal(s.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier WHERE label = ?', ['AI hirlevel']).c, 0)
  // The table really is the new shape, so the value cannot come back through a
  // read that names only the kind.
  assert.deepEqual(s.all('PRAGMA table_info(ext_aisignal_frontier)').map((c) => c.name), ['kind', 'label', 'frontier', 'moved_at', 'sweep_id'])
  // The sweep row itself survives; it just stops being anything the frontier
  // can be derived from.
  assert.equal(s.get('SELECT COUNT(*) AS c FROM ext_aisignal_sweeps').c, 1)
})

test('an install keyed on the label name migrates to an empty table keyed on the resolved source', () => {
  // Migration 4, and the same decision a third time. The old row is keyed on a
  // Gmail label *name*, which is an alias: it does not record which Gmail label
  // that name pointed at, nor which mailbox the credential opened, so there is
  // no source it can honestly be handed to. Carrying it over on a join to the
  // sweep that earned it -- the same rejected alternative as in migration 3 --
  // would hand that value to whatever source the name resolves to *now*, which
  // is precisely the repointing this migration exists to survive.
  const s = memStorage()
  for (const m of MIGRATIONS.slice(0, 3)) s.raw.exec(m.sql)
  s.exec('INSERT INTO ext_aisignal_sweeps (id, ran_at, label, since, leftover, ok, note, finished_at, frontier_after) VALUES (?,?,?,?,?,?,?,?,?)',
    ['old', '2026-09-01T00:00:00.000Z', 'AI hirlevel', '2026-08-20T00:00:00.000Z', 0, 1, '', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'])
  s.exec('INSERT INTO ext_aisignal_frontier (kind, label, frontier, moved_at, sweep_id) VALUES (?,?,?,?,?)',
    ['mail', 'AI hirlevel', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'old'])

  s.raw.exec(MIGRATIONS[3].sql)
  const after = createRepo(s)

  assert.equal(s.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier').c, 0)
  assert.deepEqual(s.all('PRAGMA table_info(ext_aisignal_frontier)').map((c) => c.name), ['kind', 'account', 'source_id', 'frontier', 'moved_at', 'sweep_id'])
  // Whatever the name now resolves to, it starts at the whole source.
  assert.equal(frontierOf(after, 'LBL_NEW'), null)
  assert.equal(frontierOf(after, 'AI hirlevel'), null)
  // And the sweeps carried over say what is true of them: they resolved no
  // source, so nothing can be moved on their behalf.
  assert.equal(s.get('SELECT account, source_id FROM ext_aisignal_sweeps WHERE id = ?', ['old']).account, '')
  assert.equal(s.get('SELECT account, source_id FROM ext_aisignal_sweeps WHERE id = ?', ['old']).source_id, '')
})

test('the frontier key is exactly the dimensions a sweep varies over', () => {
  // The rule stated in THE FRONTIER KEY, asserted rather than described. A key
  // missing any one of these resolves a run against a new source onto some
  // other source's row and inherits its watermark; a key carrying the label
  // *name* as well would make a pure rename look like a new source. Both
  // directions are pinned here, so neither can be changed silently.
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const key = s.all('PRAGMA table_info(ext_aisignal_frontier)').filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
  assert.deepEqual(key, ['kind', 'account', 'source_id'])
})

test('the dedup key is exactly the space a message id is unique in', () => {
  // The rule stated in THE DEDUP KEY, asserted rather than described. The bare
  // message id was the eighth defect of this shape: global across every mailbox
  // the extension ever opened, and gating whether a listed message is ever
  // fetched at all. The mailbox is in the key now. The label id deliberately is
  // not -- inside one mailbox an id denotes one message however many labels
  // carry it -- so both directions are pinned here and neither can drift.
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const key = s.all('PRAGMA table_info(ext_aisignal_seen)').filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
  assert.deepEqual(key, ['kind', 'account', 'message_id'])

  // And the item index carries the same space, so two mailboxes' messages
  // cannot merge into one card.
  const index = s.get("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ext_aisignal_items' AND sql LIKE '%UNIQUE%'").sql
  assert.match(index, /\(kind, account, message_id, COALESCE\(url, ''\)\)/)
})

test('a blank key is refused by the schema, not only by the guard that reads it', () => {
  // "A blank key is not an identity" lived in requireSource and in one guard in
  // finishSweep, which is to say in two places a later edit can walk past. It
  // is a CHECK now, so the tables that gate whether mail is scored say it
  // themselves.
  //
  // What a CHECK is worth depends on the statement that runs into it, and this
  // case only shows that the constraint exists. The frontier write really is a
  // plain `INSERT ... ON CONFLICT ... DO UPDATE`, so this is its path; the seen
  // write is not spelled this way, and the case below drives that one through
  // `finishSweep` instead.
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  assert.throws(() => s.exec('INSERT INTO ext_aisignal_frontier (kind, account, source_id, frontier, moved_at, sweep_id) VALUES (?,?,?,?,?,?)',
    ['mail', '', 'LBL_X', '2026-09-01', '2026-09-01', 's1']), /CHECK/)
  assert.throws(() => s.exec('INSERT INTO ext_aisignal_frontier (kind, account, source_id, frontier, moved_at, sweep_id) VALUES (?,?,?,?,?,?)',
    ['mail', ACCOUNT, '', '2026-09-01', '2026-09-01', 's1']), /CHECK/)
  assert.throws(() => s.exec('INSERT INTO ext_aisignal_seen (kind, account, message_id, seen_at) VALUES (?,?,?,?)',
    ['mail', '', 'm1', '2026-09-01']), /CHECK/)
  assert.throws(() => s.exec('INSERT INTO ext_aisignal_seen (kind, account, message_id, seen_at) VALUES (?,?,?,?)',
    ['', ACCOUNT, 'm1', '2026-09-01']), /CHECK/)
})

test('the seen write is spelled so a blank key raises, not so the row is skipped', () => {
  // The extension has exactly one path that writes ext_aisignal_seen, and the
  // CHECK is only a barrier if that path lets it raise. `INSERT OR IGNORE`, what
  // this write used to be, does not: SQLite downgrades every constraint failure
  // under OR IGNORE to a silently skipped row, CHECK included, so the barrier
  // stopped nothing and said nothing.
  const { storage, repo } = freshWithStorage()

  // A sweep row with a real mailbox and a blank kind. The repository cannot mint
  // one -- requireSource refuses it -- and finishSweep's own guard only looks at
  // the account, so this is the shape that reaches the INSERT holding half a
  // key. It is written directly for exactly that reason: the question here is
  // what the write does when the code above it has not stopped it.
  storage.exec('INSERT INTO ext_aisignal_sweeps (id, ran_at, label, account, source_id, since, messages, fetched_ids, leftover, kind, note, frontier_after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['s1', '2026-09-01T00:00:00.000Z', 'News', ACCOUNT, 'Label_7', null, 1, JSON.stringify(['X']), 0, '', '', '2026-09-01T00:00:00.000Z'])

  // Closed as a failure, so the frontier write is skipped and the seen INSERT
  // is the only statement in the transaction that can raise. The CHECK asserted
  // here is that table's own, not one further down.
  assert.throws(() => repo.finishSweep({ sweepId: 's1', ok: false }), /CHECK constraint failed: kind <> '' AND account <> '' AND message_id <> ''/)
  // And it errs the way every other refusal on this path errs: the transaction
  // rolls back, so nothing is marked seen, the sweep is still open, and every id
  // it holds is still fetchable by a run that can name its source.
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c, 0)
  assert.equal(storage.get('SELECT finished_at FROM ext_aisignal_sweeps WHERE id = ?', ['s1']).finished_at, null)

  // The spelling that was there before, for contrast: no error, and no row.
  storage.exec("INSERT OR IGNORE INTO ext_aisignal_seen (kind, account, message_id, seen_at) VALUES ('', ?, 'X', '2026-09-01T00:00:00.000Z')", [ACCOUNT])
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c, 0, 'skipped in silence, which is what made the CHECK decorative')
})

test('seenMarked counts the rows the close wrote, not the ids it was handed', () => {
  // Under a write that can skip a row, a count of the input is a report of a
  // write that may not have happened.
  const r = fresh()
  const first = r.openSweep({ label: 'News', source: src('Label_7'), since: null, fetchedIds: ['X', 'Y'], skipped: 0, leftover: 0, drained: true })
  assert.equal(r.finishSweep({ sweepId: first.id, ok: true }).seenMarked, 2)

  const again = r.openSweep({ label: 'News', source: src('Label_7'), since: null, fetchedIds: ['Y', 'Z'], skipped: 0, leftover: 0, drained: true })
  assert.equal(r.finishSweep({ sweepId: again.id, ok: true }).seenMarked, 1, 'Y was already marked for this mailbox; only Z is a new row')
})

test('a message swept in one mailbox is not swept in another, and is in every label of its own', () => {
  // The dedup gates whether a listed message is ever fetched, so it has to
  // answer for one mailbox and no other: a hit drops the id out of `fresh`,
  // which keeps it out of `leftover`, which lets the run read as drained and
  // move the frontier past a message nobody scored.
  const r = fresh()
  const first = r.openSweep({ label: 'News', source: src('Label_7'), since: null, fetchedIds: ['X'], skipped: 0, leftover: 0, drained: true })
  r.finishSweep({ sweepId: first.id, ok: true, note: '' })

  assert.deepEqual([...r.seenIds(space(), ['X'])], ['X'])
  assert.deepEqual([...r.seenIds(space('other@example.test'), ['X'])], [], 'another mailbox has never swept this id')
  assert.deepEqual([...r.seenIds(space(ACCOUNT, 'web'), ['X'])], [], 'another kind mints its ids by another rule')
  // The label is deliberately not in the key: inside one mailbox this id is
  // this message, whichever label a run happened to read it under, and it was
  // handed to the agent once already.
  assert.deepEqual([...r.seenIds(space(), ['X'])], ['X'])
})

test('seenIds names the half of its key that is missing instead of answering for another mailbox', () => {
  // Same refusal as `frontier`, for the same reason and with more at stake: the
  // wrong answer here is "already swept", which drops a message before anything
  // looks at it.
  const r = fresh()
  assert.throws(() => r.seenIds({ account: ACCOUNT }, ['m1']), /non-empty kind/)
  assert.throws(() => r.seenIds({ kind: MAIL_KIND }, ['m1']), /non-empty account/)
  assert.throws(() => r.seenIds({ kind: MAIL_KIND, account: '' }, ['m1']), /non-empty account/)
  assert.throws(() => r.seenIds(undefined, ['m1']), /non-empty kind/)
})

test('a sweep that fetched messages but resolved no source marks nothing seen', () => {
  // Blank halves are every unidentified run sharing one bucket, which is the
  // shape being closed. Production cannot produce this row -- a run that
  // fetched anything resolved its source first -- so the refusal is a barrier,
  // and it errs wide: the transaction rolls back, the sweep stays open, and
  // every id it holds is still fetchable.
  const { storage, repo: r } = freshWithStorage()
  const sourceless = r.openSweep({ label: 'x', since: null, fetchedIds: ['m1'], skipped: 0, leftover: 0 })

  assert.throws(() => r.finishSweep({ sweepId: sourceless.id, ok: true, note: '' }), /no key to mark them seen under/)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c, 0)
  assert.equal(r.sweepById(sourceless.id).finished_at, null, 'the sweep is still open, so its messages come back')
  // A sourceless row that fetched nothing still closes, and still moves nothing.
  const empty = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: empty.id, ok: true, note: '' })
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier').c, 0)
})

test('openSweep validates the kind it is going to store, not one the source smuggled in', () => {
  // `requireSource('openSweep', { kind, ...source })` let a `source` carrying
  // its own `kind` override the parameter -- for the validation only, while the
  // INSERT went on using the outer one. A guard advertised as *the* identity
  // gate was checking a key the row does not have: a blank kind on the source
  // refused a call whose kind was fine, and a different one waved through a row
  // stored under something else.
  const { storage, repo: r } = freshWithStorage()
  const opened = r.openSweep({ label: 'x', source: { ...src('LBL_X'), kind: 'web' }, since: null, fetchedIds: [], skipped: 0, leftover: 0, drained: true })
  assert.equal(storage.get('SELECT kind FROM ext_aisignal_sweeps WHERE id = ?', [opened.id]).kind, MAIL_KIND)
  r.finishSweep({ sweepId: opened.id, ok: true, note: '' })
  assert.notEqual(frontierOf(r, 'LBL_X'), null, 'the row landed under the kind it was stored with')
  assert.equal(frontierOf(r, 'LBL_X', { kind: 'web' }), null)

  // And a blank one on the source does not refuse a call that named its kind.
  assert.doesNotThrow(() => r.openSweep({ label: 'x', source: { ...src('LBL_Y'), kind: '' }, since: null, fetchedIds: [], skipped: 0, leftover: 0 }))
  // The halves that really are the key are still refused by name.
  assert.throws(() => r.openSweep({ label: 'x', source: { account: '', sourceId: 'LBL_Z' }, since: null, fetchedIds: [], skipped: 0, leftover: 0 }), /non-empty account/)
})

test('frontier names the half of its key that is missing instead of a SQLite parameter index', () => {
  // A read that guessed a missing half would be a read of some other source's
  // window. Refused -- but refused by name: an unbound parameter surfaced as
  // "Provided value cannot be bound to SQLite parameter 2" in a file that names
  // every other failure.
  const r = fresh()
  assert.throws(() => r.frontier({ kind: MAIL_KIND, sourceId: 'LBL_1' }), /non-empty account/)
  assert.throws(() => r.frontier({ account: ACCOUNT, sourceId: 'LBL_1' }), /non-empty kind/)
  assert.throws(() => r.frontier({ kind: MAIL_KIND, account: ACCOUNT }), /non-empty sourceId/)
  assert.throws(() => r.frontier({ kind: MAIL_KIND, account: ACCOUNT, sourceId: '' }), /non-empty sourceId/)
  assert.throws(() => r.frontier(), /non-empty kind/)
})

test('a sweep that resolved no source moves no frontier, and cannot claim it drained one', () => {
  // The blank columns a run without a resolved source leaves behind are not an
  // identity: they are every unidentified run sharing one row. So a close does
  // not write them, and a run that never named a source is refused the one
  // claim that would hand the frontier a `ran_at`.
  const { storage, repo: r } = freshWithStorage()
  const sourceless = r.openSweep({ label: 'AI hirlevel', since: '2026-09-01', fetchedIds: [], skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: sourceless.id, ok: true, note: '' })

  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier').c, 0)
  assert.equal(frontierOf(r, 'AI hirlevel'), null)
  assert.throws(
    () => r.openSweep({ label: 'AI hirlevel', since: null, fetchedIds: [], skipped: 0, leftover: 0, drained: true }),
    /drained a source it never resolved/,
  )
})

test('open -> insert -> finish marks seen and counts', () => {
  // The sweep names its source because marking an id seen is a statement about
  // one mailbox: an id is unique inside an account and nowhere wider, so the
  // dedup is keyed on (kind, account, message_id) and a run that resolved no
  // mailbox has no key to write one under.
  const r = fresh()
  const sweep = r.openSweep({ label: 'AI hirlevel', source: src('LBL_X'), since: '2026-09-01', fetchedIds: ['m1', 'm2'], skipped: 0, leftover: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'm1', headline: 'H', summary: 'S', url: 'https://x', score: 0.5, applyScore: 0.2, why: 'w', linkRead: 1 })
  // A second item whose summary came from the blurb only, so linksRead has to
  // count fewer than found instead of trivially agreeing with it.
  r.insertItem({ sweepId: sweep.id, messageId: 'm2', headline: 'H2', summary: 'S2', url: 'https://y', score: 0.4, applyScore: 0.1, why: 'w', linkRead: 0 })
  const done = r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  assert.equal(done.found, 2)
  assert.equal(done.seenMarked, 2)
  assert.equal(done.linksRead, 1)
  assert.deepEqual([...r.seenIds(space(), ['m1', 'm2', 'm3'])], ['m1', 'm2'])
  assert.equal(r.latestSweep().finished_at !== null, true)
})

test('decide flips status and undo clears decided_at', () => {
  const { storage, repo: r } = freshWithStorage()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const { id } = r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'h', summary: 's', url: null, score: 0.1, applyScore: 0.9, why: '', linkRead: 0 })
  assert.equal(r.decide(id, 'save').status, 'saved')
  assert.notEqual(storage.get('SELECT decided_at FROM ext_aisignal_items WHERE id = ?', [id]).decided_at, null)
  assert.equal(r.decide(id, 'undo').status, 'new')
  assert.equal(storage.get('SELECT decided_at FROM ext_aisignal_items WHERE id = ?', [id]).decided_at, null)
  assert.equal(r.decide(id, 'archive').status, 'archived')
  assert.equal(r.board(50).deck.length, 0)
})

test('board deck orders by apply_score and caps, undecided is the real count', () => {
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  for (let i = 0; i < 60; i++) {
    r.insertItem({ sweepId: sweep.id, messageId: 'm' + i, headline: 'h' + i, summary: 's', url: null, score: 0.1, applyScore: i / 60, why: '', linkRead: 0 })
  }
  const b = r.board(50)
  assert.equal(b.deck.length, 50)
  assert.equal(b.undecided, 60)
  assert.equal(b.deck[0].apply_score > b.deck[49].apply_score, true)
})

test('items without a url still dedupe on message_id', () => {
  // SQLite treats NULLs as distinct in a unique index, so a plain
  // UNIQUE (message_id, url) would let every re-run insert another copy of an
  // item that has no link. The index and the lookup both go through
  // COALESCE(url, ''), which is what makes this merge instead of duplicate.
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const first = r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'first', summary: 's', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  const second = r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'second', summary: 's2', url: null, score: 0.4, applyScore: 0.5, why: 'w', linkRead: 1 })
  assert.equal(first.merged, false)
  assert.equal(second.merged, true)
  assert.equal(second.id, first.id)
  assert.equal(r.counts().items, 1)
  const only = r.items().items[0]
  assert.equal(only.headline, 'second')
  assert.equal(only.apply_score, 0.5)
  assert.equal(only.link_read, 1)
})

test('a url makes an item distinct from the same message without one', () => {
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  // One newsletter carries many links, so message_id alone cannot be the key.
  r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'no link', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'first link', summary: '', url: 'https://one', score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'second link', summary: '', url: 'https://two', score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  assert.equal(r.counts().items, 3)
})

test('an item that loses the race for its own key merges instead of surfacing a SQLite code', () => {
  // insertItem reads twice and then writes, and the unique index is what really
  // settles the key. The three statements are one transaction now, like
  // finishSweep's; this pins what a writer that still finds the key taken does,
  // because what it used to do was surface a raw SQLITE_CONSTRAINT_UNIQUE out of
  // the recordSignal tool -- a code naming a column list, in a file that names
  // every other failure.
  const { storage, repo } = freshWithStorage()
  const sweep = repo.openSweep({ label: 'News', source: src('Label_7'), since: null, fetchedIds: [], skipped: 0, leftover: 0 })

  // A second writer takes the key in the window between the read and the write.
  // Raw SQL, because a repository call here would try to begin a transaction
  // inside the one insertItem has already begun.
  let armed = true
  const contested = {
    ...storage,
    exec: (sql, p) => {
      if (armed && sql.startsWith('INSERT INTO ext_aisignal_items')) {
        armed = false
        storage.exec('INSERT INTO ext_aisignal_items (id, sweep_id, kind, account, message_id, headline, summary, url, source_name, source_email, sent_at, score, apply_score, why, link_read, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ['winner', sweep.id, MAIL_KIND, ACCOUNT, 'a', 'the writer that got there first', '', 'https://one', null, null, null, 0.1, 0.1, '', 0, '2026-09-01T00:00:00.000Z'])
      }
      return storage.exec(sql, p)
    },
  }

  const out = createRepo(contested).insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'the one that arrived second', summary: 's', url: 'https://one', score: 0.4, applyScore: 0.5, why: 'w', linkRead: 1 })
  assert.deepEqual(out, { id: 'winner', merged: true }, 'the loser merges into the row that won, and reports a merge')
  assert.equal(repo.counts().items, 1)
  const only = repo.items().items[0]
  assert.equal(only.headline, 'the one that arrived second', 'the merge is the ordinary one: display fields refreshed')
  assert.equal(only.apply_score, 0.5)
})

test('the same message id in two mailboxes is two cards, and one mailbox seeing it twice is one', () => {
  // The item key had the dedup's exposure one layer down: two genuinely
  // different messages that share an id and a link merged into one row, so the
  // second mailbox's card silently overwrote the first mailbox's headline and
  // score instead of standing beside it. The mailbox is in the key now, read
  // off the sweep row rather than from the caller.
  const r = fresh()
  const a = r.openSweep({ label: 'News', source: src('Label_7'), since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const b = r.openSweep({ label: 'News', source: src('Label_7', 'other@example.test'), since: null, fetchedIds: [], skipped: 0, leftover: 0 })

  const first = r.insertItem({ sweepId: a.id, messageId: 'X', headline: 'from one mailbox', summary: '', url: 'https://one', score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  const second = r.insertItem({ sweepId: b.id, messageId: 'X', headline: 'from the other', summary: '', url: 'https://one', score: 0.2, applyScore: 0.2, why: '', linkRead: 0 })
  assert.equal(second.merged, false)
  assert.notEqual(second.id, first.id)
  assert.equal(r.counts().items, 2)
  assert.deepEqual(r.items().items.map((i) => i.headline).sort(), ['from one mailbox', 'from the other'])

  // Inside one mailbox the id is still one message, so a re-sighting refreshes
  // the card it already has rather than dealing a second one.
  const again = r.insertItem({ sweepId: a.id, messageId: 'X', headline: 'refreshed', summary: '', url: 'https://one', score: 0.9, applyScore: 0.9, why: '', linkRead: 0 })
  assert.equal(again.merged, true)
  assert.equal(again.id, first.id)
  assert.equal(r.counts().items, 2)

  // An item filed against a sweep that does not exist has no mailbox to be
  // filed under, so it is refused rather than landing in the blank bucket.
  assert.throws(() => r.insertItem({ sweepId: 'nope', messageId: 'X', headline: 'h', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 }), /unknown sweep nope/)
})

test('an install whose dedup was keyed on the bare message id keeps its frontier and its decided cards', () => {
  // Migration 5. Three different answers, because the three tables are three
  // different questions.
  //
  //   seen      dropped. A row names an id and no mailbox, and there is no
  //             honest way to recover which one: a pre-migration-4 sweep row
  //             carries account ''. Keeping it as an answer for every mailbox
  //             is the defect itself, so it goes, and the install re-lists and
  //             re-scores one window. That is the safe direction: a message
  //             scored twice costs a pass, a message skipped is permanent.
  //   frontier  carried over, unlike migrations 3 and 4. Its key is not
  //             changing -- (kind, account, source_id) meant the resolved source
  //             before and means it after -- so no row reaches a source that did
  //             not earn it, and keeping it is what holds the re-scoring above
  //             to one window instead of the whole label.
  //   items     kept and adopted, so the pass that re-scores does not resurface
  //             every card the user had already decided.
  const s = memStorage()
  for (const m of MIGRATIONS.slice(0, 4)) s.raw.exec(m.sql)
  s.exec('INSERT INTO ext_aisignal_sweeps (id, ran_at, label, since, kind, finished_at, frontier_after) VALUES (?,?,?,?,?,?,?)',
    ['old', '2026-09-01T00:00:00.000Z', 'AI hirlevel', null, 'mail', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'])
  s.exec('INSERT INTO ext_aisignal_seen (message_id, seen_at) VALUES (?,?)', ['X', '2026-09-01T00:00:00.000Z'])
  s.exec('INSERT INTO ext_aisignal_items (id, sweep_id, message_id, headline, summary, url, score, apply_score, status, decided_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['card', 'old', 'X', 'already decided', '', 'https://one', 0.5, 0.5, 'archived', '2026-09-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z'])
  s.exec('INSERT INTO ext_aisignal_frontier (kind, account, source_id, frontier, moved_at, sweep_id) VALUES (?,?,?,?,?,?)',
    ['mail', ACCOUNT, 'LBL_X', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'old'])
  // A row with a blank half cannot be written by finishSweep, but the v4 table
  // has no CHECK to stop one, so the copy filters rather than failing.
  s.exec('INSERT INTO ext_aisignal_frontier (kind, account, source_id, frontier, moved_at, sweep_id) VALUES (?,?,?,?,?,?)',
    ['mail', '', '', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z', 'old'])

  s.raw.exec(MIGRATIONS[4].sql)
  const after = createRepo(s)

  // The window this source earned is exactly where its own last close left it.
  assert.equal(frontierOf(after, 'LBL_X'), '2026-09-01T00:00:00.000Z')
  assert.equal(s.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier').c, 1, 'the blank-keyed row did not come across')

  // Nothing claims to have been swept any more, so strictly more ids are
  // eligible to be fetched than before -- which is why this cannot lose mail.
  assert.equal(after.counts().seen, 0)
  assert.deepEqual([...after.seenIds(space(), ['X'])], [])

  // The card kept its kind from the sweep that found it and has no mailbox,
  // because that sweep never resolved one.
  const legacy = s.get('SELECT kind, account, status FROM ext_aisignal_items WHERE id = ?', ['card'])
  assert.equal(legacy.kind, 'mail')
  assert.equal(legacy.account, '')
  assert.equal(legacy.status, 'archived')

  // The re-scoring pass sights the same message again, now under a mailbox.
  // It adopts the card instead of dealing a second one, so the decision the
  // user already made survives the upgrade.
  const sweep = after.openSweep({ label: 'AI hirlevel', source: src('LBL_X'), since: null, fetchedIds: ['X'], skipped: 0, leftover: 0, drained: true })
  const again = after.insertItem({ sweepId: sweep.id, messageId: 'X', headline: 'seen again', summary: '', url: 'https://one', score: 0.5, applyScore: 0.5, why: '', linkRead: 0 })
  assert.equal(again.merged, true)
  assert.equal(again.id, 'card')
  assert.equal(after.counts().items, 1)
  const adopted = s.get('SELECT account, status, decided_at FROM ext_aisignal_items WHERE id = ?', ['card'])
  assert.equal(adopted.account, ACCOUNT)
  assert.equal(adopted.status, 'archived')
  assert.equal(adopted.decided_at, '2026-09-02T00:00:00.000Z')

  // And that pass marks the message seen under a key that names its mailbox.
  after.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  assert.deepEqual([...after.seenIds(space(), ['X'])], ['X'])
  assert.deepEqual([...after.seenIds(space('other@example.test'), ['X'])], [])
})

test('sweeps of different kinds do not shadow each other', () => {
  // The frontier is stored per kind. If a web sweep could answer for mail, the
  // next mail run would resume from the web run's frontier and silently skip
  // every newsletter in between.
  const r = fresh()
  const mail = r.openSweep({ label: 'mail', source: src('S1'), since: '2026-09-01', fetchedIds: ['m1'], skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: mail.id, ok: true, note: '' })
  const web = r.openSweep({ label: 'web', source: src('S1'), since: '2026-09-02', fetchedIds: ['w1'], skipped: 0, leftover: 0, kind: 'web' })
  r.finishSweep({ sweepId: web.id, ok: true, note: '' })

  assert.equal(r.latestSweep('mail').id, mail.id)
  assert.equal(r.latestSweep('web').id, web.id)
  assert.equal(r.latestSweep().id, mail.id)
  assert.equal(frontierOf(r, 'S1'), '2026-09-01')
  assert.equal(frontierOf(r, 'S1', { kind: 'web' }), '2026-09-02')
  assert.equal(r.latestSweep('rss'), null)
  // A kind that has never closed a sweep has no frontier row at all, which
  // reads as the whole source rather than as another kind's answer -- and the
  // source id alone does not carry across kinds either: same id, different
  // series.
  assert.equal(frontierOf(r, 'S1', { kind: 'rss' }), null)
  assert.equal(r.sweeps(10).length, 2)
  assert.equal(r.counts().sweeps, 2)
})

test('sweeps of different sources do not shadow each other either', () => {
  // The same statement one source further out. Keyed on kind alone, the drained
  // run of the quiet source below would have written its `ran_at` over the busy
  // source's window, and the busy source's backlog -- older than that value and
  // outside anything sinceQuery reopens -- would never be listed again.
  const { storage, repo: r } = freshWithStorage()
  const busy = r.openSweep({ label: 'AI hirlevel', source: src('LBL_BUSY'), since: '2026-09-01', fetchedIds: ['m1'], skipped: 0, leftover: 4 })
  r.finishSweep({ sweepId: busy.id, ok: true, note: '' })

  const quiet = r.openSweep({ label: 'Csendes', source: src('LBL_QUIET'), since: null, fetchedIds: [], skipped: 0, leftover: 0, drained: true })
  const quietRanAt = storage.get('SELECT ran_at FROM ext_aisignal_sweeps WHERE id = ?', [quiet.id]).ran_at
  r.finishSweep({ sweepId: quiet.id, ok: true, note: '' })

  assert.equal(frontierOf(r, 'LBL_QUIET'), quietRanAt)
  assert.equal(frontierOf(r, 'LBL_BUSY'), '2026-09-01')
  // A source nobody has swept has no row, which is the whole source rather than
  // some other source's answer -- and the same source id in another mailbox is
  // another source, because user label ids are minted per mailbox.
  assert.equal(frontierOf(r, 'LBL_HARMADIK'), null)
  assert.equal(frontierOf(r, 'LBL_QUIET', { account: 'someone.else@example.test' }), null)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier').c, 2)

  // And the busy source's own next close still moves its own row, and only its
  // own row.
  const again = r.openSweep({ label: 'AI hirlevel', source: src('LBL_BUSY'), since: '2026-09-01', fetchedIds: ['m2'], skipped: 0, leftover: 0, drained: true })
  const againRanAt = storage.get('SELECT ran_at FROM ext_aisignal_sweeps WHERE id = ?', [again.id]).ran_at
  r.finishSweep({ sweepId: again.id, ok: true, note: '' })
  assert.equal(frontierOf(r, 'LBL_BUSY'), againRanAt)
  assert.equal(frontierOf(r, 'LBL_QUIET'), quietRanAt)
})

test('a label renamed in Gmail keeps its window, and a name repointed at another label does not', () => {
  // The two halves of why the key is the resolved source and not the name. The
  // sweep row's `label` is the name the operator typed and nothing reads it
  // back, so renaming a Gmail label -- same id, same mailbox -- resumes exactly
  // where it left off. Pointing that name at a *different* label is a different
  // source, and a different source starts at the whole source rather than
  // inheriting a watermark it never earned.
  const { storage, repo: r } = freshWithStorage()
  const drained = r.openSweep({ label: 'News', source: src('LBL_OLD'), since: null, fetchedIds: ['m1'], skipped: 0, leftover: 0, drained: true })
  const ranAt = storage.get('SELECT ran_at FROM ext_aisignal_sweeps WHERE id = ?', [drained.id]).ran_at
  r.finishSweep({ sweepId: drained.id, ok: true, note: '' })

  // Renamed: the operator now calls it 'News archive', Gmail still calls it
  // LBL_OLD, and the window is where the drained run left it.
  assert.equal(frontierOf(r, 'LBL_OLD'), ranAt)
  // Repointed: the name 'News' now resolves to LBL_NEW, whose backlog is weeks
  // older than the frontier LBL_OLD earned.
  assert.equal(frontierOf(r, 'LBL_NEW'), null)
})

test('openSweep takes the run timestamp its caller stamped', () => {
  // A drained run's frontier is its `ran_at`, and signalSweep takes that value
  // before it asks Gmail for anything, so the frontier can never be newer than
  // the listing it describes. The row has to carry the caller's value rather
  // than a fresh one taken here, or the timestamp moves back to after the
  // listing and mail that arrived during it lands below the frontier.
  const r = fresh()
  const stamped = '2026-09-01T00:00:00.000Z'
  const { id } = r.openSweep({ label: 'x', source: src('LBL_X'), since: null, fetchedIds: [], skipped: 0, leftover: 0, drained: true, ranAt: stamped })
  assert.equal(r.sweepById(id).ran_at, stamped)
  assert.equal(r.sweepById(id).frontier_after, stamped)
  r.finishSweep({ sweepId: id, ok: true, note: '' })
  assert.equal(frontierOf(r, 'LBL_X'), stamped)

  // A caller with no listing behind it says nothing and gets this moment.
  const plain = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  assert.equal(r.sweepById(plain.id).ran_at > stamped, true)
})

test('finishSweep refuses a sweep that is already closed', () => {
  // Closing used to be idempotent, which was safe while closing only marked ids
  // seen and recomputed counters. It moves the frontier now, so a second close
  // is a second chance to move it -- and `failSweep` closes the row of a run
  // that could not list at all, which a single finishSweep({ ok: true }) then
  // reopened as a clean run. The whole sweep row, frontier included, has to be
  // exactly as the first close left it.
  const { storage, repo: r } = freshWithStorage()
  const sweep = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-01', fetchedIds: ['m1', 'm2'], skipped: 0, leftover: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'm1', headline: 'h', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 1 })
  const first = r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  assert.equal(first.found, 1)

  assert.throws(() => r.finishSweep({ sweepId: sweep.id, ok: true, note: '' }), /already closed/)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c, 2)
  assert.equal(r.counts().seen, 2)
  assert.notEqual(r.latestSweep().finished_at, null)
  assert.equal(frontierOf(r, 'LBL_X'), '2026-09-01')
})

test('a failed sweep cannot be reopened as a clean one by closing it', () => {
  // Defect A, end to end at this layer. failSweep opens nothing of its own: the
  // row it closes was opened with leftover 0 and an empty note, which is what
  // a run that drained everything also looks like. Under the old rule one
  // finishSweep call -- with `ok` at its declared default -- turned that row
  // into the newest finished, ok, leftover-0, untruncated sweep, and the
  // frontier jumped to its `ran_at`, stranding the real backlog behind it.
  const r = fresh()
  const backlog = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-08-25T00:00:00.000Z', fetchedIds: [], skipped: 0, leftover: 7 })
  r.finishSweep({ sweepId: backlog.id, ok: true, note: '' })
  assert.equal(frontierOf(r, 'LBL_X'), '2026-08-25T00:00:00.000Z')

  const failed = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  r.failSweep(failed.id, 'gmail_label_missing', 'no Gmail label named "AI hirlevel"')

  assert.throws(() => r.finishSweep({ sweepId: failed.id, ok: true, note: '' }), /already closed/)
  assert.equal(frontierOf(r, 'LBL_X'), '2026-08-25T00:00:00.000Z')
  assert.equal(r.latestSweep().ok, 0)
})

test('a failed sweep carries no frontier a successful close could hand over', () => {
  // The second, independent barrier under defect A: even with the already-
  // closed guard lifted, the row a failed run leaves behind has the
  // `frontier_after` of a run that proved nothing -- its own `since` -- so
  // closing it can only hold the frontier still or pull it back, never advance
  // it. Driving that needs a row failSweep has not closed, and one that carries
  // a source: a failure after the source was resolved (a fetch that broke, say)
  // is the only kind whose row could reach the frontier at all.
  const { storage, repo: r } = freshWithStorage()
  const backlog = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-08-25T00:00:00.000Z', fetchedIds: [], skipped: 0, leftover: 7 })
  r.finishSweep({ sweepId: backlog.id, ok: true, note: '' })

  const failed = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-08-25T00:00:00.000Z', fetchedIds: [], skipped: 0, leftover: 0 })
  r.failSweep(failed.id, 'gmail_fetch_failed', 'HTTP 500')
  storage.exec('UPDATE ext_aisignal_sweeps SET finished_at = NULL WHERE id = ?', [failed.id])

  r.finishSweep({ sweepId: failed.id, ok: true, note: '' })

  const ranAt = storage.get('SELECT ran_at FROM ext_aisignal_sweeps WHERE id = ?', [failed.id]).ran_at
  assert.equal(frontierOf(r, 'LBL_X'), '2026-08-25T00:00:00.000Z')
  assert.notEqual(frontierOf(r, 'LBL_X'), ranAt)
})

test('a drained run hands the frontier its ran_at and a run that left something behind hands its since', () => {
  const { storage, repo: r } = freshWithStorage()
  const held = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-01', fetchedIds: [], skipped: 0, leftover: 4 })
  r.finishSweep({ sweepId: held.id, ok: true, note: '' })
  assert.equal(frontierOf(r, 'LBL_X'), '2026-09-01')

  const cleared = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-01', fetchedIds: ['m1'], skipped: 0, leftover: 0, drained: true })
  const ranAt = storage.get('SELECT ran_at FROM ext_aisignal_sweeps WHERE id = ?', [cleared.id]).ran_at
  r.finishSweep({ sweepId: cleared.id, ok: true, note: '' })
  assert.equal(frontierOf(r, 'LBL_X'), ranAt)
})

test('ok: false leaves the frontier exactly where it was', () => {
  // `ok` is the one thing the agent says that touches the frontier, and it can
  // only hold it still: the value that would have been written is settled on
  // the row before the agent sees the sweep.
  const r = fresh()
  const first = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-01', fetchedIds: [], skipped: 0, leftover: 0, drained: true })
  r.finishSweep({ sweepId: first.id, ok: false, note: '' })
  assert.equal(frontierOf(r, 'LBL_X'), null)

  const second = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-02', fetchedIds: [], skipped: 0, leftover: 2 })
  r.finishSweep({ sweepId: second.id, ok: true, note: '' })
  assert.equal(frontierOf(r, 'LBL_X'), '2026-09-02')

  const third = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-02', fetchedIds: [], skipped: 0, leftover: 0, drained: true })
  r.finishSweep({ sweepId: third.id, ok: false, note: '' })
  assert.equal(frontierOf(r, 'LBL_X'), '2026-09-02')
})

test('finishSweep rejects an unknown sweep instead of writing a phantom row', () => {
  const { storage, repo: r } = freshWithStorage()
  assert.throws(() => r.finishSweep({ sweepId: 'nope', ok: true, note: '' }), /unknown sweep nope/)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_sweeps').c, 0)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c, 0)
})

test('failSweep records the failure and closes the sweep', () => {
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', source: src('LBL_X'), since: null, fetchedIds: ['m1'], skipped: 0, leftover: 0 })
  r.failSweep(sweep.id, 'gmail_auth', 'token expired')
  const row = r.latestSweep()
  assert.equal(row.ok, 0)
  assert.equal(row.note, 'gmail_auth: token expired')
  assert.notEqual(row.finished_at, null)
  // A failed sweep never marks its messages seen, so the next run refetches them.
  assert.equal(r.counts().seen, 0)
  assert.equal(frontierOf(r, 'LBL_X'), null)
})

test('failSweep appends to the note the opening wrote instead of replacing it', () => {
  // A failed sweep is where the difference between the two truncation reasons
  // matters most, so the segments the opening established have to survive the
  // failure: a bare code cannot say what the run had already established.
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 4, leftover: 9, note: 'list_truncated=cap; fetch_failed=2' })
  r.failSweep(sweep.id, 'gmail_fetch_failed', 'HTTP 500')
  assert.equal(r.latestSweep().note, 'skipped=4; list_truncated=cap; fetch_failed=2; gmail_fetch_failed: HTTP 500')

  // Same append twice is the same row, like the finishSweep path.
  r.failSweep(sweep.id, 'gmail_fetch_failed', 'HTTP 500')
  assert.equal(r.latestSweep().note, 'skipped=4; list_truncated=cap; fetch_failed=2; gmail_fetch_failed: HTTP 500')
  assert.equal(r.latestSweep().leftover, 9)
})

test('openSweep records the fetch shape the next run needs', () => {
  const r = fresh()
  r.openSweep({ label: 'AI hirlevel', since: '2026-09-01', fetchedIds: ['m1', 'm2', 'm3'], skipped: 2, leftover: 7 })
  const row = r.latestSweep()
  assert.equal(row.messages, 3)
  assert.equal(row.leftover, 7)
  assert.equal(row.kind, 'mail')
  assert.equal(row.note, 'skipped=2')
  assert.equal(row.finished_at, null)
  assert.deepEqual(JSON.parse(row.fetched_ids), ['m1', 'm2', 'm3'])
})

test('items filters by status and search, and reports the unfiltered page size', () => {
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const a = r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'agents everywhere', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'b', headline: 'other news', summary: 'about agents', url: null, score: 0.1, applyScore: 0.9, why: '', linkRead: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'c', headline: 'unrelated', summary: '', url: null, score: 0.1, applyScore: 0.5, why: '', linkRead: 0 })
  r.decide(a.id, 'save')

  assert.equal(r.items({ status: 'saved' }).total, 1)
  assert.equal(r.items({ status: 'new' }).total, 2)
  assert.equal(r.items({ q: 'agents' }).total, 2)
  assert.equal(r.items({ q: 'agents', status: 'new' }).total, 1)
  const byScore = r.items({ order: 'score', limit: 2 })
  assert.equal(byScore.total, 3)
  assert.equal(byScore.count, 2)
  assert.deepEqual(byScore.items.map((i) => i.message_id), ['b', 'c'])
  assert.deepEqual(r.items({ order: 'score', limit: 2, offset: 2 }).items.map((i) => i.message_id), ['a'])
})

test('seenIds answers for more ids than one chunk holds', () => {
  // seenIds is fed a whole Gmail page of ids and splits the IN list into
  // SEEN_CHUNK-sized queries. Current SQLite would bind all of them in one go,
  // so what this actually checks is that the chunking stitches the chunks back
  // together correctly, not that the limit is reached.
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', source: src('LBL_X'), since: null, fetchedIds: Array.from({ length: 1200 }, (_, i) => 'm' + i), skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  const seen = r.seenIds(space(), Array.from({ length: 1400 }, (_, i) => 'm' + i))
  assert.equal(seen.size, 1200)
  assert.equal(seen.has('m1199'), true)
  assert.equal(seen.has('m1200'), false)
  assert.equal(r.seenIds(space(), []).size, 0)
  // Every chunk is asked about one mailbox, so another mailbox's answer is
  // empty rather than 1200 ids it never swept.
  assert.equal(r.seenIds(space('someone.else@example.test'), Array.from({ length: 1400 }, (_, i) => 'm' + i)).size, 0)
})

test('finishSweep keeps the skipped count openSweep recorded', () => {
  // The cap leaves messages behind on a perfectly successful run, and the note
  // is the only place that number is kept. Closing the sweep with SET note = ?
  // would drop it every time, because the success path passes an empty note.
  const r = fresh()
  const capped = r.openSweep({ label: 'x', source: src('LBL_X'), since: null, fetchedIds: ['m1'], skipped: 40, leftover: 40 })
  r.finishSweep({ sweepId: capped.id, ok: true, note: '' })
  assert.equal(r.latestSweep().note, 'skipped=40')

  // A closing note is appended to the opening one, not substituted for it, and
  // a segment the opening already wrote is not appended a second time.
  const noted = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 3, leftover: 0, note: 'partial page' })
  r.finishSweep({ sweepId: noted.id, ok: true, note: 'partial page' })
  assert.equal(r.latestSweep().note, 'skipped=3; partial page')
})

test('finishSweep does not duplicate a multi-segment closing note', () => {
  // joinNote used to check the whole addition against the existing note's
  // single-segment parts, so an addition that itself contains '; ' was never
  // found among them and got appended again.
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', source: src('LBL_X'), since: null, fetchedIds: ['m1'], skipped: 3, leftover: 0, note: 'partial page; rate limited' })
  r.finishSweep({ sweepId: sweep.id, ok: true, note: 'partial page; rate limited' })
  assert.equal(r.latestSweep().note, 'skipped=3; partial page; rate limited')
})

test('items pages through rows with identical created_at exactly once, in insertion order', () => {
  // A sweep writes its whole batch inside one millisecond, so created_at alone
  // ties every row in it. Without a tiebreaker that never ties, SQLite's own
  // stable sort falls back to physical scan order for the tied rows -- oldest
  // first -- which is backwards for a "most recent first" list and, because
  // that fallback is implementation-defined rather than guaranteed, is exactly
  // the kind of ordering a LIMIT/OFFSET walk cannot rely on: nothing stops a
  // later insert into the tied group, a different query plan, or another
  // SQLite build from placing a row on the wrong side of an already-read
  // offset, so the same walk returns a row twice or skips one between pages.
  // `rowid DESC` pins the tie order to insertion order (newest first) so the
  // walk is well-defined regardless.
  const { storage, repo: r } = freshWithStorage()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const ids = []
  for (let i = 0; i < 5; i++) {
    const { id } = r.insertItem({ sweepId: sweep.id, messageId: 'm' + i, headline: 'h' + i, summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
    ids.push(id)
  }
  storage.exec('UPDATE ext_aisignal_items SET created_at = ?', ['2026-09-01T00:00:00.000Z'])
  const expected = ids.slice().reverse() // newest (last inserted) first

  const walked = []
  for (let offset = 0; offset < ids.length; offset += 2) {
    walked.push(...r.items({ limit: 2, offset }).items.map((it) => it.id))
  }
  assert.deepEqual(walked, expected)
  assert.equal(new Set(walked).size, ids.length)
})

test('board deck orders tied apply_score, score and created_at by insertion, newest first', () => {
  // Same tie as above, on the deck query. Without the rowid tiebreaker the
  // deck falls back to oldest-first for a tied batch, which is the wrong
  // order for cards the user expects sorted newest-first, and is not an order
  // the deck can rely on staying put across calls either.
  const { storage, repo: r } = freshWithStorage()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const ids = []
  for (let i = 0; i < 5; i++) {
    const { id } = r.insertItem({ sweepId: sweep.id, messageId: 'm' + i, headline: 'h' + i, summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
    ids.push(id)
  }
  storage.exec('UPDATE ext_aisignal_items SET created_at = ?', ['2026-09-01T00:00:00.000Z'])

  assert.deepEqual(r.board(50).deck.map((it) => it.id), ids.slice().reverse())
})

test('a sweep that started and never finished leaves the frontier alone', () => {
  // ok defaults to 1, so a run that died mid-pass still reads as a success on
  // its row. The frontier does not read rows: it moves in finishSweep and
  // nowhere else, so a run that never got there simply never moved it, however
  // drained the row it left behind looks.
  const { storage, repo: r } = freshWithStorage()
  const completed = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-01', fetchedIds: ['m1'], skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: completed.id, ok: true, note: '' })
  const abandoned = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-02', fetchedIds: ['m2'], skipped: 0, leftover: 0, drained: true })

  const latest = r.latestSweep()
  assert.equal(latest.id, abandoned.id)
  assert.equal(latest.ok, 1)
  assert.equal(latest.finished_at, null)
  assert.equal(frontierOf(r, 'LBL_X'), '2026-09-01')
  // The row does carry the frontier it would have earned, which is exactly why
  // it has to be a close that hands it over rather than a read that finds it.
  assert.notEqual(storage.get('SELECT frontier_after FROM ext_aisignal_sweeps WHERE id = ?', [abandoned.id]).frontier_after, null)
})

test('a merge leaves a decision the user already made alone', () => {
  // A later sweep sighting the same link must not put an archived card back in
  // the deck, so the merge refreshes the scored fields and nothing else.
  const { storage, repo: r } = freshWithStorage()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const { id } = r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'h', summary: 's', url: 'https://one', score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  r.decide(id, 'archive')
  const decidedAt = storage.get('SELECT decided_at FROM ext_aisignal_items WHERE id = ?', [id]).decided_at
  assert.notEqual(decidedAt, null)

  const again = r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'h2', summary: 's2', url: 'https://one', score: 0.9, applyScore: 0.9, why: 'w', linkRead: 1 })
  assert.equal(again.merged, true)
  assert.equal(again.id, id)
  const row = storage.get('SELECT * FROM ext_aisignal_items WHERE id = ?', [id])
  assert.equal(row.headline, 'h2')
  assert.equal(row.apply_score, 0.9)
  assert.equal(row.status, 'archived')
  assert.equal(row.decided_at, decidedAt)
  assert.equal(r.board(50).deck.length, 0)
})

test("items status 'unknown' selects the rows written before status had a default", () => {
  // Those rows carry '' rather than 'new', and no other filter value reaches
  // them, so 'unknown' has to map to the empty string instead of to itself.
  const { storage, repo: r } = freshWithStorage()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const legacy = r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'old row', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'b', headline: 'new row', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  storage.exec("UPDATE ext_aisignal_items SET status = '' WHERE id = ?", [legacy.id])

  const unknown = r.items({ status: 'unknown' })
  assert.equal(unknown.total, 1)
  assert.equal(unknown.items[0].id, legacy.id)
  assert.equal(r.items({ status: 'new' }).total, 1)
  assert.equal(r.items().total, 2)
})

test('sweeps opened in the same millisecond still order newest first', () => {
  // ran_at is an ISO millisecond string, so two sweeps opened inside the same
  // tick tie on it and would otherwise come back in whatever order the query
  // planner happened to pick.
  const { storage, repo: r } = freshWithStorage()
  const first = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-01', fetchedIds: [], skipped: 0, leftover: 0 })
  const second = r.openSweep({ label: 'x', source: src('LBL_X'), since: '2026-09-02', fetchedIds: [], skipped: 0, leftover: 0 })
  storage.exec('UPDATE ext_aisignal_sweeps SET ran_at = ?', ['2026-09-03T00:00:00.000Z'])

  assert.equal(r.latestSweep().id, second.id)
  assert.deepEqual(r.sweeps(10).map((s) => s.id), [second.id, first.id])
  r.finishSweep({ sweepId: first.id, ok: true, note: '' })
  r.finishSweep({ sweepId: second.id, ok: true, note: '' })
  assert.equal(frontierOf(r, 'LBL_X'), '2026-09-02')
})

test('decide rejects an unknown decision and reports an id that matched nothing', () => {
  // Mapping anything unrecognised to 'new' turns a caller's typo into a silent
  // un-decide, and an id that matched no row must not report success.
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  const { id } = r.insertItem({ sweepId: sweep.id, messageId: 'a', headline: 'h', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  r.decide(id, 'save')

  assert.throws(() => r.decide(id, 'archiv'), /unknown decision archiv/)
  assert.equal(r.items().items[0].status, 'saved')
  assert.equal(r.decide('nope', 'save').ok, false)
  assert.equal(r.decide(id, 'archive').ok, true)
})

test('items search treats % and _ as literal characters', () => {
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  for (const [messageId, headline] of [['a', '100% faster'], ['b', '100 faster still'], ['c', 'a_b tooling'], ['d', 'axb tooling']]) {
    r.insertItem({ sweepId: sweep.id, messageId, headline, summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 0 })
  }
  assert.equal(r.items({ q: '100%' }).total, 1)
  assert.equal(r.items({ q: '100%' }).items[0].message_id, 'a')
  assert.equal(r.items({ q: 'a_b' }).total, 1)
  assert.equal(r.items({ q: 'a_b' }).items[0].message_id, 'c')
  assert.equal(r.items({ q: 'faster' }).total, 2)
})
