import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { createGmail, stripHtml, sinceQuery, GmailError } from '../src/gmail.mjs'

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

test('labelId resolves by name and reports gmail_label_missing', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [{ id: 'L1', name: 'AI hírlevél' }] }) })
  assert.equal(await g.labelId('AI hírlevél'), 'L1')
  await assert.rejects(g.labelId('nope'), (e) => e instanceof GmailError && e.code === 'gmail_label_missing')
})

test('listIds pages and passes since as after:', async () => {
  const urls = []
  const fetchImpl = async (u) => { urls.push(String(u)); return String(u).includes('pageToken=p2') ? json({ messages: [{ id: 'c' }] }) : json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' }) }
  const g = createGmail({ getToken: async () => 't', fetchImpl })
  assert.deepEqual(await g.listIds({ labelId: 'L1', since: '2026-09-01T00:00:00Z', max: 10 }), { ids: ['a', 'b', 'c'], truncated: false, stoppedOn: null })
  // One day back of the UTC day: see the sinceQuery tests below for why.
  assert.match(urls[0], /q=after%3A2026%2F08%2F31/)
})

test('401 → gmail_token_invalid, 403 → gmail_scope_missing, token errors pass through', async () => {
  const g401 = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 401 } }, 401) })
  await assert.rejects(g401.listIds({ labelId: 'L', since: null, max: 1 }), (e) => e.code === 'gmail_token_invalid')
  const g403 = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }, 403) })
  await assert.rejects(g403.listIds({ labelId: 'L', since: null, max: 1 }), (e) => e.code === 'gmail_scope_missing')
  const gTok = createGmail({ getToken: async () => { throw new Error('gmail_token_revoked') }, fetchImpl: async () => json({}) })
  await assert.rejects(gTok.listIds({ labelId: 'L', since: null, max: 1 }), (e) => e.code === 'gmail_token_revoked')
})

test('getMessage decodes text/plain and falls back to stripped html', async () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url')
  const msg = { id: 'a', internalDate: '1756684800000', payload: { headers: [{ name: 'From', value: 'News <n@x.com>' }, { name: 'Subject', value: 'Hi' }],
    parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hello <b>world</b><script>x()</script></p>') } }] } }
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json(msg) })
  const m = await g.getMessage('a')
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
// text where a newsletter had one, an empty id list where the sweep never
// actually looked, or a throw with no `code` for a caller that switches on one.

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')

/** A getMessage client over one canned message payload. */
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
  await g.listIds({ labelId: 'L1', since: null, max: 5 })
  assert.equal(urls[0].includes('q='), false)
})

test('getMessage walks parts nested several levels deep and prefers text/plain', async () => {
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
  const m = await messageClient(msg).getMessage('deep')
  assert.equal(m.text, 'plain branch')
})

test('getMessage reads a single-part payload that carries the body itself', async () => {
  const msg = { id: 'flat', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('flat body') } } }
  const m = await messageClient(msg).getMessage('flat')
  assert.equal(m.text, 'flat body')
})

test('getMessage returns empty text when the message has no text part at all', async () => {
  const msg = { id: 'bin', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Invoice' }],
    parts: [{ mimeType: 'application/pdf', body: { attachmentId: 'att1' } }] } }
  const m = await messageClient(msg).getMessage('bin')
  assert.equal(m.text, '')
  assert.equal(m.subject, 'Invoice')
  // Nothing to read, as opposed to something to read that is not in this reply.
  assert.equal(m.textInAttachment, false)
})

test('getMessage decodes padded and unpadded base64url and survives a malformed one', async () => {
  // "Hi" encodes to three base64 characters, so the padded and unpadded forms
  // differ; Gmail sends the unpadded one but a proxy may re-pad it.
  const padded = await messageClient({ id: 'p', payload: { headers: [], mimeType: 'text/plain', body: { data: 'SGk=' } } }).getMessage('p')
  assert.equal(padded.text, 'Hi')
  const unpadded = await messageClient({ id: 'u', payload: { headers: [], mimeType: 'text/plain', body: { data: 'SGk' } } }).getMessage('u')
  assert.equal(unpadded.text, 'Hi')
  // Garbage must not throw: a single unreadable message would otherwise abort a
  // whole sweep, and a sweep that aborted is not a sweep that found nothing.
  const junk = await messageClient({ id: 'j', payload: { headers: [], mimeType: 'text/plain', body: { data: '!!!not base64!!!' } } }).getMessage('j')
  assert.equal(typeof junk.text, 'string')
})

