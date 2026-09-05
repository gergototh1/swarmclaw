import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { MAX_PAGES, OAUTH_PURPOSE, REQUEST_TIMEOUT_MS, clientFor, createGmail, sinceQuery, stripHtml } from '../src/client.mjs'
import { GmailError, HIBA_KODOK, TOKEN_CODES } from '../src/hibak.mjs'

/**
 * The Gmail client's suite, carried over from `extensions/aisignal/test/gmail.test.mjs`
 * with nothing dropped. Where a case changed it is because the method changed
 * -- `listIds` became `list` with a page cursor, `labelId` became `labels`,
 * `getMessage` became `get` -- and the case says so where the difference is
 * worth reading.
 *
 * Nothing here reaches Google. Every client is built over a fake `fetch` and a
 * fake `getToken`, so no credential and no mailbox is needed to run it.
 */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

// --- the vocabulary this file speaks -----------------------------------------

test('every code literal thrown in src/ is in the closed set', () => {
  // args.test.mjs greps `refuse(` and the readers' `code = '...'` defaults. The
  // client throws `new GmailError(code, ...)` directly, because two of its
  // exits hand the error to `endingIt` before throwing it and a verb that
  // throws cannot do that. So the same guarantee is taken here for the form
  // this file uses, and the two greps together cover every code literal in the
  // module.
  const sites = []
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(SRC, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')
    for (const hit of source.matchAll(/\bnew GmailError\(\s*'([^']*)'/g)) sites.push({ name, code: hit[1] })
  }
  assert.ok(sites.length > 0, 'no code literals found; the grep is not looking where it thinks it is')
  for (const site of sites) {
    assert.ok(HIBA_KODOK.includes(site.code), `${site.name}: new GmailError names '${site.code}', which is not in HIBA_KODOK`)
  }
})

test('TOKEN_CODES is the four host codes and nothing else', () => {
  // It is derived from HIBA_KODOK by name, so a respelling there cannot leave a
  // stale copy here -- but it could silently leave the set SHORT, and a missing
  // member means a revoked grant reported as a generic refresh failure.
  assert.deepEqual([...TOKEN_CODES].sort(), ['gmail_refresh_failed', 'gmail_token_missing', 'gmail_token_revoked', 'gmail_token_unreadable'])
})

test('clientFor prefers the test seam and otherwise asks the host for the gmail purpose', () => {
  assert.equal(OAUTH_PURPOSE, 'gmail')
  const stub = { mailbox: async () => 'seam@example.test' }
  assert.equal(clientFor({ clientFactory: () => stub }), stub)

  const asked = []
  const real = clientFor({
    clientFactory: null,
    fetchImpl: async (u) => { asked.push(String(u)); return json({ emailAddress: 'owner@example.test' }) },
    oauth: { getGoogleAccessToken: async (purpose) => { asked.push(purpose); return 't' } },
  })
  return real.mailbox().then((address) => {
    assert.equal(address, 'owner@example.test')
    assert.equal(asked[0], 'gmail')
  })
})

// --- the cases carried over --------------------------------------------------

test('labels hands back the whole list so the caller can match a name exactly', async () => {
  // `labelId(name)` used to do the matching here. It moved out because the
  // caller is the side that knows which name it wants; what did NOT move is the
  // property it protected, which is that nothing folds the case on the way.
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [{ id: 'L1', name: 'AI hírlevél', type: 'user' }] }) })
  assert.deepEqual(await g.labels(), [{ id: 'L1', name: 'AI hírlevél', type: 'user' }])
})

test('list pages and passes a caller query through untouched', async () => {
  const urls = []
  const fetchImpl = async (u) => { urls.push(String(u)); return String(u).includes('pageToken=p2') ? json({ messages: [{ id: 'c' }] }) : json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' }) }
  const g = createGmail({ getToken: async () => 't', fetchImpl })
  assert.deepEqual(
    await g.list({ labelIds: ['L1'], q: sinceQuery('2026-09-01T00:00:00Z'), max: 10 }),
    { ids: ['a', 'b', 'c'], nextCursor: null, complete: true, stoppedOn: null },
  )
  // One day back of the UTC day: see the sinceQuery tests below for why.
  assert.match(urls[0], /q=after%3A2026%2F08%2F31/)
  assert.match(urls[0], /labelIds=L1/)
})

test('401 -> gmail_token_invalid, 403 -> gmail_scope_missing, token errors pass through', async () => {
  const g401 = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 401 } }, 401) })
  await assert.rejects(g401.list({ labelIds: ['L'], max: 1 }), (e) => e.code === 'gmail_token_invalid')
  const g403 = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }, 403) })
  await assert.rejects(g403.list({ labelIds: ['L'], max: 1 }), (e) => e.code === 'gmail_scope_missing')
  const gTok = createGmail({ getToken: async () => { throw new Error('gmail_token_revoked') }, fetchImpl: async () => json({}) })
  await assert.rejects(gTok.list({ labelIds: ['L'], max: 1 }), (e) => e.code === 'gmail_token_revoked')
})

test('get decodes text/plain and falls back to stripped html', async () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url')
  const msg = { id: 'a', internalDate: '1756684800000', payload: { headers: [{ name: 'From', value: 'News <n@x.com>' }, { name: 'Subject', value: 'Hi' }],
    parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hello <b>world</b><script>x()</script></p>') } }] } }
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json(msg) })
  const m = await g.get('a')
  assert.equal(m.fromEmail, 'n@x.com'); assert.equal(m.fromName, 'News'); assert.equal(m.subject, 'Hi')
  assert.equal(m.text.includes('Hello world'), true); assert.equal(m.text.includes('x()'), false)
})

test('stripHtml drops script/style and sinceQuery formats', () => {
  assert.equal(stripHtml('<style>a{}</style><div>A&amp;B</div>'), 'A&B')
  assert.equal(sinceQuery('2026-09-03T10:00:00Z'), 'after:2026/09/02')
})

// --- Beyond the brief -------------------------------------------------------
//
// Everything below pins a path where the wrong answer would be silent: an empty
// text where a newsletter had one, an empty id list where nothing was actually
// looked at, or a throw with no `code` for a caller that switches on one.

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')

/** A `get` client over one canned message payload. */
function messageClient(msg, calls) {
  return createGmail({
    getToken: async () => 't',
    fetchImpl: async (u) => { if (calls) calls.push(String(u)); return json(msg) },
  })
}

test('sinceQuery returns nothing for a missing since, so no q is sent', async () => {
  assert.equal(sinceQuery(null), '')
  assert.equal(sinceQuery(''), '')
  assert.equal(sinceQuery(undefined), '')
  const urls = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u) => { urls.push(String(u)); return json({ messages: [{ id: 'a' }] }) } })
  await g.list({ labelIds: ['L1'], q: sinceQuery(null), max: 5 })
  assert.equal(urls[0].includes('q='), false)
})

test('get walks parts nested several levels deep and prefers text/plain', async () => {
  const msg = {
    id: 'deep',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'Deep <d@x.com>' }],
      parts: [
        { mimeType: 'application/pdf', body: { attachmentId: 'att1' } },
        { mimeType: 'multipart/related', parts: [
          { mimeType: 'multipart/alternative', parts: [
            { mimeType: 'text/html', body: { data: b64url('<p>html branch</p>') } },
            { mimeType: 'text/plain', body: { data: b64url('plain branch') } },
          ] },
        ] },
      ],
    },
  }
  const m = await messageClient(msg).get('deep')
  assert.equal(m.text, 'plain branch')
})

