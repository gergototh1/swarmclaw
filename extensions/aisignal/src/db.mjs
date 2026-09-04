import crypto from 'node:crypto'

/**
 * Schema and repository for AI Signal.
 *
 * Two shapes only: a *sweep* is one pass over a source (a Gmail label, later an
 * open-web fetch), and an *item* is one line that pass produced. Everything the
 * UI and the tools do is a read or a write against these, so the repository is
 * pure logic over the storage handle and can be tested without the host.
 *
 * The column set is carried over from a working Python implementation. Several
 * columns exist because of a bug that only showed up in production; those are
 * called out individually below, because the DDL alone does not explain them
 * and the obvious "simplification" reintroduces the bug.
 */
export const MIGRATIONS = [{
  version: 1,
  sql: `
CREATE TABLE IF NOT EXISTS ext_aisignal_sweeps (
  id TEXT PRIMARY KEY, ran_at TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', since TEXT,
  messages INTEGER NOT NULL DEFAULT 0, found INTEGER NOT NULL DEFAULT 0, links_read INTEGER NOT NULL DEFAULT 0,
  run_id TEXT, ok INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', finished_at TEXT,
  leftover INTEGER NOT NULL DEFAULT 0, fetched_ids TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'mail'
);
CREATE INDEX IF NOT EXISTS ext_aisignal_sweeps_ran ON ext_aisignal_sweeps (ran_at);
CREATE TABLE IF NOT EXISTS ext_aisignal_items (
  id TEXT PRIMARY KEY, sweep_id TEXT NOT NULL, message_id TEXT NOT NULL, headline TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', url TEXT, source_name TEXT, source_email TEXT, sent_at TEXT,
  score REAL NOT NULL DEFAULT 0, apply_score REAL NOT NULL DEFAULT 0, why TEXT NOT NULL DEFAULT '',
  link_read INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', decided_at TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ext_aisignal_items_msg_url ON ext_aisignal_items (message_id, COALESCE(url, ''));
CREATE TABLE IF NOT EXISTS ext_aisignal_seen (message_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
`,
}]

/*
 * Why the sweep columns look like this
 * -----------------------------------
 * `fetched_ids` holds the source ids the sweep pulled, as a JSON array, and the
 * seen-marking is deferred to finishSweep instead of happening at fetch time.
 * Marking a message seen the moment it is fetched loses it forever if the run
 * dies before scoring: the message is seen, so it is never fetched again, and
 * it was never turned into an item. Keeping the ids on the sweep row makes the
 * pass all-or-nothing -- a sweep that fails leaves nothing marked and the next
 * run picks the same messages back up.
 *
 * `finished_at` is what separates "still running or died" from "completed", and
 * `ok` cannot do that job: it defaults to 1, so an abandoned sweep would read
 * as a success. Anything that resumes from the last good watermark has to test
 * both (see latestFinishedSince).
 *
 * `leftover` is how many messages the per-run cap left behind, so the UI can
 * say how much is still waiting and the next run knows to go again immediately.
 * `messages` is the size of the batch actually fetched, `found` how many items
 * came out of it, `links_read` how many of those were written after really
 * fetching the linked page.
 *
 * `kind` exists because a second source was added later and every "latest
 * sweep" read has to be per-kind. Sharing one series meant an open-web sweep
 * answered the question "when did we last read mail?", the mail run resumed
 * from the web run's timestamp, and every newsletter in between was skipped
 * without a trace.
 *
 * `since` is the watermark the run actually used, nullable for a first or full
 * pass. `run_id` links the sweep back to the agent run that produced it, and
 * `note` carries both the skipped count and any failure text.
 *
 * Why the item key is (message_id, COALESCE(url, ''))
 * --------------------------------------------------
 * One newsletter carries many links, so message_id alone is not unique. url
 * alone is not either: an item can have no link at all. The pair is the key --
 * but SQLite treats NULLs as distinct in a unique index, so a plain
 * UNIQUE (message_id, url) silently enforces nothing for the rows that have no
 * url, and every re-run of a sweep inserts another copy of them. The index is
 * therefore on the expression COALESCE(url, ''), and the lookup in insertItem
 * spells the key exactly the same way so it can use that index.
 *
 * `score` and `apply_score` are separate because ranking the deck by raw
 * relevance floated big-name announcements above things that were actually
 * worth acting on; apply_score is the "would this change what I do?" axis and
 * it is what the deck orders by. `link_read` records whether the summary came
 * from the linked article or only from the newsletter blurb, which is the
 * difference between a summary and a guess.
 *
 * `created_at` is what the recent list orders by, not `sent_at`: the source's
 * own timestamp is frequently missing or wrong, and ordering by it made items
 * appear above ones swept days later.
 *
 * `ext_aisignal_seen` is separate from the items table because a message can be
 * swept and produce no items at all. Deriving "seen" from items would refetch
 * and rescore those messages on every single run, forever.
 */