test('getMessage parses From with no angle brackets, a quoted comma name, or no header', async () => {
  const bare = await messageClient({ id: 'a', payload: { headers: [{ name: 'From', value: 'n@x.com' }] } }).getMessage('a')
  assert.equal(bare.fromEmail, 'n@x.com')

  const quoted = await messageClient({ id: 'b', payload: { headers: [{ name: 'From', value: '"Doe, John" <j@x.com>' }] } }).getMessage('b')
  assert.equal(quoted.fromEmail, 'j@x.com')
  assert.equal(quoted.fromName, 'Doe, John')

  const none = await messageClient({ id: 'c', payload: { headers: [] } }).getMessage('c')
  assert.equal(none.fromEmail, '')
  assert.equal(none.fromName, '')
})

test('getMessage tolerates a malformed header entry and a malformed internalDate', async () => {
  const msg = { id: 'odd', internalDate: 'not-a-number', payload: { headers: [{ value: 'orphan' }, { name: 'Subject' }, { name: 'From', value: 'a@b.c' }] } }
  const m = await messageClient(msg).getMessage('odd')
  assert.equal(m.subject, '')
  assert.equal(m.sentAt, null)
  // An empty internalDate coerces to the epoch, so without its own check this
  // would claim the newsletter was sent in 1970 rather than admitting it does
  // not know.
  const blank = await messageClient({ id: 'blank', internalDate: '', payload: { headers: [] } }).getMessage('blank')
  assert.equal(blank.sentAt, null)
  const real = await messageClient({ id: 'real', internalDate: '1756684800000', payload: { headers: [] } }).getMessage('real')
  assert.equal(real.sentAt, '2025-09-01T00:00:00.000Z')
})

test('labelId matches the name exactly, so a case difference is a named failure not a silent miss', async () => {
  // Gmail lets two labels differ only by case, so folding the case here could
  // sweep the wrong one. Failing loudly is the safe half of that trade.
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [{ id: 'L1', name: 'AI hírlevél' }, { id: 'L2', name: 'ai hírlevél' }] }) })
  assert.equal(await g.labelId('ai hírlevél'), 'L2')
  await assert.rejects(g.labelId('AI HÍRLEVÉL'), (e) => e.code === 'gmail_label_missing')
})

test('labelId reports gmail_list_failed when the label list itself fails', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 500 } }, 500) })
  await assert.rejects(g.labelId('AI hírlevél'), (e) => e.code === 'gmail_list_failed')
})

test('listIds stops instead of looping forever on an endless nextPageToken', { timeout: 20000 }, async () => {
  // The fake refuses to answer forever. Without the page bound the loop would
  // otherwise spin until the runner is killed, and a hang is not a failure:
  // the assertions below would never be reached.
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => {
    calls += 1
    if (calls > 100) throw new Error('listIds paged past its bound')
    return json({ messages: [], nextPageToken: 'always' })
  } })
  const r = await g.listIds({ labelId: 'L1', since: null, max: 50 })
  assert.deepEqual(r.ids, [])
  assert.equal(calls > 0, true)
  assert.equal(calls <= 50, true)
  // Empty and truncated: Gmail still had pages, so this is not "found nothing".
  assert.equal(r.truncated, true)
  assert.equal(r.stoppedOn, 'page_ceiling')
})

test('listIds never returns more ids than max, and says the cap is why it stopped', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextPageToken: 'p2' }) })
  assert.deepEqual(await g.listIds({ labelId: 'L1', since: null, max: 2 }), { ids: ['a', 'b'], truncated: true, stoppedOn: 'cap' })
})