test('get reads a single-part payload that carries the body itself', async () => {
  const msg = { id: 'flat', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('flat body') } } }
  const m = await messageClient(msg).get('flat')
  assert.equal(m.text, 'flat body')
})

test('get returns empty text when the message has no text part at all', async () => {
  const msg = { id: 'bin', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Invoice' }],
    parts: [{ mimeType: 'application/pdf', body: { attachmentId: 'att1' } }] } }
  const m = await messageClient(msg).get('bin')
  assert.equal(m.text, '')
  assert.equal(m.subject, 'Invoice')
  // Nothing to read, as opposed to something to read that is not in this reply.
  assert.equal(m.textInAttachment, false)
})

test('get carries threadId, labelIds and sizeEstimate, and reports an absent one as absent', async () => {
  // The three fields that arrived with the move: they are three of the ten the
  // read projection is allowed to hand out, and the layer that projects them
  // builds no client of its own. None of the three is keyed on, so a reply
  // without them is a message that is still readable rather than a failure.
  const full = await messageClient({ id: 'a', threadId: 'T1', labelIds: ['INBOX', 'UNREAD'], sizeEstimate: 4096, payload: { headers: [] } }).get('a')
  assert.equal(full.threadId, 'T1')
  assert.deepEqual(full.labelIds, ['INBOX', 'UNREAD'])
  assert.equal(full.sizeEstimate, 4096)

  const bare = await messageClient({ id: 'a', payload: { headers: [] } }).get('a')
  assert.equal(bare.threadId, '')
  assert.deepEqual(bare.labelIds, [])
  assert.equal(bare.sizeEstimate, null)

  // A labelIds that is not a list of strings does not become one by being read.
  const odd = await messageClient({ id: 'a', threadId: 7, labelIds: 'INBOX', sizeEstimate: 'big', payload: { headers: [] } }).get('a')
  assert.equal(odd.threadId, '')
  assert.deepEqual(odd.labelIds, [])
  assert.equal(odd.sizeEstimate, null)
})

test('get does not carry the To header, which the read projection may not hand out', async () => {
  // Whoever holds an incoming message's recipient list is one step from
  // building an outgoing one out of it, and that step is what the outbound
  // section forbids. The draft path asks for `to` explicitly; this one cannot.
  const m = await messageClient({ id: 'a', payload: { headers: [{ name: 'To', value: 'someone@example.test' }] } }).get('a')
  assert.equal('to' in m, false)
})

test('get decodes padded and unpadded base64url and survives a malformed one', async () => {
  // "Hi" encodes to three base64 characters, so the padded and unpadded forms
  // differ; Gmail sends the unpadded one but a proxy may re-pad it.
  const padded = await messageClient({ id: 'p', payload: { headers: [], mimeType: 'text/plain', body: { data: 'SGk=' } } }).get('p')
  assert.equal(padded.text, 'Hi')
  const unpadded = await messageClient({ id: 'u', payload: { headers: [], mimeType: 'text/plain', body: { data: 'SGk' } } }).get('u')
  assert.equal(unpadded.text, 'Hi')
  // Garbage must not throw: a single unreadable message would otherwise abort a
  // whole sweep, and a sweep that aborted is not a sweep that found nothing.
  const junk = await messageClient({ id: 'j', payload: { headers: [], mimeType: 'text/plain', body: { data: '!!!not base64!!!' } } }).get('j')
  assert.equal(typeof junk.text, 'string')
})

test('get parses From with no angle brackets, a quoted comma name, or no header', async () => {
  const bare = await messageClient({ id: 'a', payload: { headers: [{ name: 'From', value: 'n@x.com' }] } }).get('a')
  assert.equal(bare.fromEmail, 'n@x.com')

  const quoted = await messageClient({ id: 'b', payload: { headers: [{ name: 'From', value: '"Doe, John" <j@x.com>' }] } }).get('b')
  assert.equal(quoted.fromEmail, 'j@x.com')
  assert.equal(quoted.fromName, 'Doe, John')

  const none = await messageClient({ id: 'c', payload: { headers: [] } }).get('c')
  assert.equal(none.fromEmail, '')
  assert.equal(none.fromName, '')
})

test('get tolerates a malformed header entry and a malformed internalDate', async () => {
  const msg = { id: 'odd', internalDate: 'not-a-number', payload: { headers: [{ value: 'orphan' }, { name: 'Subject' }, { name: 'From', value: 'a@b.c' }] } }
  const m = await messageClient(msg).get('odd')
  assert.equal(m.subject, '')
  assert.equal(m.sentAt, null)
  // An empty internalDate coerces to the epoch, so without its own check this
  // would claim the newsletter was sent in 1970 rather than admitting it does
  // not know.
  const blank = await messageClient({ id: 'blank', internalDate: '', payload: { headers: [] } }).get('blank')
  assert.equal(blank.sentAt, null)
  const real = await messageClient({ id: 'real', internalDate: '1756684800000', payload: { headers: [] } }).get('real')
  assert.equal(real.sentAt, '2025-09-01T00:00:00.000Z')
})

test('labels returns two labels that differ only in case as two labels', async () => {
  // Gmail lets two labels differ only by case, so folding the case would let a
  // caller sweep the wrong one. This method makes folding impossible by never
  // comparing at all: both spellings come back, verbatim, in Gmail's order.
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [{ id: 'L1', name: 'AI hírlevél' }, { id: 'L2', name: 'ai hírlevél' }] }) })
  const listed = await g.labels()
  assert.deepEqual(listed.map((l) => [l.id, l.name]), [['L1', 'AI hírlevél'], ['L2', 'ai hírlevél']])
  // `type` is informational and an absent one is reported as absent, not guessed.
  assert.deepEqual(listed.map((l) => l.type), ['', ''])
})

test('labels reports gmail_list_failed when the label list itself fails', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 500 } }, 500) })
  await assert.rejects(g.labels(), (e) => e.code === 'gmail_list_failed')
})

test('list stops instead of looping forever on an endless nextPageToken', { timeout: 20000 }, async () => {
  // The fake refuses to answer forever. Without the page bound the loop would
  // otherwise spin until the runner is killed, and a hang is not a failure:
  // the assertions below would never be reached.
  //
  // The bound is MAX_PAGES and only MAX_PAGES. The old `listIds` also stopped
  // at `min(max, MAX_PAGES)` pages, which for this cap of 50 would have been 50
  // requests -- and that is exactly the bound that had to go: pages here are
  // EMPTY, so a cap cannot end the walk, and stopping at 50 would have left 150
  // pages of the label unexamined while the caller's own limit was untouched.
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => {
    calls += 1
    if (calls > MAX_PAGES + 10) throw new Error('list paged past its bound')
    return json({ messages: [], nextPageToken: 'always' })
  } })
  const r = await g.list({ labelIds: ['L1'], max: 50 })
  assert.deepEqual(r.ids, [])
  assert.equal(calls, MAX_PAGES)
  // Empty and incomplete: Gmail still had pages, so this is not "found nothing".
  assert.equal(r.complete, false)
  assert.equal(r.nextCursor, 'always')
  assert.equal(r.stoppedOn, 'page_ceiling')
})

