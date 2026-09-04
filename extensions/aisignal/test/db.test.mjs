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

  assert.equal(after.frontier('mail'), null)
  assert.equal(s.get('SELECT COUNT(*) AS c FROM ext_aisignal_frontier').c, 0)
  // The rows themselves survive, they just stop being the frontier's source.
  assert.equal(after.counts().sweeps, 1)
  assert.equal(s.get('SELECT frontier_after FROM ext_aisignal_sweeps WHERE id = ?', ['stale']).frontier_after, null)
})

test('open -> insert -> finish marks seen and counts', () => {
  const r = fresh()
  const sweep = r.openSweep({ label: 'AI hirlevel', since: '2026-09-01', fetchedIds: ['m1', 'm2'], skipped: 0, leftover: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'm1', headline: 'H', summary: 'S', url: 'https://x', score: 0.5, applyScore: 0.2, why: 'w', linkRead: 1 })
  // A second item whose summary came from the blurb only, so linksRead has to
  // count fewer than found instead of trivially agreeing with it.
  r.insertItem({ sweepId: sweep.id, messageId: 'm2', headline: 'H2', summary: 'S2', url: 'https://y', score: 0.4, applyScore: 0.1, why: 'w', linkRead: 0 })
  const done = r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  assert.equal(done.found, 2)
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
  // The frontier is stored per kind. If a web sweep could answer for mail, the
  // next mail run would resume from the web run's frontier and silently skip
  // every newsletter in between.
  const r = fresh()
  const mail = r.openSweep({ label: 'mail', since: '2026-09-01', fetchedIds: ['m1'], skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: mail.id, ok: true, note: '' })
  const web = r.openSweep({ label: 'web', since: '2026-09-02', fetchedIds: ['w1'], skipped: 0, leftover: 0, kind: 'web' })
  r.finishSweep({ sweepId: web.id, ok: true, note: '' })

  assert.equal(r.latestSweep('mail').id, mail.id)
  assert.equal(r.latestSweep('web').id, web.id)
  assert.equal(r.latestSweep().id, mail.id)
  assert.equal(r.frontier('mail'), '2026-09-01')
  assert.equal(r.frontier('web'), '2026-09-02')
  assert.equal(r.latestSweep('rss'), null)
  // A kind that has never closed a sweep has no frontier row at all, which
  // reads as the whole source rather than as another kind's answer.
  assert.equal(r.frontier('rss'), null)
  assert.equal(r.sweeps(10).length, 2)
  assert.equal(r.counts().sweeps, 2)
})

test('finishSweep refuses a sweep that is already closed', () => {
  // Closing used to be idempotent, which was safe while closing only marked ids
  // seen and recomputed counters. It moves the frontier now, so a second close
  // is a second chance to move it -- and `failSweep` closes the row of a run
  // that could not list at all, which a single finishSweep({ ok: true }) then
  // reopened as a clean run. The whole sweep row, frontier included, has to be
  // exactly as the first close left it.
  const { storage, repo: r } = freshWithStorage()
  const sweep = r.openSweep({ label: 'x', since: '2026-09-01', fetchedIds: ['m1', 'm2'], skipped: 0, leftover: 0 })
  r.insertItem({ sweepId: sweep.id, messageId: 'm1', headline: 'h', summary: '', url: null, score: 0.1, applyScore: 0.1, why: '', linkRead: 1 })
  const first = r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  assert.equal(first.found, 1)

  assert.throws(() => r.finishSweep({ sweepId: sweep.id, ok: true, note: '' }), /already closed/)
  assert.equal(storage.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c, 2)
  assert.equal(r.counts().seen, 2)
  assert.notEqual(r.latestSweep().finished_at, null)
  assert.equal(r.frontier('mail'), '2026-09-01')
})

test('a failed sweep cannot be reopened as a clean one by closing it', () => {
  // Defect A, end to end at this layer. failSweep opens nothing of its own: the
  // row it closes was opened with leftover 0 and an empty note, which is what
  // a run that drained everything also looks like. Under the old rule one
  // finishSweep call -- with `ok` at its declared default -- turned that row
  // into the newest finished, ok, leftover-0, untruncated sweep, and the
  // frontier jumped to its `ran_at`, stranding the real backlog behind it.
  const r = fresh()
  const backlog = r.openSweep({ label: 'x', since: '2026-08-25T00:00:00.000Z', fetchedIds: [], skipped: 0, leftover: 7 })
  r.finishSweep({ sweepId: backlog.id, ok: true, note: '' })
  assert.equal(r.frontier('mail'), '2026-08-25T00:00:00.000Z')

  const failed = r.openSweep({ label: 'x', since: null, fetchedIds: [], skipped: 0, leftover: 0 })
  r.failSweep(failed.id, 'gmail_label_missing', 'no Gmail label named "AI hirlevel"')

  assert.throws(() => r.finishSweep({ sweepId: failed.id, ok: true, note: '' }), /already closed/)
  assert.equal(r.frontier('mail'), '2026-08-25T00:00:00.000Z')
  assert.equal(r.latestSweep().ok, 0)
})