test('a 403 that is not a scope problem keeps the operation failure code', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } }, 403) })
  await assert.rejects(g.listIds({ labelId: 'L', since: null, max: 1 }), (e) => e.code === 'gmail_list_failed')
  await assert.rejects(g.getMessage('a'), (e) => e.code === 'gmail_fetch_failed')
})

test('getMessage reports gmail_fetch_failed on a server error', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ error: { code: 503 } }, 503) })
  await assert.rejects(g.getMessage('a'), (e) => e instanceof GmailError && e.code === 'gmail_fetch_failed')
})

test('a transport failure and a non-JSON body both surface as gmail_unexpected', async () => {
  const gThrow = createGmail({ getToken: async () => 't', fetchImpl: async () => { throw new TypeError('network down') } })
  await assert.rejects(gThrow.listIds({ labelId: 'L', since: null, max: 1 }), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
  // A captive portal or proxy answers 200 with HTML. Without this the promise
  // rejects with a bare SyntaxError whose `code` is undefined, and a caller
  // switching on the code would file it as "nothing found".
  const gHtml = createGmail({ getToken: async () => 't', fetchImpl: async () => new Response('<html>signin</html>', { status: 200, headers: { 'content-type': 'text/html' } }) })
  await assert.rejects(gHtml.listIds({ labelId: 'L', since: null, max: 1 }), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
})

test('every token failure code from the host reaches the caller unchanged', async () => {
  for (const code of ['gmail_token_missing', 'gmail_token_unreadable', 'gmail_token_revoked', 'gmail_refresh_failed']) {
    const g = createGmail({ getToken: async () => { throw new Error(code) }, fetchImpl: async () => json({}) })
    await assert.rejects(g.labelId('x'), (e) => e instanceof GmailError && e.code === code)
  }
  // Anything else the host throws is still a token-stage failure, so it lands on
  // the code that tells the user to reconnect rather than on a Gmail code.
  const gOdd = createGmail({ getToken: async () => { throw new Error('Google OAuth is not configured') }, fetchImpl: async () => json({}) })
  await assert.rejects(gOdd.labelId('x'), (e) => e instanceof GmailError && e.code === 'gmail_refresh_failed')
})

test('the bearer token is sent and never appears in a thrown message', async () => {
  const seen = []
  const g = createGmail({ getToken: async () => 'secret-token', fetchImpl: async (u, init) => { seen.push(init?.headers?.authorization); return json({ error: { code: 500 } }, 500) } })
  await assert.rejects(g.labelId('x'), (e) => e.message.includes('secret-token') === false)
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

test('getMessage keeps the html body when the plain part is only whitespace', async () => {
  // Counting parts rather than content threw the whole newsletter away and
  // reported the message as read with nothing in it.
  const nl = await messageClient(alternative(b64url('\n'), '<p>the whole newsletter</p>')).getMessage('alt')
  assert.equal(nl.text, 'the whole newsletter')

  const spaces = await messageClient(alternative(b64url('  \t\r\n   '), '<p>the whole newsletter</p>')).getMessage('alt')
  assert.equal(spaces.text, 'the whole newsletter')
})

test('getMessage keeps the html body when the plain part decodes to nothing', async () => {
  // Malformed base64 decodes to nonsense rather than throwing, and nonsense
  // that decodes to nothing at all is still a part with no content in it.
  const junk = await messageClient(alternative('!!!!', '<p>the whole newsletter</p>')).getMessage('alt')
  assert.equal(junk.text, 'the whole newsletter')

  const empty = await messageClient(alternative(b64url(''), '<p>the whole newsletter</p>')).getMessage('alt')
  assert.equal(empty.text, 'the whole newsletter')
})

test('getMessage returns a browser-stub plain part as written, and says so here rather than guessing', async () => {
  // The third shape of the same complaint, and the one deliberately left
  // alone. A stub is real characters, and any rule that dropped a short plain
  // part in favour of the html would throw away a genuinely short plain-text
  // newsletter -- the same false result in the other direction. Pinned so the
  // boundary of the whitespace rule is visible instead of assumed.
  const stub = await messageClient(alternative(b64url('View this email in your browser'), '<p>the whole newsletter</p>')).getMessage('alt')
  assert.equal(stub.text, 'View this email in your browser')
})

test('getMessage still prefers a plain part that has content', async () => {
  const m = await messageClient(alternative(b64url('what the sender wrote'), '<p>the rendering of it</p>')).getMessage('alt')
  assert.equal(m.text, 'what the sender wrote')
})

test('a 200 that parses into the wrong shape is gmail_unexpected, never an uncoded throw', async () => {
  const client = (body) => createGmail({ getToken: async () => 't', fetchImpl: async () => json(body) })
  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'

  await assert.rejects(client(null).labelId('x'), unexpected)
  await assert.rejects(client([]).labelId('x'), unexpected)
  await assert.rejects(client({ labels: {} }).labelId('x'), unexpected)
  await assert.rejects(client({ messages: {} }).listIds({ labelId: 'L', since: null, max: 5 }), unexpected)
  await assert.rejects(client({ id: 'a', payload: { headers: {} } }).getMessage('a'), unexpected)
  await assert.rejects(client({ id: 'a', payload: [] }).getMessage('a'), unexpected)
  // The id is what the caller dedups on, so passing an absent one through
  // would put a message in the store no later sweep can recognise.
  await assert.rejects(client({ payload: { headers: [] } }).getMessage('a'), unexpected)
})

test('a label list with no labels array is a shape failure, not "no such label"', async () => {
  // gmail_label_missing sends the operator off to create a label that already
  // exists. The two must not share a code.
  const broken = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ nextPageToken: 'x' }) })
  await assert.rejects(broken.labelId('AI hírlevél'), (e) => e.code === 'gmail_unexpected')

  const listed = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [{ id: 'L1', name: 'Other' }] }) })
  await assert.rejects(listed.labelId('AI hírlevél'), (e) => e.code === 'gmail_label_missing')
})