test('list never returns more ids than max, and says the cap is why it stopped', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextPageToken: 'p2' }) })
  assert.deepEqual(await g.list({ labelIds: ['L1'], max: 2 }), { ids: ['a', 'b'], nextCursor: 'p2', complete: false, stoppedOn: 'cap' })
})

test('a 403 that is not a scope problem keeps the operation failure code', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } }, 403) })
  await assert.rejects(g.list({ labelIds: ['L'], max: 1 }), (e) => e.code === 'gmail_list_failed')
  await assert.rejects(g.get('a'), (e) => e.code === 'gmail_fetch_failed')
  await assert.rejects(g.createDraft({ raw: 'x' }), (e) => e.code === 'gmail_draft_failed')
  await assert.rejects(g.sendDraft('d1'), (e) => e.code === 'gmail_send_failed')
  await assert.rejects(g.modifyLabels('m1', { addLabelIds: ['L'] }), (e) => e.code === 'gmail_cimkezes_sikertelen')
})

test('get reports gmail_fetch_failed on a server error', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 503 } }, 503) })
  await assert.rejects(g.get('a'), (e) => e instanceof GmailError && e.code === 'gmail_fetch_failed')
})

test('a transport failure and a non-JSON body both surface as gmail_unexpected', async () => {
  const gThrow = createGmail({ getToken: async () => 't', fetchImpl: async () => { throw new TypeError('network down') } })
  await assert.rejects(gThrow.list({ labelIds: ['L'], max: 1 }), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
  // A captive portal or proxy answers 200 with HTML. Without this the promise
  // rejects with a bare SyntaxError whose `code` is undefined, and a caller
  // switching on the code would file it as "nothing found".
  const gHtml = createGmail({ getToken: async () => 't', fetchImpl: async () => new Response('<html>signin</html>', { status: 200, headers: { 'content-type': 'text/html' } }) })
  await assert.rejects(gHtml.list({ labelIds: ['L'], max: 1 }), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
})

test('every token failure code from the host reaches the caller unchanged', async () => {
  for (const code of ['gmail_token_missing', 'gmail_token_unreadable', 'gmail_token_revoked', 'gmail_refresh_failed']) {
    const g = createGmail({ getToken: async () => { throw new Error(code) }, fetchImpl: async () => json({}) })
    await assert.rejects(g.labels(), (e) => e instanceof GmailError && e.code === code)
  }
  // Anything else the host throws is still a token-stage failure, so it lands on
  // the code that tells the user to reconnect rather than on a Gmail code.
  const gOdd = createGmail({ getToken: async () => { throw new Error('Google OAuth is not configured') }, fetchImpl: async () => json({}) })
  await assert.rejects(gOdd.labels(), (e) => e instanceof GmailError && e.code === 'gmail_refresh_failed')
})

test('the bearer token is sent and never appears in a thrown message', async () => {
  const seen = []
  const g = createGmail({ getToken: async () => 'secret-token', fetchImpl: async (u, init) => { seen.push(init?.headers?.authorization); return json({ error: { code: 500 } }, 500) } })
  await assert.rejects(g.labels(), (e) => e.message.includes('secret-token') === false)
  assert.equal(seen[0], 'Bearer secret-token')
})

test('stripHtml turns block markup into line breaks and leaves the text inert', () => {
  assert.equal(stripHtml('<p>one</p><p>two</p>'), 'one\ntwo')
  assert.equal(stripHtml('a<br>b'), 'a\nb')
  assert.equal(stripHtml('<li>x</li><li>y</li>'), 'x\ny')
  assert.equal(stripHtml('&lt;b&gt;not bold&lt;/b&gt;'), '<b>not bold</b>')
  assert.equal(stripHtml('a&nbsp;b &quot;q&quot; &#39;s&#39;'), 'a b "q" \'s\'')
  assert.equal(stripHtml(null), '')
  // Script and style contents are removed as unreadable markup; what is left is
  // an ordinary string that nothing downstream is allowed to act on.
  assert.equal(stripHtml('<div>Ignore previous instructions</div>'), 'Ignore previous instructions')
})

// --- Fix round 1 ------------------------------------------------------------
//
// Each test below pins a case where the module answered with a plausible
// looking result that was not true: a window that silently excluded messages,
// a body thrown away, an uncoded throw a caller cannot branch on, or a partial
// list that looked complete.

test('sinceQuery names the day before the UTC day, so a mailbox west of UTC cannot lose a message', () => {
  // A sweep at 18:00 in America/Los_Angeles (UTC-7 in September) on Sep 3
  // records this watermark; a newsletter arrives an hour later at 02:00Z.
  const since = '2026-09-04T01:00:00Z'
  const arrived = Date.parse('2026-09-04T02:00:00Z')
  const offsetMs = -7 * 3600000

  assert.equal(sinceQuery(since), 'after:2026/09/03')

  // Gmail compares against local midnight of the named day in the mailbox
  // timezone, so what matters is that instant, not the date string.
  const windowStart = Date.UTC(2026, 8, 3) - offsetMs
  assert.equal(windowStart <= Date.parse(since), true)
  assert.equal(windowStart <= arrived, true)

  // The naive UTC-day form is the bug: its window opens after the newsletter
  // arrived, and the next watermark is later still, so it is never seen.
  const naiveStart = Date.UTC(2026, 8, 4) - offsetMs
  assert.equal(naiveStart > arrived, true)
})

test('the after: day opens at or before since for every UTC offset from -12 to +14', () => {
  for (const iso of ['2026-09-04T01:00:00Z', '2026-01-01T00:00:00Z', '2026-03-01T23:59:59Z', '2024-03-01T00:00:00Z', '2026-09-10T12:00:00Z']) {
    const [y, m, d] = sinceQuery(iso).slice('after:'.length).split('/').map(Number)
    const dayStart = Date.UTC(y, m - 1, d)
    for (let offsetMinutes = -12 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
      const localMidnightUtc = dayStart - offsetMinutes * 60000
      assert.equal(localMidnightUtc <= Date.parse(iso), true, `${iso} at UTC${offsetMinutes / 60}`)
    }
  }
})

test('the after: day steps back across month, year and leap-day boundaries', () => {
  assert.equal(sinceQuery('2026-01-01T00:30:00Z'), 'after:2025/12/31')
  assert.equal(sinceQuery('2026-03-01T05:00:00Z'), 'after:2026/02/28')
  assert.equal(sinceQuery('2024-03-01T05:00:00Z'), 'after:2024/02/29')
  assert.equal(sinceQuery('2026-09-10T23:59:59Z'), 'after:2026/09/09')
  assert.equal(sinceQuery('2026-11-01T00:00:00Z'), 'after:2026/10/31')
})

test('sinceQuery drops an unparseable since instead of querying after:NaN/NaN/NaN', () => {
  // A query Gmail cannot parse matches nothing, which would read as a clean
  // sweep. No date filter at all is wider, and wider is the safe direction.
  assert.equal(sinceQuery('not a date'), '')
  assert.equal(sinceQuery('2026-13-45T99:00:00Z'), '')
})

const alternative = (plainData, html) => ({
  id: 'alt',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [{ name: 'Subject', value: 'Weekly' }],
    parts: [
      { mimeType: 'text/plain', body: { data: plainData } },
      { mimeType: 'text/html', body: { data: b64url(html) } },
    ],
  },
})

test('get keeps the html body when the plain part is only whitespace', async () => {
  // Counting parts rather than content threw the whole newsletter away and
  // reported the message as read with nothing in it.
  const nl = await messageClient(alternative(b64url('\n'), '<p>the whole newsletter</p>')).get('alt')
  assert.equal(nl.text, 'the whole newsletter')

  const spaces = await messageClient(alternative(b64url('  \t\r\n   '), '<p>the whole newsletter</p>')).get('alt')
  assert.equal(spaces.text, 'the whole newsletter')
})

test('get keeps the html body when the plain part decodes to nothing', async () => {
  // Malformed base64 decodes to nonsense rather than throwing, and nonsense
  // that decodes to nothing at all is still a part with no content in it.
  const junk = await messageClient(alternative('!!!!', '<p>the whole newsletter</p>')).get('alt')
  assert.equal(junk.text, 'the whole newsletter')

  const empty = await messageClient(alternative(b64url(''), '<p>the whole newsletter</p>')).get('alt')
  assert.equal(empty.text, 'the whole newsletter')
})

test('get returns a browser-stub plain part as written, and says so here rather than guessing', async () => {
  // The third shape of the same complaint, and the one deliberately left
  // alone. A stub is real characters, and any rule that dropped a short plain
  // part in favour of the html would throw away a genuinely short plain-text
  // newsletter -- the same false result in the other direction. Pinned so the
  // boundary of the whitespace rule is visible instead of assumed.
  const stub = await messageClient(alternative(b64url('View this email in your browser'), '<p>the whole newsletter</p>')).get('alt')
  assert.equal(stub.text, 'View this email in your browser')
})

test('get still prefers a plain part that has content', async () => {
  const m = await messageClient(alternative(b64url('what the sender wrote'), '<p>the rendering of it</p>')).get('alt')
  assert.equal(m.text, 'what the sender wrote')
})

test('a 200 that parses into the wrong shape is gmail_unexpected, never an uncoded throw', async () => {
  const client = (body) => createGmail({ getToken: async () => 't', fetchImpl: async () => json(body) })
  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'

  await assert.rejects(client(null).labels(), unexpected)
  await assert.rejects(client([]).labels(), unexpected)
  await assert.rejects(client({ labels: {} }).labels(), unexpected)
  await assert.rejects(client({ messages: {} }).list({ labelIds: ['L'], max: 5 }), unexpected)
  await assert.rejects(client({ id: 'a', payload: { headers: {} } }).get('a'), unexpected)
  await assert.rejects(client({ id: 'a', payload: [] }).get('a'), unexpected)
  // The id is what the caller dedups on, so passing an absent one through
  // would put a message in the store no later sweep can recognise.
  await assert.rejects(client({ payload: { headers: [] } }).get('a'), unexpected)
})

test('a label list with no labels array is a shape failure, not an empty mailbox', async () => {
  // An empty list would send the caller off to create a label that already
  // exists, which is the same wrong answer `gmail_label_missing` used to be
  // when the reply itself was broken.
  const broken = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ nextPageToken: 'x' }) })
  await assert.rejects(broken.labels(), (e) => e.code === 'gmail_unexpected')

  // A list that really is empty is an answer, not a failure.
  const none = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [] }) })
  assert.deepEqual(await none.labels(), [])
})

