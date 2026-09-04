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
   * Migration 3 re-keys the same table on the label as well, and migration 4
   * re-keys it again on the source that label name actually resolved to, for
   * the same reason one step further each time; see below.
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
}, {
  /*
   * The frontier belongs to the source a run resolved, not to the name the
   * operator typed.
   *
   * Migration 3 keyed the table on (kind, label), and `label` is a Gmail label
   * *name*: a mutable alias that a run resolves to an actual source at sweep
   * time, through `gmail.labelId(name)`, inside whatever mailbox the stored
   * Google credential currently opens. Both halves of that resolution move
   * under ordinary operator action, and when either moves the new source
   * silently inherits the old source's watermark.
   *
   *   A rename. `News` maps to the Gmail label LBL_OLD and a sweep drains it,
   *   so the frontier for `News` is now. The operator renames LBL_OLD to
   *   `News archive` and points the name `News` at LBL_NEW, which already
   *   holds mail weeks old -- applying a filter to existing conversations is
   *   one click. The next run resolves `News` to LBL_NEW, reads LBL_OLD's
   *   watermark, lists nothing older than it, reads as drained and advances
   *   the frontier further still. Those messages are never listed again, and
   *   the dedup cannot save a message nobody listed.
   *
   *   A reconnect, which needs no rename at all. The host stores one refresh
   *   token per purpose, so disconnecting Google and reconnecting a *different*
   *   account replaces the whole mailbox while these rows survive. The default
   *   label name ships with the extension, so the same name plausibly exists in
   *   both mailboxes, and everything in the new mailbox older than the old
   *   mailbox's frontier is skipped.
   *
   * So the key stops being a name and becomes the identity the run actually
   * resolved -- see THE FRONTIER KEY below for the rule itself. Two columns
   * rather than one composed string, because two columns are injective with no
   * encoding rule to get wrong. `source_id` alone is not enough: user label ids
   * are per-mailbox and collide across accounts. The label *name* is
   * deliberately not in the key, so a rename that keeps the id keeps its
   * window, which is the one case that really is the same source; `label` stays
   * on the sweep row as what the operator typed, and nothing reads it back.
   *
   * Rebuilt empty, for exactly the reason migration 3 was. There is no honest
   * source identity to give an existing row: the name it was keyed on may have
   * been repointed since, which is the defect this migration closes, so a
   * carried-over value would be handed to a source that may never have earned
   * it -- a frontier one sweep too new for that source, which skips its mail
   * permanently. Carrying rows over would also make the migration depend on the
   * invariant it introduces rather than on one the old data was written under.
   * Empty is unconditional: no row reads as NULL, NULL is the whole source, and
   * no install comes out of this with a frontier newer than the rule below
   * would produce for a given source. The cost is one re-listing per source and
   * it lands on the dedup.
   *
   * The two new sweep columns default to '' so every row already stored says
   * what is true of it: that run resolved no source. `finishSweep` refuses to
   * move a frontier for such a row.
   */
  version: 4,
  sql: `
ALTER TABLE ext_aisignal_sweeps ADD COLUMN account TEXT NOT NULL DEFAULT '';
ALTER TABLE ext_aisignal_sweeps ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
DROP TABLE IF EXISTS ext_aisignal_frontier;
CREATE TABLE IF NOT EXISTS ext_aisignal_frontier (
  kind TEXT NOT NULL, account TEXT NOT NULL, source_id TEXT NOT NULL, frontier TEXT, moved_at TEXT NOT NULL, sweep_id TEXT NOT NULL,
  PRIMARY KEY (kind, account, source_id)
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
 * `account` and `source_id` are the source the run resolved, and they are what
 * the frontier is keyed on -- see THE FRONTIER KEY. `label` sits beside them as
 * the name the operator typed, which is reporting only: a name is an alias that
 * can be repointed at another Gmail label, or opened against another mailbox,
 * without a single character of it changing. Both default to '' so a run that
 * never resolved a source says so, and such a row moves no frontier.
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

/*
 * THE FRONTIER KEY
 * ================
 * A frontier answers "everything older than this has been swept -- of this
 * source, and of no other", so its key has to be the source itself. The source
 * is three values, and all three are in the primary key of
 * `ext_aisignal_frontier`:
 *
 *   kind      which series this is. A web sweep must never answer "when did we
 *             last read mail?".
 *   account   which mailbox the run was actually looking at. For mail this is
 *             the address `users.getProfile` reports for the credential in
 *             hand. The host stores one Google refresh token per purpose, so
 *             reconnecting a different account swaps the mailbox under a name
 *             that did not change.
 *   sourceId  which source inside that account. For mail this is the Gmail
 *             label *id* `labelId(name)` resolved, never the name: the name is
 *             a mutable alias an operator can repoint at another label in one
 *             click. Label ids are per-mailbox, which is why `account` is in
 *             the key with it.
 *
 * That is the whole set of dimensions a sweep varies over, and putting all of
 * it in the key is what enforces the rule rather than merely satisfying it: a
 * run against a source that differs in *any* of the three resolves to a row
 * that does not exist, which reads as NULL, which is the whole source -- the
 * widest window there is and the safe direction. A key missing a half would
 * instead resolve to some other source's row and inherit its watermark, and
 * mail below an inherited watermark is never listed again.
 *
 * `requireSource` is where that is enforced: every read of the frontier and
 * every sweep that claims a source goes through it, and a half that is absent
 * or blank is refused by name rather than reaching SQLite as an unbound
 * parameter. The one thing a source is *not* keyed on is the label name the
 * operator typed; it is on the sweep row for the history and nothing reads it
 * back.
 */
function requireSource(where, source) {
  const { kind, account, sourceId } = source || {}
  for (const [name, value] of [['kind', kind], ['account', account], ['sourceId', sourceId]]) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${where} needs a non-empty ${name}: the frontier is keyed on (kind, account, sourceId), and a key with a half missing is some other source's window`)
    }
  }
  return { kind, account, sourceId }
}

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
     *
     * `source` is the identity the run resolved -- `{ account, sourceId }`, see
     * THE FRONTIER KEY -- and it is what `finishSweep` keys the frontier on.
     * `null` is the honest value for a run that never got as far as resolving
     * one: `failedSweep` opens such a row so the failure is visible in the
     * history, and a row with no source can move no frontier at all. Claiming
     * `drained` without one is refused rather than stored, because a run cannot
     * have cleared a source it never identified, and the row it would leave
     * behind is the one shape that hands a `ran_at` to the frontier.
     */
    openSweep({ label, source = null, since, fetchedIds, skipped, leftover, kind = MAIL_KIND, note = '', drained = false, ranAt = now() }) {
      if (drained && !source) throw new Error('a sweep cannot claim it drained a source it never resolved')
      const { account, sourceId } = source ? requireSource('openSweep', { kind, ...source }) : { account: '', sourceId: '' }
      const id = uid()
      const noteText = [skipped ? `skipped=${skipped}` : '', note].filter(Boolean).join('; ')
      S.exec('INSERT INTO ext_aisignal_sweeps (id, ran_at, label, account, source_id, since, messages, fetched_ids, leftover, kind, note, frontier_after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, ranAt, label, account, sourceId, since, fetchedIds.length, JSON.stringify(fetchedIds), leftover, kind, noteText, drained ? ranAt : since])
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
     * -- into `ext_aisignal_frontier` for the source that sweep actually read;
     * `ok: false` leaves the frontier exactly where it was. Nothing else in the
     * extension writes that table, and nothing anywhere derives a frontier from
     * anything else, so "when does the frontier move?" is answered by these
     * few lines.
     *
     * The row it writes is keyed on the whole resolved source -- kind, account
     * and source id, see THE FRONTIER KEY -- because a sweep of one source
     * proves nothing about another. Keyed on kind alone, a run that drained a
     * quiet label stamped its `ran_at` onto the frontier a busy label resumed
     * from; keyed on the label *name*, a name repointed at another Gmail label,
     * or a reconnect to another mailbox, handed the new source the old source's
     * watermark. Every other source's window stays exactly where its own last
     * close left it.
     *
     * A sweep that never resolved a source moves nothing. Its columns are
     * blank, and a blank key is not an identity -- it is every source that was
     * never identified sharing one row. Such a row cannot reach here in
     * production (a run that could not resolve its source is closed by
     * `failSweep`, and an already-closed sweep is refused above), so the guard
     * is the second barrier rather than the first, and it errs in the direction
     * that leaves the window wide.
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
        const sweep = S.get('SELECT fetched_ids, note, kind, account, source_id, frontier_after, finished_at FROM ext_aisignal_sweeps WHERE id = ?', [sweepId])
        if (!sweep) throw new Error(`unknown sweep ${sweepId}`)
        if (sweep.finished_at) throw new Error(alreadyClosedMessage(sweepId))
        const ids = JSON.parse(sweep.fetched_ids || '[]')
        for (const m of ids) S.exec('INSERT OR IGNORE INTO ext_aisignal_seen (message_id, seen_at) VALUES (?, ?)', [m, now()])
        const found = S.get('SELECT COUNT(*) AS c FROM ext_aisignal_items WHERE sweep_id = ?', [sweepId]).c
        const linksRead = S.get('SELECT COUNT(*) AS c FROM ext_aisignal_items WHERE sweep_id = ? AND link_read = 1', [sweepId]).c
        S.exec('UPDATE ext_aisignal_sweeps SET found = ?, links_read = ?, ok = ?, note = ?, finished_at = ? WHERE id = ?', [found, linksRead, ok ? 1 : 0, joinNote(sweep.note, note), now(), sweepId])
        if (ok && sweep.account && sweep.source_id) {
          S.exec('INSERT INTO ext_aisignal_frontier (kind, account, source_id, frontier, moved_at, sweep_id) VALUES (?,?,?,?,?,?) ON CONFLICT (kind, account, source_id) DO UPDATE SET frontier = excluded.frontier, moved_at = excluded.moved_at, sweep_id = excluded.sweep_id',
            [sweep.kind, sweep.account, sweep.source_id, sweep.frontier_after, now(), sweepId])
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
     * The point the next run over this source resumes from, or null for the
     * whole source.
     *
     * A read of one stored cell, with no rule in it. Everything that decides
     * what that cell contains lives in openSweep and finishSweep above, and no
     * caller has to reconstruct anything from a sweep row to use this: a source
     * that has never closed a sweep has no row here, which reads as null, which
     * is the whole source.
     *
     * Every part of the key is named by the caller and none has a default. A
     * read that guessed one would be a read of some other source's window,
     * which is the whole defect this key exists to close, so a missing part is
     * refused by name -- see THE FRONTIER KEY. Left to SQLite it surfaced as
     * "Provided value cannot be bound to SQLite parameter 2", which names a
     * parameter index in a file that names every other failure.
     */
    frontier(source) {
      const { kind, account, sourceId } = requireSource('frontier', source)
      return S.get('SELECT frontier FROM ext_aisignal_frontier WHERE kind = ? AND account = ? AND source_id = ?', [kind, account, sourceId])?.frontier ?? null
    },
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
