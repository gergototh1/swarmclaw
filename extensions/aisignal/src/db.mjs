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
}, {
  /*
   * The frontier, made explicit.
   *
   * It used to be inferred on every read: take the newest finished, ok sweep,
   * look at its `leftover`, regex-match a `list_truncated=` segment out of its
   * free-text `note`, and conclude from those two whether its `ran_at` or its
   * `since` was the point to resume from. Five separate defects of that one
   * shape were found and patched in that derivation, and the last two came from
   * inputs the agent supplies -- a `note` segment it can write, and an `ok` it
   * can send at a sweep `failSweep` had already closed. So the conclusion stops
   * being redrawn and becomes a value the sweep code writes down.
   *
   * `frontier_after` on the sweep row is the frontier this sweep earns if it
   * closes successfully. `signalSweep` decides it at the moment it knows -- see
   * THE FRONTIER in sweep.mjs -- and `openSweep` writes it before the agent is
   * handed anything, so nothing the agent says afterwards can change it. NULL is
   * "the whole label", which is the widest window there is.
   *
   * `ext_aisignal_frontier` holds the current value, one row per source kind for
   * the same reason `kind` exists on the sweep row: a web sweep must never
   * answer "when did we last read mail?". `finishSweep` is the only writer.
   * Migration 3 re-keys the same table on the label as well, for the same
   * reason one kind further; see below.
   *
   * Existing installs start with no row at all, which reads as NULL, which is
   * the whole label. That is deliberate, and it is the only seed that is
   * provably safe: any value copied out of the old rows would have to be
   * computed by the very inference this migration exists to delete, and a seed
   * that came out even one sweep too new would skip mail permanently. The cost
   * of starting wide is one re-listing that lands on the dedup.
   */
  version: 2,
  sql: `
ALTER TABLE ext_aisignal_sweeps ADD COLUMN frontier_after TEXT;
CREATE TABLE IF NOT EXISTS ext_aisignal_frontier (
  kind TEXT PRIMARY KEY, frontier TEXT, moved_at TEXT NOT NULL, sweep_id TEXT NOT NULL
);
`,
}, {
  /*
   * The frontier is per label, not only per kind.
   *
   * Migration 2 keyed `ext_aisignal_frontier` on `kind` alone, so every mail
   * sweep wrote the same row whatever label it had swept. A run that drained a
   * quiet label stamped its own `ran_at` onto the single mail frontier, and the
   * busy label resumed from it: its backlog was then older than the frontier
   * and outside the window `sinceQuery` re-opens, so it was never listed again
   * and the dedup could not save messages nobody listed. The label reaches a
   * sweep either from the tool argument or from the operator's `label` setting,
   * so changing that setting -- an ordinary configuration act -- was enough to
   * strand a backlog.
   *
   * This is the statement `kind` already makes one source further out: a series
   * that answers "when did we last read this source?" has to be one series per
   * source, or it answers for a source it never read. Two labels are two
   * sources.
   *
   * SQLite cannot re-key a table in place, so the table is dropped and rebuilt
   * on (kind, label) -- and rebuilt *empty*. The alternative was to carry the
   * old row over under the label of the sweep its `sweep_id` names, which would
   * preserve one value; it also makes the migration depend on that sweep row
   * still being there and on its label being the one that earned the value,
   * which is the invariant this migration introduces rather than one the old
   * data was written under. Empty is unconditional, and it is safe in the only
   * direction that matters: no row reads as NULL, NULL is the whole label, and
   * the whole label is the widest window there is, so no install comes out of
   * this with a frontier *newer* than the rule below would produce for a given
   * label. The cost is one re-listing per label, and it lands on the dedup; the
   * cost of a value one sweep too new is mail skipped permanently.
   */
  version: 3,
  sql: `
DROP TABLE IF EXISTS ext_aisignal_frontier;
CREATE TABLE IF NOT EXISTS ext_aisignal_frontier (
  kind TEXT NOT NULL, label TEXT NOT NULL, frontier TEXT, moved_at TEXT NOT NULL, sweep_id TEXT NOT NULL,
  PRIMARY KEY (kind, label)
);
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
 * as a success. It is also what makes closing a sweep a one-time event: an
 * already-closed row has moved the frontier once, and finishSweep refuses to
 * let it move it again.
 *
 * `leftover` is how many messages the per-run cap left behind, so the UI can
 * say how much is still waiting and the next run knows to go again immediately.
 * `messages` is the size of the batch actually fetched, `found` how many items
 * came out of it, `links_read` how many of those were written after really
 * fetching the linked page. All four are reporting: the frontier stopped being
 * derived from `leftover`, and from the note, in migration 2.
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
 * The source kind of a newsletter sweep, and the default of every read that
 * takes one.
 *
 * Exported rather than spelled `'mail'` at each site because the literal had
 * started to live in two files -- a parameter default here and a call argument
 * in sweep.mjs -- and the open-web source brings a second kind. One series
 * answering for a source it never read is exactly what the `kind` column exists
 * to prevent, so the two files must not be able to disagree about how the mail
 * series is spelled.
 */
export const MAIL_KIND = 'mail'

/**
 * The refusal both closing paths speak.
 *
 * `finishSweep` here and `recordSignal` in sweep.mjs turn an already-closed
 * sweep away for neighbouring reasons, and the sentence was typed out in both
 * files. Two copies of one rule drift on the first edit to either, and the
 * agent reading them would get two accounts of the same refusal.
 */
export const alreadyClosedMessage = (sweepId) => `sweep ${sweepId} is already closed; open a new one with signalSweep`

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
 * a no-op, so a note built up across openSweep and failSweep never doubles a
 * segment.
 *
 * The note is diagnostic and nothing else. It carried a load-bearing segment
 * until migration 2: `list_truncated=<reason>` was regex-matched back out of
 * this column to decide whether a sweep could become the next run's watermark,
 * which made a column the agent can append to part of the safety rule. The
 * frontier is stored state now (`frontier_after`, and `ext_aisignal_frontier`),
 * nothing reads this column back, and the format is free to change.
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
    /**
     * Opens a sweep row and, with it, settles what this run will do to the
     * frontier if it closes successfully.
     *
     * `drained` says the run cleared the whole window it opened. Only the sweep
     * code can know that -- it is the one thing that saw both the listing and
     * the fetch -- and it is recorded here, before the agent is handed a single
     * message, so no later argument can change it. A drained run earns its own
     * `ran_at`; anything else earns its own `since`, which `resolveSince` has
     * already clamped to be no newer than the frontier this run opened against,
     * so a run that left mail behind can only hold the frontier still or pull
     * it back. The default is the cautious one: a caller that says nothing --
     * `failedSweep`, which opens a row for a run that never listed anything --
     * earns `since`, never `ran_at`.
     *
     * `ranAt` is the run's own timestamp and the caller may supply it, because
     * a drained run's `frontier_after` is this value and the frontier must be
     * no newer than the listing it describes. `signalSweep` takes it before it
     * asks Gmail for anything; a message that arrives while the listing is in
     * flight then lands *above* the frontier that run earns, so the next window
     * still contains it. Stamping it here, after the fetch, would put that
     * message below the frontier without it ever having been returned. The
     * default is this moment, which is right for every caller that opens a row
     * without a listing behind it.
     */
    openSweep({ label, since, fetchedIds, skipped, leftover, kind = MAIL_KIND, note = '', drained = false, ranAt = now() }) {
      const id = uid()
      const noteText = [skipped ? `skipped=${skipped}` : '', note].filter(Boolean).join('; ')
      S.exec('INSERT INTO ext_aisignal_sweeps (id, ran_at, label, since, messages, fetched_ids, leftover, kind, note, frontier_after) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id, ranAt, label, since, fetchedIds.length, JSON.stringify(fetchedIds), leftover, kind, noteText, drained ? ranAt : since])
      return { id }
    },
    /**
     * Closes a sweep that blew up. Deliberately does not touch
     * ext_aisignal_seen: the fetched messages stay unseen so the next run
     * retries them.
     *
     * The failure text is appended to the note openSweep wrote, for the same
     * reason finishSweep appends: replacing it drops the `skipped=N` count and
     * every structured segment the run had already established -- and the
     * failure path is exactly where an operator most needs to know whether the
     * listing stopped on the cap, how many fetches failed, and how much was
     * skipped. A code alone cannot answer "is running again immediately worth
     * anything?". Appending through joinNote also keeps a retried failure from
     * writing the same segment twice.
     */
    failSweep(sweepId, code, message) {
      const sweep = S.get('SELECT note FROM ext_aisignal_sweeps WHERE id = ?', [sweepId])
      S.exec('UPDATE ext_aisignal_sweeps SET ok = 0, note = ?, finished_at = ? WHERE id = ?', [joinNote(sweep?.note, `${code}: ${message}`), now(), sweepId])
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
     * This is the one place the frontier moves. A successful close copies the
     * row's `frontier_after` -- settled by openSweep, out of the agent's reach
     * -- into `ext_aisignal_frontier` for that sweep's kind *and its label*;
     * `ok: false` leaves the frontier exactly where it was. Nothing else in the
     * extension writes that table, and nothing anywhere derives a frontier from
     * anything else, so "when does the frontier move?" is answered by these
     * four lines.
     *
     * The label is part of the key because a sweep of one label proves nothing
     * about another. Keyed on kind alone, a run that drained a quiet label
     * stamped its `ran_at` onto the frontier a busy label resumed from, and
     * that label's backlog fell outside every window afterwards. The row a
     * close writes is therefore the row for the source it actually swept, and
     * every other source's window is exactly where its own last close left it.
     *
     * An unknown sweep id throws instead of quietly marking a batch of messages
     * seen against nothing, which would lose them for good. An already-closed
     * one throws for the reason recordSignal refuses one: closing is not
     * idempotent any more now that it moves the frontier. `failSweep` closes
     * the row of a run that could not list at all, and without this guard a
     * single `finishSweep({ sweepId, ok: true })` -- and `ok: true` is the
     * declared default -- reopened that failure as a clean run whose
     * `leftover = 0` and empty note read as "drained", handing the frontier a
     * timestamp no run had earned and stranding the real backlog behind it.
     */
    finishSweep({ sweepId, ok = true, note = '' }) {
      return S.transaction(() => {
        const sweep = S.get('SELECT fetched_ids, note, kind, label, frontier_after, finished_at FROM ext_aisignal_sweeps WHERE id = ?', [sweepId])
        if (!sweep) throw new Error(`unknown sweep ${sweepId}`)
        if (sweep.finished_at) throw new Error(alreadyClosedMessage(sweepId))
        const ids = JSON.parse(sweep.fetched_ids || '[]')
        for (const m of ids) S.exec('INSERT OR IGNORE INTO ext_aisignal_seen (message_id, seen_at) VALUES (?, ?)', [m, now()])
        const found = S.get('SELECT COUNT(*) AS c FROM ext_aisignal_items WHERE sweep_id = ?', [sweepId]).c
        const linksRead = S.get('SELECT COUNT(*) AS c FROM ext_aisignal_items WHERE sweep_id = ? AND link_read = 1', [sweepId]).c
        S.exec('UPDATE ext_aisignal_sweeps SET found = ?, links_read = ?, ok = ?, note = ?, finished_at = ? WHERE id = ?', [found, linksRead, ok ? 1 : 0, joinNote(sweep.note, note), now(), sweepId])
        if (ok) {
          S.exec('INSERT INTO ext_aisignal_frontier (kind, label, frontier, moved_at, sweep_id) VALUES (?,?,?,?,?) ON CONFLICT (kind, label) DO UPDATE SET frontier = excluded.frontier, moved_at = excluded.moved_at, sweep_id = excluded.sweep_id',
            [sweep.kind, sweep.label, sweep.frontier_after, now(), sweepId])
        }
        return { sweepId, found, linksRead, seenMarked: ids.length, ok: Boolean(ok) }
      })
    },
    /**
     * One sweep by id, or null.
     *
     * recordSignal needs it before it writes: an item filed against a sweep
     * that does not exist is attributed to nothing, and one filed against a
     * sweep already closed is never counted into that sweep's `found` while its
     * message is already marked seen, so nothing ever brings it back.
     */
    sweepById(id) { return S.get('SELECT * FROM ext_aisignal_sweeps WHERE id = ?', [id]) || null },
    /** Most recent sweep of one kind, finished or not. Always filtered by kind -- see the note on the `kind` column. */
    latestSweep(kind = MAIL_KIND) { return S.get(`SELECT * FROM ext_aisignal_sweeps WHERE kind = ? ORDER BY ${SWEEP_ORDER} LIMIT 1`, [kind]) || null },
    /**
     * The point the next run of this kind *over this label* resumes from, or
     * null for the whole source.
     *
     * A read of one stored cell, with no rule in it. Everything that decides
     * what that cell contains lives in openSweep and finishSweep above, and no
     * caller has to reconstruct anything from a sweep row to use this: a source
     * that has never closed a sweep has no row here, which reads as null, which
     * is the whole source.
     *
     * Both halves of the key are named by the caller, and neither has a
     * default: a read that guessed one would be a read of some other source's
     * window, which is the whole defect this key exists to close.
     */
    frontier(kind, label) { return S.get('SELECT frontier FROM ext_aisignal_frontier WHERE kind = ? AND label = ?', [kind, label])?.frontier ?? null },
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