test('a cap that is not a positive number is gmail_unexpected, not a sweep with no requests', async () => {
  // maxMessages is an optional number field with a placeholder and no default.
  // Left blank it arrives as '' (Number('') is 0) or undefined (NaN), and an
  // empty list for either would record a clean sweep that never asked Gmail
  // anything. By the time the value is here, a blank setting and a deliberate
  // zero are the same value, so neither can be honoured.
  // 2.5 is admitted by a plain positive-number test and then sent as
  // maxResults=2.5, which Gmail rejects: the operator would read
  // gmail_list_failed and go looking at Gmail rather than at what they typed.
  for (const max of [undefined, null, '', NaN, 0, -1, 'five', {}, 2.5, 1.0001, Infinity]) {
    let calls = 0
    const g = createGmail({ getToken: async () => 't', fetchImpl: async () => { calls += 1; return json({ messages: [{ id: 'a' }] }) } })
    await assert.rejects(
      g.listIds({ labelId: 'L1', since: null, max }),
      (e) => e instanceof GmailError && e.code === 'gmail_unexpected',
      `max=${String(max)}`,
    )
    assert.equal(calls, 0)
  }
})

test('listIds collects the whole cap when Gmail delivers one id per page', async () => {
  // Gmail applies q inside a scan window, so a filtered page can carry a single
  // id. A fixed 25-page bound turned a request for 200 into 25 with nothing in
  // the result saying it had stopped early.
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => {
    calls += 1
    if (calls > 400) throw new Error('listIds paged past its bound')
    return json({ messages: [{ id: `m${calls}` }], nextPageToken: `p${calls}` })
  } })
  const r = await g.listIds({ labelId: 'L1', since: null, max: 200 })
  assert.equal(r.ids.length, 200)
  assert.equal(r.ids[0], 'm1')
  assert.equal(r.ids[199], 'm200')
  // The whole cap arrived, and Gmail still had pages, so this is a full batch
  // rather than a finished mailbox.
  assert.equal(r.truncated, true)
  assert.equal(r.stoppedOn, 'cap')
})