test('a failed sweep carries no frontier a successful close could hand over', () => {
  // The second, independent barrier under defect A: even with the already-
  // closed guard lifted, the row a failed run leaves behind has the
  // `frontier_after` of a run that proved nothing -- its own `since` -- so
  // closing it can only hold the frontier still or pull it back, never advance
  // it. Driving that needs a row failSweep has not closed.
  const { storage, repo: r } = freshWithStorage()
  const backlog = r.openSweep({ label: 'x', since: '2026-08-25T00:00:00.000Z', fetchedIds: [], skipped: 0, leftover: 7 })
  r.finishSweep({ sweepId: backlog.id, ok: true, note: '' })

  const failed = r.openSweep({ label: 'x', since: '2026-08-25T00:00:00.000Z', fetchedIds: [], skipped: 0, leftover: 0 })
  r.failSweep(failed.id, 'gmail_label_missing', 'no label')
  storage.exec('UPDATE ext_aisignal_sweeps SET finished_at = NULL WHERE id = ?', [failed.id])

  r.finishSweep({ sweepId: failed.id, ok: true, note: '' })

  const ranAt = storage.get('SELECT ran_at FROM ext_aisignal_sweeps WHERE id = ?', [failed.id]).ran_at
  assert.equal(r.frontier('mail'), '2026-08-25T00:00:00.000Z')
  assert.notEqual(r.frontier('mail'), ranAt)
})

test('a drained run hands the frontier its ran_at and a run that left something behind hands its since', () => {
  const { storage, repo: r } = freshWithStorage()
  const held = r.openSweep({ label: 'x', since: '2026-09-01', fetchedIds: [], skipped: 0, leftover: 4 })
  r.finishSweep({ sweepId: held.id, ok: true, note: '' })
  assert.equal(r.frontier('mail'), '2026-09-01')

  const cleared = r.openSweep({ label: 'x', since: '2026-09-01', fetchedIds: ['m1'], skipped: 0, leftover: 0, drained: true })
  const ranAt = storage.get('SELECT ran_at FROM ext_aisignal_sweeps WHERE id = ?', [cleared.id]).ran_at
  r.finishSweep({ sweepId: cleared.id, ok: true, note: '' })
  assert.equal(r.frontier('mail'), ranAt)
})

test('ok: false leaves the frontier exactly where it was', () => {
  // `ok` is the one thing the agent says that touches the frontier, and it can
  // only hold it still: the value that would have been written is settled on
  // the row before the agent sees the sweep.
  const r = fresh()
  const first = r.openSweep({ label: 'x', since: '2026-09-01', fetchedIds: [], skipped: 0, leftover: 0, drained: true })
  r.finishSweep({ sweepId: first.id, ok: false, note: '' })
  assert.equal(r.frontier('mail'), null)

  const second = r.openSweep({ label: 'x', since: '2026-09-02', fetchedIds: [], skipped: 0, leftover: 2 })
  r.finishSweep({ sweepId: second.id, ok: true, note: '' })
  assert.equal(r.frontier('mail'), '2026-09-02')

  const third = r.openSweep({ label: 'x', since: '2026-09-02', fetchedIds: [], skipped: 0, leftover: 0, drained: true })
  r.finishSweep({ sweepId: third.id, ok: false, note: '' })
  assert.equal(r.frontier('mail'), '2026-09-02')
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
  assert.equal(r.frontier('mail'), null)
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
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: Array.from({ length: 1200 }, (_, i) => 'm' + i), skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: sweep.id, ok: true, note: '' })
  const seen = r.seenIds(Array.from({ length: 1400 }, (_, i) => 'm' + i))
  assert.equal(seen.size, 1200)
  assert.equal(seen.has('m1199'), true)
  assert.equal(seen.has('m1200'), false)
  assert.equal(r.seenIds([]).size, 0)
})

test('finishSweep keeps the skipped count openSweep recorded', () => {
  // The cap leaves messages behind on a perfectly successful run, and the note
  // is the only place that number is kept. Closing the sweep with SET note = ?
  // would drop it every time, because the success path passes an empty note.
  const r = fresh()
  const capped = r.openSweep({ label: 'x', since: null, fetchedIds: ['m1'], skipped: 40, leftover: 40 })
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
  const sweep = r.openSweep({ label: 'x', since: null, fetchedIds: ['m1'], skipped: 3, leftover: 0, note: 'partial page; rate limited' })
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
  const completed = r.openSweep({ label: 'x', since: '2026-09-01', fetchedIds: ['m1'], skipped: 0, leftover: 0 })
  r.finishSweep({ sweepId: completed.id, ok: true, note: '' })
  const abandoned = r.openSweep({ label: 'x', since: '2026-09-02', fetchedIds: ['m2'], skipped: 0, leftover: 0, drained: true })

  const latest = r.latestSweep()
  assert.equal(latest.id, abandoned.id)
  assert.equal(latest.ok, 1)
  assert.equal(latest.finished_at, null)
  assert.equal(r.frontier('mail'), '2026-09-01')
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
  const first = r.openSweep({ label: 'x', since: '2026-09-01', fetchedIds: [], skipped: 0, leftover: 0 })
  const second = r.openSweep({ label: 'x', since: '2026-09-02', fetchedIds: [], skipped: 0, leftover: 0 })
  storage.exec('UPDATE ext_aisignal_sweeps SET ran_at = ?', ['2026-09-03T00:00:00.000Z'])

  assert.equal(r.latestSweep().id, second.id)
  assert.deepEqual(r.sweeps(10).map((s) => s.id), [second.id, first.id])
  r.finishSweep({ sweepId: first.id, ok: true, note: '' })
  r.finishSweep({ sweepId: second.id, ok: true, note: '' })
  assert.equal(r.frontier('mail'), '2026-09-02')
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