test('an absent max is no opinion and takes the default; a present one that is not a whole number is refused by name', async () => {
  // THIS IS THE ONE CASE THAT CHANGED MEANING ON THE WAY OVER, and it changed
  // because the caller did. In AI Signal `max` arrived straight from a settings
  // field, so a blank field and a deliberate zero were the same value and both
  // had to be refused. Here `max` is a method argument with a documented
  // default, the settings field is somebody else's problem, and the module's
  // rule applies instead: absent means no opinion.
  //
  // What did not change is that a PRESENT value which cannot be honoured is
  // refused by name and no request goes out. 2.5 is the one worth keeping: it
  // sails past a positive-number test, goes out as maxResults=2.5, and comes
  // back as a plain list failure that says nothing about the value that caused
  // it.
  for (const max of [NaN, 0, -1, 'five', {}, 2.5, 1.0001, Infinity, true, [5]]) {
    let calls = 0
    const g = createGmail({ getToken: async () => 't', fetchImpl: async () => { calls += 1; return json({ messages: [{ id: 'a' }] }) } })
    await assert.rejects(
      g.list({ labelIds: ['L1'], max }),
      (e) => e instanceof GmailError && e.code === 'gmail_argumentum_alak',
      `max=${String(max)}`,
    )
    assert.equal(calls, 0)
  }

  const urls = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u) => { urls.push(String(u)); return json({ messages: [{ id: 'a' }] }) } })
  for (const max of [undefined, null, '']) {
    urls.length = 0
    assert.deepEqual(await g.list({ labelIds: ['L1'], max }), { ids: ['a'], nextCursor: null, complete: true, stoppedOn: null })
    assert.match(urls[0], /maxResults=50/, `max=${String(max)} takes the default`)
  }
  // A whole number that arrived as a string is still a whole number, and a
  // value over the ceiling is capped rather than refused -- the one asymmetry
  // the module makes, and it is safe exactly here because `complete` says
  // whether the page was cut.
  assert.deepEqual((await g.list({ labelIds: ['L1'], max: '2' })).ids, ['a'])
  urls.length = 0
  await g.list({ labelIds: ['L1'], max: 5000 })
  assert.match(urls[0], /maxResults=100/)
})

test('list collects the whole cap when Gmail delivers one id per page', async () => {
  // Gmail applies q inside a scan window, so a filtered page can carry a single
  // id. A fixed 25-page bound turned a request for 200 into 25 with nothing in
  // the result saying it had stopped early.
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => {
    calls += 1
    if (calls > 400) throw new Error('list paged past its bound')
    return json({ messages: [{ id: `m${calls}` }], nextPageToken: `p${calls}` })
  } })
  const r = await g.list({ labelIds: ['L1'], max: 200 })
  assert.equal(r.ids.length, 200)
  assert.equal(r.ids[0], 'm1')
  assert.equal(r.ids[199], 'm200')
  // The whole cap arrived, and Gmail still had pages, so this is a full batch
  // rather than a finished mailbox.
  assert.equal(r.complete, false)
  assert.equal(r.stoppedOn, 'cap')
  assert.equal(r.nextCursor, 'p200')
})

test('list says incomplete when the hard page ceiling stops it with pages left', async () => {
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => {
    calls += 1
    if (calls > 400) throw new Error('list paged past its bound')
    return json({ messages: [{ id: `m${calls}` }], nextPageToken: `p${calls}` })
  } })
  const r = await g.list({ labelIds: ['L1'], max: 500 })
  assert.equal(r.ids.length, MAX_PAGES)
  assert.equal(r.complete, false)
  // Short of the cap: the caller asked for 500 and the request budget, not the
  // cap, is what ended the walk.
  assert.equal(r.stoppedOn, 'page_ceiling')
})