test('listIds says truncated when the hard page ceiling stops it with pages left', async () => {
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => {
    calls += 1
    if (calls > 400) throw new Error('listIds paged past its bound')
    return json({ messages: [{ id: `m${calls}` }], nextPageToken: `p${calls}` })
  } })
  const r = await g.listIds({ labelId: 'L1', since: null, max: 500 })
  assert.equal(r.ids.length, 200)
  assert.equal(r.truncated, true)
  // Short of the cap: the caller asked for 500 and the request budget, not the
  // cap, is what ended the walk.
  assert.equal(r.stoppedOn, 'page_ceiling')
})

test('a complete walk is never reported as truncated', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }] }) })
  assert.deepEqual(await g.listIds({ labelId: 'L1', since: null, max: 5 }), { ids: ['a'], truncated: false, stoppedOn: null })
  const none = createGmail({ getToken: async () => 't', fetchImpl: async () => json({}) })
  // Gmail omits `messages` entirely when a label has nothing matching, and that
  // is the one empty list here that really does mean "looked and found nothing".
  assert.deepEqual(await none.listIds({ labelId: 'L1', since: null, max: 5 }), { ids: [], truncated: false, stoppedOn: null })
})

test('listIds skips a page entry with no id instead of collecting a hole', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }, {}, null, { threadId: 't' }, { id: 'b' }] }) })
  assert.deepEqual(await g.listIds({ labelId: 'L1', since: null, max: 5 }), { ids: ['a', 'b'], truncated: false, stoppedOn: null })
})

test('a text part served as an attachment is distinguishable from having no text part', async () => {
  const detached = { id: 'd', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Weekly' }],
    parts: [{ mimeType: 'text/plain', body: { size: 40960, attachmentId: 'att9' } }] } }
  const m = await messageClient(detached).getMessage('d')
  assert.equal(m.text, '')
  assert.equal(m.textInAttachment, true)

  const readable = { id: 'r', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('inline') } } }
  const n = await messageClient(readable).getMessage('r')
  assert.equal(n.text, 'inline')
  assert.equal(n.textInAttachment, false)
})

test('getMessage reads a text part whose mimeType carries a charset or an odd case', async () => {
  const both = { id: 'c', payload: { mimeType: 'multipart/alternative', headers: [], parts: [
    { mimeType: 'text/plain; charset=UTF-8', body: { data: b64url('charset plain') } },
    { mimeType: 'TEXT/HTML; charset=utf-8', body: { data: b64url('<p>rendered</p>') } },
  ] } }
  assert.equal((await messageClient(both).getMessage('c')).text, 'charset plain')

  const htmlOnly = { id: 'h', payload: { mimeType: 'multipart/alternative', headers: [], parts: [
    { mimeType: 'Text/HTML; charset=ISO-8859-1', body: { data: b64url('<p>html only</p>') } },
  ] } }
  assert.equal((await messageClient(htmlOnly).getMessage('h')).text, 'html only')
})

test('getMessage survives a payload whose parts field is not an array', async () => {
  // `for (const p of {})` throws an uncoded TypeError, which a caller switching
  // on e.code cannot branch on.
  const msg = { id: 'odd', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('body text') }, parts: { 0: { mimeType: 'text/plain' } } } }
  const m = await messageClient(msg).getMessage('odd')
  assert.equal(m.text, 'body text')
})

test('getMessage escapes the message id into the path', async () => {
  const calls = []
  const m = await messageClient({ id: 'weird', payload: { headers: [] } }, calls).getMessage('a/../labels?x=1#f')
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

test('listIds says truncated when the cap fills while Gmail still holds pages', async () => {
  // The reproduction: a cap of 3 against a mailbox with more. A caller reading
  // truncated === false advances its watermark past everything it did not
  // fetch, and the rest is lost the same way the date window used to lose it.
  const g = createGmail({ getToken: async () => 't', fetchImpl: async (u) => {
    const n = Number(new URL(String(u)).searchParams.get('pageToken') || 1)
    return json({ messages: [{ id: `m${n}` }], nextPageToken: String(n + 1) })
  } })
  const r = await g.listIds({ labelId: 'L1', since: null, max: 3 })
  assert.deepEqual(r, { ids: ['m1', 'm2', 'm3'], truncated: true, stoppedOn: 'cap' })
})

test('listIds tells a cap stop apart from a page ceiling stop', async () => {
  // Both mean "there is more"; they do not mean the same thing to the caller.
  // A cap stop is the ordinary full batch a sweep is expected to leave behind
  // and come straight back for; a page ceiling stop means the walk gave up
  // before it even reached the cap, and coming straight back may not help.
  const endless = () => createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }], nextPageToken: 'more' }) })
  assert.equal((await endless().listIds({ labelId: 'L1', since: null, max: 2 })).stoppedOn, 'cap')
  assert.equal((await endless().listIds({ labelId: 'L1', since: null, max: 5000 })).stoppedOn, 'page_ceiling')
  // And a walk Gmail finished names no stop reason at all.
  const done = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }] }) })
  assert.equal((await done.listIds({ labelId: 'L1', since: null, max: 5 })).stoppedOn, null)
})