const now = () => new Date().toISOString()
const uid = () => crypto.randomBytes(8).toString('hex')

/**
 * Newest sweep first. `ran_at` is an ISO millisecond string, so two sweeps
 * opened inside the same tick tie on it and would come back in whatever order
 * the query planner picked. `rowid` breaks the tie by insertion order, which is
 * the answer every caller of these three reads wants anyway.
 */
const SWEEP_ORDER = 'ran_at DESC, rowid DESC'

/** The complete decision vocabulary decide() accepts, and the status each writes. */
const DECISION_STATUS = { save: 'saved', archive: 'archived', undo: 'new' }

/**
 * Sweep notes are '; '-joined segments; re-adding a segment already present is
 * a no-op so finishSweep stays idempotent.
 *
 * The addition is split on the same separator before the containment check.
 * A closing note can itself carry several segments (e.g. "partial page; rate
 * limited"), and checking that whole string against the single-segment
 * `parts` array never finds a match, so a retried sweep would append it again
 * on every call.
 */
function joinNote(existing, addition) {
  const parts = (existing || '').split('; ').filter(Boolean)
  for (const p of (addition || '').split('; ').filter(Boolean)) {
    if (!parts.includes(p)) parts.push(p)
  }
  return parts.join('; ')
}

/**
 * Bound-parameter chunk for the seen lookup. SQLite's limit has been 32766
 * since 3.32 and was 999 before that, so on any build this runs against today a
 * whole page of ids would bind in one statement. The chunking stays as defence
 * against an old build, not because the current one needs it.
 */
const SEEN_CHUNK = 500