test('a complete walk is never reported as incomplete', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }] }) })
  assert.deepEqual(await g.list({ labelIds: ['L1'], max: 5 }), { ids: ['a'], nextCursor: null, complete: true, stoppedOn: null })
  const none = createGmail({ getToken: async () => 't', fetchImpl: async () => json({}) })
  // Gmail omits `messages` entirely when a label has nothing matching, and that
  // is the one empty list here that really does mean "looked and found nothing".
  assert.deepEqual(await none.list({ labelIds: ['L1'], max: 5 }), { ids: [], nextCursor: null, complete: true, stoppedOn: null })
})

test('list skips a page entry with no id instead of collecting a hole', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }, {}, null, { threadId: 't' }, { id: 'b' }] }) })
  assert.deepEqual(await g.list({ labelIds: ['L1'], max: 5 }), { ids: ['a', 'b'], nextCursor: null, complete: true, stoppedOn: null })
})

test('a text part served as an attachment is distinguishable from having no text part', async () => {
  const detached = { id: 'd', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Weekly' }],
    parts: [{ mimeType: 'text/plain', body: { size: 40960, attachmentId: 'att9' } }] } }
  const m = await messageClient(detached).get('d')
  assert.equal(m.text, '')
  assert.equal(m.textInAttachment, true)

  const readable = { id: 'r', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('inline') } } }
  const n = await messageClient(readable).get('r')
  assert.equal(n.text, 'inline')
  assert.equal(n.textInAttachment, false)
})

test('get reads a text part whose mimeType carries a charset or an odd case', async () => {
  const both = { id: 'c', payload: { mimeType: 'multipart/alternative', headers: [], parts: [
    { mimeType: 'text/plain; charset=UTF-8', body: { data: b64url('charset plain') } },
    { mimeType: 'TEXT/HTML; charset=utf-8', body: { data: b64url('<p>rendered</p>') } },
  ] } }
  assert.equal((await messageClient(both).get('c')).text, 'charset plain')

  const htmlOnly = { id: 'h', payload: { mimeType: 'multipart/alternative', headers: [], parts: [
    { mimeType: 'Text/HTML; charset=ISO-8859-1', body: { data: b64url('<p>html only</p>') } },
  ] } }
  assert.equal((await messageClient(htmlOnly).get('h')).text, 'html only')
})

test('get survives a payload whose parts field is not an array', async () => {
  // `for (const p of {})` throws an uncoded TypeError, which a caller switching
  // on e.code cannot branch on.
  const msg = { id: 'odd', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('body text') }, parts: { 0: { mimeType: 'text/plain' } } } }
  const m = await messageClient(msg).get('odd')
  assert.equal(m.text, 'body text')
})

test('get escapes the message id into the path', async () => {
  const calls = []
  const m = await messageClient({ id: 'weird', payload: { headers: [] } }, calls).get('a/../labels?x=1#f')
  assert.equal(m.id, 'weird')
  assert.equal(calls[0].includes('/messages/a%2F..%2Flabels%3Fx%3D1%23f?format=full'), true)
  assert.equal(calls[0].includes('/labels'), false)
})

// --- Fix round 2 ------------------------------------------------------------
//
// The same rule again, one layer up: a partial answer that calls itself
// complete. `truncated` used to be set only when the request budget ran out,
// so the one case that actually happens -- the cap filling up while Gmail
// still holds pages -- reported a finished mailbox.

test('list says incomplete when the cap fills while Gmail still holds pages', async () => {
  // The reproduction: a cap of 3 against a mailbox with more. A caller reading
  // complete === true advances its watermark past everything it did not fetch,
  // and the rest is lost the same way the date window used to lose it.
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u) => {
    const n = Number(new URL(String(u)).searchParams.get('pageToken') || 1)
    return json({ messages: [{ id: `m${n}` }], nextPageToken: String(n + 1) })
  } })
  const r = await g.list({ labelIds: ['L1'], max: 3 })
  assert.deepEqual(r, { ids: ['m1', 'm2', 'm3'], nextCursor: '4', complete: false, stoppedOn: 'cap' })
})

test('list tells a cap stop apart from a page ceiling stop', async () => {
  // Both mean "there is more"; they do not mean the same thing to the caller.
  // A cap stop is the ordinary full batch a sweep is expected to leave behind
  // and come straight back for; a page ceiling stop means the walk gave up
  // before it even reached the cap, and coming straight back may not help.
  const endless = () => createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }], nextPageToken: 'more' }) })
  assert.equal((await endless().list({ labelIds: ['L1'], max: 2 })).stoppedOn, 'cap')
  assert.equal((await endless().list({ labelIds: ['L1'], max: 5000 })).stoppedOn, 'page_ceiling')
  // And a walk Gmail finished names no stop reason at all.
  const done = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }] }) })
  assert.equal((await done.list({ labelIds: ['L1'], max: 5 })).stoppedOn, null)
})

test('list does not follow a nextPageToken that is not a string', async () => {
  // Without the type guard a numeric token is truthy, so the walk sends
  // pageToken=12345 and pages on against a reply Gmail never meant as a
  // cursor, collecting the same page over and over.
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => {
    calls += 1
    if (calls > 20) throw new Error('list followed a non-string nextPageToken')
    return json({ messages: [{ id: 'a' }], nextPageToken: 12345 })
  } })
  const r = await g.list({ labelIds: ['L1'], max: 10 })
  assert.equal(calls, 1)
  assert.deepEqual(r, { ids: ['a'], nextCursor: null, complete: true, stoppedOn: null })
})

test('a message with no payload at all is a shape failure, not a message with no content', async () => {
  // format=full always carries a payload, so an absent one is a broken reply.
  // Reported as empty text it is indistinguishable from a genuine PDF-only
  // newsletter, which is the false empty this module refuses everywhere else.
  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'
  await assert.rejects(messageClient({ id: 'x' }).get('x'), unexpected)
  await assert.rejects(messageClient({ id: 'x', payload: null }).get('x'), unexpected)
  // The siblings already behaved this way; all three now share it.
  await assert.rejects(messageClient({ id: 'x', payload: 'full' }).get('x'), unexpected)
  await assert.rejects(messageClient({ id: 'x', payload: [] }).get('x'), unexpected)
})

test('a label with no usable id or name refuses the whole list, rather than becoming a hole in it', async () => {
  // An undefined id goes straight into labelIds= on the next request, and the
  // listing that comes back is a listing of the wrong thing. Dropping the entry
  // instead would be worse: a label the mailbox HAS would look like one it does
  // not, which is the false negative this module exists to refuse.
  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'
  for (const labels of [
    [{ name: 'AI hírlevél' }],
    [{ id: '', name: 'AI hírlevél' }],
    [{ id: 7, name: 'AI hírlevél' }],
    [{ id: 'L1' }],
    [{ id: 'L1', name: '' }],
    [{ id: 'L1', name: 'ok' }, null],
  ]) {
    const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels }) })
    await assert.rejects(g.labels(), unexpected, JSON.stringify(labels))
  }
})

test('a From header with no angle brackets is all address and no name', async () => {
  // The whole header as the display name puts "news@example.com" in the from
  // name of every signal such a sender produces, and the address is already
  // carried separately.
  const m = await messageClient({ id: 'a', payload: { headers: [{ name: 'From', value: 'news@example.com' }] } }).get('a')
  assert.equal(m.fromEmail, 'news@example.com')
  assert.equal(m.fromName, '')
})