test('listIds does not follow a nextPageToken that is not a string', async () => {
  // Without the type guard a numeric token is truthy, so the walk sends
  // pageToken=12345 and pages on against a reply Gmail never meant as a
  // cursor, collecting the same page over and over.
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => {
    calls += 1
    if (calls > 20) throw new Error('listIds followed a non-string nextPageToken')
    return json({ messages: [{ id: 'a' }], nextPageToken: 12345 })
  } })
  const r = await g.listIds({ labelId: 'L1', since: null, max: 10 })
  assert.equal(calls, 1)
  assert.deepEqual(r, { ids: ['a'], truncated: false, stoppedOn: null })
})

test('a message with no payload at all is a shape failure, not a message with no content', async () => {
  // format=full always carries a payload, so an absent one is a broken reply.
  // Reported as empty text it is indistinguishable from a genuine PDF-only
  // newsletter, which is the false empty this module refuses everywhere else.
  const unexpected = (e) => e instanceof GmailError && e.code === 'gmail_unexpected'
  await assert.rejects(messageClient({ id: 'x' }).getMessage('x'), unexpected)
  await assert.rejects(messageClient({ id: 'x', payload: null }).getMessage('x'), unexpected)
  // The siblings already behaved this way; all three now share it.
  await assert.rejects(messageClient({ id: 'x', payload: 'full' }).getMessage('x'), unexpected)
  await assert.rejects(messageClient({ id: 'x', payload: [] }).getMessage('x'), unexpected)
})

test('a matching label with no id is a shape failure, not an id of undefined', async () => {
  // An undefined id goes straight into labelIds= on the next request, and the
  // sweep that comes back is a sweep of the wrong thing.
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [{ name: 'AI hírlevél' }] }) })
  await assert.rejects(g.labelId('AI hírlevél'), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
  const blank = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [{ id: '', name: 'AI hírlevél' }] }) })
  await assert.rejects(blank.labelId('AI hírlevél'), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
  const numeric = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ labels: [{ id: 7, name: 'AI hírlevél' }] }) })
  await assert.rejects(numeric.labelId('AI hírlevél'), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
})

test('a From header with no angle brackets is all address and no name', async () => {
  // The whole header as the display name puts "news@example.com" in the from
  // name of every signal such a sender produces, and the address is already
  // carried separately.
  const m = await messageClient({ id: 'a', payload: { headers: [{ name: 'From', value: 'news@example.com' }] } }).getMessage('a')
  assert.equal(m.fromEmail, 'news@example.com')
  assert.equal(m.fromName, '')
})

test('a non-integer message cap is refused before any request goes out', async () => {
  // maxMessages is a number input the operator types into. 2.5 sails past a
  // positive-number test, is sent as maxResults=2.5, and comes back as a plain
  // list failure that says nothing about the setting that caused it.
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => { calls += 1; return json({ messages: [{ id: 'a' }] }) } })
  await assert.rejects(g.listIds({ labelId: 'L1', since: null, max: 2.5 }), (e) => e instanceof GmailError && e.code === 'gmail_unexpected')
  assert.equal(calls, 0)
  // A whole number that arrived as a string is still a whole number.
  assert.deepEqual(await g.listIds({ labelId: 'L1', since: null, max: '2' }), { ids: ['a'], truncated: false, stoppedOn: null })
})