export function createRepo(storage) {
  const S = storage
  return {
    openSweep({ label, since, fetchedIds, skipped, leftover, kind = 'mail', note = '' }) {
      const id = uid()
      const noteText = [skipped ? `skipped=${skipped}` : '', note].filter(Boolean).join('; ')
      S.exec('INSERT INTO ext_aisignal_sweeps (id, ran_at, label, since, messages, fetched_ids, leftover, kind, note) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, now(), label, since, fetchedIds.length, JSON.stringify(fetchedIds), leftover, kind, noteText])
      return { id }
    },
    /**
     * Closes a sweep that blew up. Deliberately does not touch
     * ext_aisignal_seen: the fetched messages stay unseen so the next run
     * retries them.
     */
    failSweep(sweepId, code, message) {
      S.exec('UPDATE ext_aisignal_sweeps SET ok = 0, note = ?, finished_at = ? WHERE id = ?', [`${code}: ${message}`, now(), sweepId])
    },
    /**
     * Closes a sweep: marks its fetched ids seen and recomputes the counters
     * from the items actually written.
     *
     * The closing note is appended to the one openSweep wrote rather than
     * replacing it: the success path passes an empty note, so replacing would
     * drop the `skipped=N` count on every sweep that actually completed, which
     * is exactly the run the count matters for.
     *
     * Safe to call twice. The seen writes are INSERT OR IGNORE, the counts are
     * recomputed rather than incremented, and the note append skips a segment
     * that is already there, so a retry lands on the same row. An unknown sweep
     * id throws instead of quietly marking a batch of messages seen against
     * nothing, which would lose them for good.
     */
    finishSweep({ sweepId, ok = true, note = '' }) {
      return S.transaction(() => {
        const sweep = S.get('SELECT fetched_ids, note FROM ext_aisignal_sweeps WHERE id = ?', [sweepId])
        if (!sweep) throw new Error(`unknown sweep ${sweepId}`)
        const ids = JSON.parse(sweep.fetched_ids || '[]')
        for (const m of ids) S.exec('INSERT OR IGNORE INTO ext_aisignal_seen (message_id, seen_at) VALUES (?, ?)', [m, now()])
        const found = S.get('SELECT COUNT(*) AS c FROM ext_aisignal_items WHERE sweep_id = ?', [sweepId]).c
        const linksRead = S.get('SELECT COUNT(*) AS c FROM ext_aisignal_items WHERE sweep_id = ? AND link_read = 1', [sweepId]).c
        S.exec('UPDATE ext_aisignal_sweeps SET found = ?, links_read = ?, ok = ?, note = ?, finished_at = ? WHERE id = ?', [found, linksRead, ok ? 1 : 0, joinNote(sweep.note, note), now(), sweepId])
        return { sweepId, found, linksRead, seenMarked: ids.length, ok: Boolean(ok) }
      })
    },
    /** Most recent sweep of one kind, finished or not. Always filtered by kind -- see the note on the `kind` column. */
    latestSweep(kind = 'mail') { return S.get(`SELECT * FROM ext_aisignal_sweeps WHERE kind = ? ORDER BY ${SWEEP_ORDER} LIMIT 1`, [kind]) || null },
    /** Watermark to resume from: the last sweep of this kind that both succeeded and completed. */
    latestFinishedSince(kind = 'mail') { return S.get(`SELECT since, ran_at FROM ext_aisignal_sweeps WHERE kind = ? AND ok = 1 AND finished_at IS NOT NULL ORDER BY ${SWEEP_ORDER} LIMIT 1`, [kind]) || null },
    sweeps(limit = 10) { return S.all(`SELECT * FROM ext_aisignal_sweeps ORDER BY ${SWEEP_ORDER} LIMIT ?`, [limit]) },
    /** Which of `ids` have already been swept. Chunked because a source page can carry more ids than SQLite will bind. */
    seenIds(ids) {
      const seen = new Set()
      for (let i = 0; i < ids.length; i += SEEN_CHUNK) {
        const chunk = ids.slice(i, i + SEEN_CHUNK)
        for (const r of S.all(`SELECT message_id FROM ext_aisignal_seen WHERE message_id IN (${chunk.map(() => '?').join(',')})`, chunk)) seen.add(r.message_id)
      }
      return seen
    },
    /**
     * Writes one item, or refreshes the one already stored under the same key.
     *
     * A merge deliberately leaves sweep_id, status and decided_at alone: the
     * item keeps belonging to the sweep that first found it (so `found` is a
     * count of new finds, not of re-sightings) and a decision the user already
     * made is not undone by a later sweep resurfacing the same link.
     */
    insertItem(it) {
      const existing = S.get("SELECT id FROM ext_aisignal_items WHERE message_id = ? AND COALESCE(url, '') = COALESCE(?, '')", [it.messageId, it.url ?? null])
      if (existing) {
        S.exec('UPDATE ext_aisignal_items SET headline = ?, summary = ?, score = ?, apply_score = ?, why = ?, link_read = ? WHERE id = ?',
          [it.headline, it.summary, it.score, it.applyScore, it.why || '', it.linkRead ? 1 : 0, existing.id])
        return { id: existing.id, merged: true }
      }
      const id = uid()
      S.exec('INSERT INTO ext_aisignal_items (id, sweep_id, message_id, headline, summary, url, source_name, source_email, sent_at, score, apply_score, why, link_read, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, it.sweepId, it.messageId, it.headline, it.summary, it.url ?? null, it.sourceName ?? null, it.sourceEmail ?? null, it.sentAt ?? null, it.score, it.applyScore, it.why || '', it.linkRead ? 1 : 0, now()])
      return { id, merged: false }
    },
    /**
     * The searchable list. `total` is the size of the whole match, `count` only
     * of the page returned, because the UI shows "showing N of M".
     *
     * status 'unknown' selects the empty string, not a missing value: rows
     * written before status had a default carry '' rather than NULL, and they
     * are unreachable from any other filter.
     *
     * Both orderings end on `rowid DESC`. `created_at` and `apply_score`/
     * `score` are only as precise as their column, and a whole sweep batch is
     * written inside one millisecond, so ties on those alone leave the order
     * up to the query planner -- a LIMIT/OFFSET walk of tied rows can then
     * return one row on two pages and skip another between them. `rowid`
     * reflects insertion order and is never tied, so it always breaks the tie
     * the same way.
     */
    items({ status = 'all', q = '', order = 'recent', limit = 50, offset = 0 } = {}) {
      const where = []; const p = []
      if (status !== 'all') { where.push('status = ?'); p.push(status === 'unknown' ? '' : status) }
      if (q) {
        // Without ESCAPE the user's own % and _ are pattern syntax, so a search
        // for '100%' matches every headline starting '100' and 'a_b' matches
        // 'axb'. The backslash is escaped first so it cannot escape the escape.
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push("(headline LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')")
        p.push(like, like)
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const o = order === 'score' ? 'apply_score DESC, score DESC, created_at DESC, rowid DESC' : 'created_at DESC, rowid DESC'
      const total = S.get(`SELECT COUNT(*) AS c FROM ext_aisignal_items ${w}`, p).c
      const rows = S.all(`SELECT * FROM ext_aisignal_items ${w} ORDER BY ${o} LIMIT ? OFFSET ?`, [...p, limit, offset])
      return { total, count: rows.length, items: rows }
    },
    /**
     * The decide surface: a capped deck plus the true number still undecided,
     * so a full deck can say how much is behind it instead of implying 50 is all
     * there is.
     *
     * Ends on `rowid DESC` for the same reason `items()` does: a sweep batch
     * ties on `apply_score`, `score` and `created_at` within the millisecond it
     * was written, and without a tiebreaker that never ties the deck can
     * reorder between two calls that see the same rows.
     */
    board(deckLimit = 50) {
      const deck = S.all("SELECT * FROM ext_aisignal_items WHERE status = 'new' ORDER BY apply_score DESC, score DESC, created_at DESC, rowid DESC LIMIT ?", [deckLimit])
      const undecided = S.get("SELECT COUNT(*) AS c FROM ext_aisignal_items WHERE status = 'new'").c
      return { deck, deckLimit, undecided }
    },
    /**
     * 'save' | 'archive' | 'undo'. Undo clears decided_at so an undone card is
     * indistinguishable from one never decided.
     *
     * This layer knows the whole value set, so an unrecognised decision throws
     * rather than falling through to 'new': mapping it there would turn a
     * caller's typo into a silent un-decide of a card the user had settled. An
     * id that matches no row reports ok: false instead of claiming a write that
     * never happened.
     */
    decide(id, decision) {
      const status = DECISION_STATUS[decision]
      if (!status) throw new Error(`unknown decision ${decision}`)
      if (!S.get('SELECT id FROM ext_aisignal_items WHERE id = ?', [id])) return { ok: false, id, status }
      const decidedAt = decision === 'undo' ? null : now()
      S.exec('UPDATE ext_aisignal_items SET status = ?, decided_at = ? WHERE id = ?', [status, decidedAt, id])
      return { ok: true, id, status }
    },
    counts() {
      return {
        items: S.get('SELECT COUNT(*) AS c FROM ext_aisignal_items').c,
        undecided: S.get("SELECT COUNT(*) AS c FROM ext_aisignal_items WHERE status = 'new'").c,
        sweeps: S.get('SELECT COUNT(*) AS c FROM ext_aisignal_sweeps').c,
        seen: S.get('SELECT COUNT(*) AS c FROM ext_aisignal_seen').c,
      }
    },
  }
}
