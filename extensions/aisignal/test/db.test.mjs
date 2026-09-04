import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { memStorage } from './helpers.mjs'

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

test('open -> insert -> finish marks seen and counts', () => {
  const r = fresh()
  const sweep = r.openSweep({ label: 'AI hirlevel', since: '2026-09-01', fetchedIds: ['m1', 'm2'], skipped: 0, leftover: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'm1', headline: 'H', summary: 'S', url: 'https://x', score: 0.5, applyScore: 0.2, why: 'w', linkRead: 1 })
  const done = r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  assert.equal(done.found, 1)
  assert.equal(done.seenMarked, 2)
  assert.equal(done.linksRead, 1)
  assert.deepEqual([...r.seenIds(['m1', 'm2', 'm3'])], ['m1', 'm2'])
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

test('sweeps of different kinds do not shadow each other', () => {
  // latestSweep drives the incremental watermark. If a web sweep could answer
  // for mail, the next mail run would resume from the web run's timestamp and
  // silently skip every newsletter in between.
  const r = fresh()
  const mail = r.openSweep({ label: 'mail', since: '2026-09-01', fetchedIds: ['m1'], skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: mail.id, ok: true, note: '' })
  const web = r.openSweep({ label: 'web', since: '2026-09-02', fetchedIds: ['w1'], skipped: 0, leftover: 0, kind: 'web' })
  r.finishSweep({ sweepId: web.id, ok: true, note: '' })

  assert.equal(r.latestSweep('mail').id, mail.id)
  assert.equal(r.latestSweep('web').id, web.id)
  assert.equal(r.latestSweep().id, mail.id)
  assert.equal(r.latestFinishedSince('mail').since, '2026-09-01')
  assert.equal(r.latestFinishedSince('web').since, '2026-09-02')
  assert.equal(r.latestSweep('rss'), null)
  assert.equal(r.latestFinishedSince('rss'), null)
  assert.equal(r.sweeps(10).length, 2)
  assert.equal(r.counts().sweeps, 2)
})

test('finishSweep is idempotent when the same sweep is finished twice', () => {
  // A retried run, or a crash between the seen-marking and the response, calls
  // this again. Seen ids are INSERT OR IGNORE and the counters are recomputed,
  // so the second call must land on the same numbers rather than doubling them.
  const { storage, repo: r } = freshWithStorage()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: ['m1', 'm2'], skipped: 0, leftover: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'm1', headline: 'h', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 1 })
  const first = r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  const second = r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  assert.deepEqual(second, first)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c, 2)
  assert.equal(r.counts().seen, 2)
  assert.notEqual(r.latestSweep().finished_at, null)
})

test('finishSweep rejects an unknown sweep instead of writing a phantom row', () => {
  const { storage, repo: r } = freshWithStorage()
  assert.throws(() => r.finishSweep({ sweepId: 'nope', ok: true, note: '' }), /unknown sweep nope/)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_sweeps').c, 0)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c, 0)
})

test('failSweep records the failure and closes the sweep', () => {
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: ['m1'], skipped: 0, leftover: 0 })
  r.failSweep(sweep.id, 'gmail_auth', 'token expired')
  const row = r.latestSweep()
  assert.equal(row.ok, 0)
  assert.equal(row.note, 'gmail_auth: token expired')
  assert.notEqual(row.finished_at, null)
  // A failed sweep never marks its messages seen, so the next run refetches them.
  assert.equal(r.counts().seen, 0)
  assert.equal(r.latestFinishedSince('mail'), null)
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

test('seenIds chunks past the SQLite parameter limit', () => {
  // seenIds is fed a whole Gmail page of ids; SQLite caps bound parameters
  // (999 on older builds), so the IN list is chunked rather than built in one go.
  const r = fresh()
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: Array.from({ length: 1200 }, (_, i) => 'm' + i), skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  const seen = r.seenIds(Array.from({ length: 1400 }, (_, i) => 'm' + i))
  assert.equal(seen.size, 1200)
  assert.equal(seen.has('m1199'), true)
  assert.equal(seen.has('m1200'), false)
  assert.equal(r.seenIds([]).size, 0)
})