// --- Fix round 5 ------------------------------------------------------------
//
// The other half of a source identity. A label id says which label; only the
// mailbox says whose, and the two together are what a frontier is keyed on.

test('mailbox names the mailbox the credential opens', async () => {
  const urls = []
  const g = createGmail({
    getToken: async () => 't',
    fetchImpl: async (u) => { urls.push(String(u)); return json({ emailAddress: 'owner@example.test', messagesTotal: 12 }) },
  })
  assert.equal(await g.mailbox(), 'owner@example.test')
  assert.equal(urls[0].endsWith('/users/me/profile'), true)
})

test('a profile that cannot be read is a named failure, never an anonymous mailbox', async () => {
  // An empty or absent address passed through would become half of a frontier
  // key shared with every other unreadable profile, which is the one thing a
  // key must never be: an identity that is not one.
  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'
  for (const body of [{}, { emailAddress: '' }, { emailAddress: 7 }, { emailAddress: null }]) {
    const odd = createGmail({ getToken: async () => 't', fetchImpl: async () => json(body) })
    await assert.rejects(odd.mailbox(), unexpected)
  }

  // The operation gets a code of its own: reading the profile is neither
  // listing nor fetching, and an operator has to learn which call broke.
  const failed = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 500 } }, 500) })
  await assert.rejects(failed.mailbox(), (e) => e instanceof GmailError && e.code === 'gmail_profile_failed')

  // Token and scope failures keep their own codes here as everywhere else.
  const scope = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }, 403) })
  await assert.rejects(scope.mailbox(), (e) => e.code === 'gmail_scope_missing')
  const revoked = createGmail({ getToken: async () => { throw new Error('gmail_token_revoked') }, fetchImpl: async () => json({}) })
  await assert.rejects(revoked.mailbox(), (e) => e.code === 'gmail_token_revoked')
})

test('mailbox asks Gmail every time rather than remembering an address', async () => {
  // A remembered address outlives exactly the reconnect the frontier key exists
  // to notice: the host keeps one refresh token per purpose, so the same client
  // asked twice must answer for the credential in hand both times.
  const addresses = ['first@example.test', 'second@example.test']
  let n = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ emailAddress: addresses[n++] }) })
  assert.equal(await g.mailbox(), 'first@example.test')
  assert.equal(await g.mailbox(), 'second@example.test')
})

// --- The page cursor ---------------------------------------------------------
//
// The reason this extension exists. The operator's existing Gmail MCP server
// has maxResults and no page token, so a caller that gets its cap back cannot
// tell "this is all of them" from "there is more and it was cut", and the AI
// Signal frontier turns on exactly that bit.

test('the cursor comes back untouched and goes back in untouched', async () => {
  const urls = []
  const opaque = 'Ci4KJDAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMBDAhD0='
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u) => {
    urls.push(String(u))
    return json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: opaque })
  } })

  const first = await g.list({ labelIds: ['L1'], max: 2 })
  // Byte for byte: this module never builds a token and never reads inside one.
  assert.equal(first.nextCursor, opaque)
  assert.equal(first.complete, false)

  const second = await g.list({ labelIds: ['L1'], max: 2, cursor: first.nextCursor })
  assert.equal(new URL(urls[1]).searchParams.get('pageToken'), opaque)
  assert.equal(second.nextCursor, opaque)
})

test('a call started from a cursor sends it on the very first request', async () => {
  // Not on the second: a caller resuming a walk must not re-read the first page
  // it already has, or every resume would re-deliver a page it deduped away.
  const urls = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u) => { urls.push(String(u)); return json({ messages: [{ id: 'c' }] }) } })
  const r = await g.list({ labelIds: ['L1'], max: 5, cursor: 'page-two' })
  assert.equal(urls.length, 1)
  assert.equal(new URL(urls[0]).searchParams.get('pageToken'), 'page-two')
  assert.deepEqual(r, { ids: ['c'], nextCursor: null, complete: true, stoppedOn: null })
})

test('the cap filling on an exhausted last page is complete, not a stop', async () => {
  // The normalisation the old `truncated ? stoppedOn : null` ternary did, now a
  // consequence of the control flow: the `if (!pageToken) break` runs first, so
  // stoppedOn is never set when Gmail said there was nothing after the page.
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }, { id: 'b' }] }) })
  assert.deepEqual(await g.list({ labelIds: ['L1'], max: 2 }), { ids: ['a', 'b'], nextCursor: null, complete: true, stoppedOn: null })
})

test('a cursor that is not a string is refused by its own name, before any request', async () => {
  // `gmail_kurzor_ervenytelen` rather than the generic shape code: "I sent a
  // cursor that is not one" and "I sent an argument of the wrong type" are the
  // same mistake with different remedies, and a paging caller needs to know it
  // is the cursor.
  for (const cursor of [7, {}, [], true, 'x'.repeat(4097)]) {
    let calls = 0
    const g = createGmail({ getToken: async () => 't', fetchImpl: async () => { calls += 1; return json({ messages: [] }) } })
    await assert.rejects(
      g.list({ labelIds: ['L1'], max: 5, cursor }),
      (e) => e instanceof GmailError && e.code === 'gmail_kurzor_ervenytelen',
      `cursor=${typeof cursor}`,
    )
    assert.equal(calls, 0)
  }
  // Absent means "start at the beginning", and so does an empty string, which
  // is what a stored `nextCursor` of null round-trips to through a form.
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }] }) })
  for (const cursor of [undefined, null, '']) {
    assert.deepEqual((await g.list({ labelIds: ['L1'], max: 5, cursor })).ids, ['a'])
  }
})

test('complete, nextCursor and stoppedOn are three names for one fact', async () => {
  // The invariant, exercised across every way the walk can end rather than
  // asserted once: complete === (nextCursor === null) === (stoppedOn === null).
  const cases = [
    ['finished on the first page', async () => json({ messages: [{ id: 'a' }] }), { max: 5 }],
    ['finished with nothing at all', async () => json({}), { max: 5 }],
    ['stopped on the cap', async () => json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'more' }), { max: 1 }],
    ['stopped on the page ceiling', async () => json({ messages: [], nextPageToken: 'more' }), { max: 5 }],
    ['cap filled exactly as the pages ran out', async () => json({ messages: [{ id: 'a' }] }), { max: 1 }],
  ]
  for (const [what, fetchImpl, args] of cases) {
    const r = await createGmail({ getToken: async () => 't', fetchImpl }).list({ labelIds: ['L1'], ...args })
    assert.equal(r.complete, r.nextCursor === null, `${what}: complete disagrees with nextCursor`)
    assert.equal(r.complete, r.stoppedOn === null, `${what}: complete disagrees with stoppedOn`)
  }
})

// --- The write half ----------------------------------------------------------
//
// Four drafts calls and a label change. None of them composes anything: the
// bytes arrive already built by mime.mjs, and nothing here reads them.

test('createDraft posts the raw message and returns the ids the caller will address it by', async () => {
  const seen = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u, init) => {
    seen.push({ url: String(u), method: init.method, body: JSON.parse(init.body), type: init.headers['content-type'] })
    return json({ id: 'd1', message: { id: 'm1', threadId: 'T1' } })
  } })
  assert.deepEqual(await g.createDraft({ raw: 'UkFX' }), { draftId: 'd1', messageId: 'm1' })
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].type, 'application/json')
  assert.equal(seen[0].url.endsWith('/users/me/drafts'), true)
  assert.deepEqual(seen[0].body, { message: { raw: 'UkFX' } })
})

test('createDraft refuses a reply with no draft id, and tolerates one with no message id', async () => {
  // The draft id addresses every later step -- read it back, send it, discard
  // it -- so a row that recorded `undefined` names a draft nobody can reach.
  // The message id here is the id the message has WHILE IT SITS IN DRAFTS, not
  // the one it gets when sent, and nothing keys on it.
  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'
  for (const body of [{}, { id: '' }, { id: 7 }]) {
    const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json(body) })
    await assert.rejects(g.createDraft({ raw: 'x' }), unexpected)
  }
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ id: 'd1' }) })
  assert.deepEqual(await g.createDraft({ raw: 'x' }), { draftId: 'd1', messageId: '' })
})

test('getDraft reads the draft as it stands now and carries its To header', async () => {
  const urls = []
  const draft = { id: 'd1', message: { id: 'm1', threadId: 'T1', payload: {
    headers: [{ name: 'To', value: 'dorina@example.test' }, { name: 'Subject', value: 'Havi jelentes' }],
    mimeType: 'text/plain',
    body: { data: b64url('a torzs') },
  } } }
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u) => { urls.push(String(u)); return json(draft) } })
  const live = await g.getDraft('d1')
  assert.equal(urls[0].endsWith('/users/me/drafts/d1?format=full'), true)
  assert.equal(live.draftId, 'd1')
  assert.equal(live.to, 'dorina@example.test')
  assert.equal(live.subject, 'Havi jelentes')
  assert.equal(live.text, 'a torzs')
})

test('getDraft escapes the draft id into the path and refuses a reply with no message', async () => {
  const calls = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u) => {
    calls.push(String(u))
    return json({ id: 'd1', message: { id: 'm1', payload: { headers: [] } } })
  } })
  await g.getDraft('d/../messages/x')
  assert.equal(calls[0].includes('/drafts/d%2F..%2Fmessages%2Fx?format=full'), true)
  assert.equal(calls[0].includes('/messages/'), false)

  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'
  for (const body of [{ id: 'd1' }, { id: 'd1', message: {} }, { message: { id: 'm1', payload: { headers: [] } } }]) {
    const broken = createGmail({ getToken: async () => 't', fetchImpl: async () => json(body) })
    await assert.rejects(broken.getDraft('d1'), unexpected)
  }
})

test('sendDraft names the sent message, and refuses to report a send it cannot evidence', async () => {
  const seen = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u, init) => {
    seen.push({ url: String(u), method: init.method, body: JSON.parse(init.body) })
    return json({ id: 'sent-1', threadId: 'T1', labelIds: ['SENT'] })
  } })
  assert.deepEqual(await g.sendDraft('d1'), { messageId: 'sent-1' })
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url.endsWith('/users/me/drafts/send'), true)
  assert.deepEqual(seen[0].body, { id: 'd1' })

  // The id is the record that the letter went out. A send that came back
  // without one leaves the outbound row unable to say what happened, and
  // answering "sent" with nothing to show for it is the false report in the
  // direction that cannot be undone.
  const silent = createGmail({ getToken: async () => 't', fetchImpl: async () => json({}) })
  await assert.rejects(silent.sendDraft('d1'), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
  const failed = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 500 } }, 500) })
  await assert.rejects(failed.sendDraft('d1'), (e) => e.code === 'gmail_send_failed')
})

test('deleteDraft survives the 204 with no body that Gmail actually answers', async () => {
  // `res.json()` on an empty body rejects with a SyntaxError, which this module
  // would then have to report as gmail_unexpected -- a named failure for a call
  // that worked.
  const seen = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u, init) => {
    seen.push({ url: String(u), method: init.method })
    return new Response(null, { status: 204 })
  } })
  assert.equal(await g.deleteDraft('d1'), undefined)
  assert.equal(seen[0].method, 'DELETE')
  assert.equal(seen[0].url.endsWith('/users/me/drafts/d1'), true)

  const failed = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 404 } }, 404) })
  await assert.rejects(failed.deleteDraft('d1'), (e) => e.code === 'gmail_draft_failed')
})

test('modifyLabels reports the labels Gmail ended up with, not the ones it was asked for', async () => {
  // Gmail may apply part of a change. Echoing the request back as the outcome
  // would be the same false report this module refuses everywhere else.
  const seen = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u, init) => {
    seen.push({ url: String(u), method: init.method, body: JSON.parse(init.body) })
    return json({ id: 'm1', labelIds: ['INBOX', 'Label_1'] })
  } })
  assert.deepEqual(await g.modifyLabels('m1', { addLabelIds: ['Label_1'], removeLabelIds: ['UNREAD'] }), { id: 'm1', labelIds: ['INBOX', 'Label_1'] })
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url.endsWith('/users/me/messages/m1/modify'), true)
  assert.deepEqual(seen[0].body, { addLabelIds: ['Label_1'], removeLabelIds: ['UNREAD'] })

  // Absent lists mean "change nothing on this side", which is what Gmail reads
  // an empty array as, and the message id is escaped like every other.
  const calls = []
  const bare = createGmail({ getToken: async () => 't', fetchImpl: async (u, init) => { calls.push({ url: String(u), body: JSON.parse(init.body) }); return json({ id: 'm1' }) } })
  assert.deepEqual(await bare.modifyLabels('a/../drafts'), { id: 'm1', labelIds: [] })
  assert.deepEqual(calls[0].body, { addLabelIds: [], removeLabelIds: [] })
  assert.equal(calls[0].url.includes('/messages/a%2F..%2Fdrafts/modify'), true)

  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'
  const silent = createGmail({ getToken: async () => 't', fetchImpl: async () => json({}) })
  await assert.rejects(silent.modifyLabels('m1', { addLabelIds: ['L'] }), unexpected)
})

test('a GET carries no body and no content-type, so the reads are untouched by the write half', async () => {
  const seen = []
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (_u, init) => { seen.push(init); return json({ emailAddress: 'owner@example.test' }) } })
  await g.mailbox()
  assert.equal(seen[0].method, 'GET')
  assert.equal('body' in seen[0], false)
  assert.equal('content-type' in seen[0].headers, false)
})

// --- The request deadline ----------------------------------------------------
//
// `fetch` has no timeout of its own, so before this every call here could wait
// forever. These runs are started by a schedule rather than by a person, so a
// hung one is not a spinner somebody is watching: it is a mailbox that quietly
// stops being swept, with a row left open and nothing to say why.

/** A fetch that never answers, and rejects the way an aborted one does. */
const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
})

/** A fetch whose headers arrive and whose body then never ends. */
const stallingBody = async (_url, init) => ({
  status: 200,
  ok: true,
  json: () => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
  }),
})

/** Lets the token stage settle so the call has reached its fetch and armed the deadline. */
const untilTheRequestIsOut = () => new Promise((resolve) => setImmediate(resolve))

test('a request that never answers is abandoned on the deadline under its own code', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const g = createGmail({ getToken: async () => 't', fetchImpl: hangingFetch })

  const pending = g.list({ labelIds: ['L1'], max: 5 })
  await untilTheRequestIsOut()

  // One millisecond short of the deadline the call is still waiting, so the
  // bound really is the named constant and not something shorter that happens
  // to fire.
  t.mock.timers.tick(REQUEST_TIMEOUT_MS - 1)
  let settled = false
  pending.then(() => { settled = true }, () => { settled = true })
  await untilTheRequestIsOut()
  assert.equal(settled, false)

  t.mock.timers.tick(1)
  // Its own code, not gmail_unexpected: "Gmail never answered" and "the socket
  // broke" are different things for an operator to do something about, and a
  // run abandoned on time is not a transport error.
  await assert.rejects(pending, (e) => e instanceof GmailError && e.code === 'gmail_timeout' && /30000 ms/.test(e.message))
})

test('the deadline covers every call, the writes included, and the body as well as the headers', { timeout: 5000 }, async (t) => {
  // The deadline lives in the one request helper, so it is not something each
  // endpoint has to remember -- and the five write calls that arrived with the
  // move inherit it for free, which is the whole reason they go through `call`.
  const g = createGmail({ getToken: async () => 't', fetchImpl: hangingFetch })
  for (const [what, call] of [
    ['profile', () => g.mailbox()],
    ['labels', () => g.labels()],
    ['messages', () => g.list({ labelIds: ['L1'], max: 5 })],
    ['one message', () => g.get('a')],
    ['drafts.create', () => g.createDraft({ raw: 'x' })],
    ['drafts.get', () => g.getDraft('d1')],
    ['drafts.send', () => g.sendDraft('d1')],
    ['drafts.delete', () => g.deleteDraft('d1')],
    ['messages.modify', () => g.modifyLabels('m1', { addLabelIds: ['L'] })],
  ]) {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = call()
    await untilTheRequestIsOut()
    t.mock.timers.tick(REQUEST_TIMEOUT_MS)
    await assert.rejects(pending, (e) => e.code === 'gmail_timeout', `${what} runs under the deadline`)
    t.mock.timers.reset()
  }

  // A reply whose headers arrive and whose body then stalls hangs exactly as
  // thoroughly, so the timer is only cleared once the body has been read.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalled = createGmail({ getToken: async () => 't', fetchImpl: stallingBody }).mailbox()
  await untilTheRequestIsOut()
  t.mock.timers.tick(REQUEST_TIMEOUT_MS)
  await assert.rejects(stalled, (e) => e.code === 'gmail_timeout')
})

/**
 * A token refresh that never answers.
 *
 * This is the host's `getGoogleAccessToken`, and the host refreshes against
 * Google's token endpoint with a bare `fetch` that carries no signal and no
 * timeout, so it takes no argument and there is nothing to abort. A promise
 * that never settles is exactly what the extension has to survive.
 */
const hangingToken = () => new Promise(() => {})

test('the deadline covers the token stage, which is the first request every call makes', { timeout: 5000 }, async (t) => {
  // The token is fetched before the URL is, so a hang there strands a scheduled
  // run before the first Gmail call has returned -- earlier than any row exists
  // to record the failure. That is the harm the deadline is for, arriving one
  // stage ahead of where the deadline used to start.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let fetches = 0
  const g = createGmail({
    getToken: hangingToken,
    fetchImpl: async () => { fetches += 1; return json({ labels: [{ id: 'L1', name: 'AI hírlevél' }] }) },
  })

  const pending = g.labels()
  await untilTheRequestIsOut()

  // One millisecond short of the deadline it is still waiting, so the bound is
  // the named constant and not something shorter that happens to fire.
  t.mock.timers.tick(REQUEST_TIMEOUT_MS - 1)
  let settled = false
  pending.then(() => { settled = true }, () => { settled = true })
  await untilTheRequestIsOut()
  assert.equal(settled, false)

  t.mock.timers.tick(1)
  // `gmail_timeout`, not `gmail_refresh_failed`: the credential is not the
  // problem and sending the operator off to reconnect would be a wrong answer.
  // The message names the stage, because Gmail was never asked anything.
  await assert.rejects(pending, (e) => e instanceof GmailError
    && e.code === 'gmail_timeout'
    && /the Google token endpoint did not answer within 30000 ms/.test(e.message))
  assert.equal(fetches, 0, 'the run never reached Gmail: it hung in front of it')
})

test('a token that answers late is abandoned, not cancelled, and the run still fails on time', { timeout: 5000 }, async (t) => {
  // The honest limit of the fix, pinned so it cannot be quietly overstated. The
  // host's fetch never receives this AbortController's signal, so the wait is
  // raced rather than ended: the token request goes on and settles by itself,
  // and what the deadline guarantees is only that the run failed on time.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resolveToken
  let stillRunning = false
  const token = new Promise((resolve) => { resolveToken = resolve })
  const g = createGmail({
    getToken: () => token.then((v) => { stillRunning = true; return v }),
    fetchImpl: async () => json({ labels: [] }),
  })

  const pending = g.labels()
  await untilTheRequestIsOut()
  t.mock.timers.tick(REQUEST_TIMEOUT_MS)
  await assert.rejects(pending, (e) => e.code === 'gmail_timeout')

  // The abandoned request settling afterwards changes nothing and throws
  // nothing: the call is long gone, and its rejection was handled by the race.
  resolveToken('t')
  await untilTheRequestIsOut()
  assert.equal(stillRunning, true, 'the host request outlived the run that made it')
})

test('a status whose body nobody reads ends the request instead of leaving it open', async () => {
  // An unread body holds its connection on a real undici fetch until the
  // response is collected, and clearing the deadline's timer frees nothing.
  // These two exits never look at the body, so they end the request; the 403
  // branch reads its own and needs no such thing.
  for (const [status, code] of [[401, 'gmail_token_invalid'], [500, 'gmail_list_failed']]) {
    let signal
    const g = createGmail({
      getToken: async () => 't',
      fetchImpl: async (_u, init) => { signal = init.signal; return { status, ok: false, json: async () => ({}) } },
    })
    await assert.rejects(g.list({ labelIds: ['L1'], max: 1 }), (e) => e.code === code)
    assert.equal(signal.aborted, true, `HTTP ${status} releases the body it never read`)
  }

  // The other direction: a reply that was read is not aborted on the way out.
  let okSignal
  const good = createGmail({
    getToken: async () => 't',
    fetchImpl: async (_u, init) => { okSignal = init.signal; return json({ emailAddress: 'owner@example.test' }) },
  })
  assert.equal(await good.mailbox(), 'owner@example.test')
  assert.equal(okSignal.aborted, false)

  // And a 204 has no body to release, so it is not aborted either.
  let deleteSignal
  const deleted = createGmail({
    getToken: async () => 't',
    fetchImpl: async (_u, init) => { deleteSignal = init.signal; return new Response(null, { status: 204 }) },
  })
  await deleted.deleteDraft('d1')
  assert.equal(deleteSignal.aborted, false)
})

test('a reply that arrives in time is not touched by the deadline', { timeout: 5000 }, async (t) => {
  // The other direction: the timer must not fire on a call that finished, and
  // must not leave the process holding one either.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ emailAddress: 'owner@example.test' }) })
  assert.equal(await g.mailbox(), 'owner@example.test')
  // Nothing is left armed to abort a request that already answered.
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 2)
  assert.equal(await g.mailbox(), 'owner@example.test')
})
