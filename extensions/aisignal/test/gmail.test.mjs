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
  assert.deepEqual(await g.listIds({ labelId: 'L1', since: '2026-09-01T00:00:00Z', max: 10 }), ['a', 'b', 'c'])
  assert.match(urls[0], /q=after%3A2026%2F09%2F01/)
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
  assert.equal(sinceQuery('2026-09-03T10:00:00Z'), 'after:2026/09/03')
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

test('listIds stops instead of looping forever on an endless nextPageToken', async () => {
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => { calls += 1; return json({ messages: [], nextPageToken: 'always' }) } })
  const ids = await g.listIds({ labelId: 'L1', since: null, max: 50 })
  assert.deepEqual(ids, [])
  assert.equal(calls > 0, true)
  assert.equal(calls <= 25, true)
})

test('listIds with a max of zero returns nothing without asking Gmail', async () => {
  let calls = 0
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => { calls += 1; return json({ messages: [{ id: 'a' }] }) } })
  assert.deepEqual(await g.listIds({ labelId: 'L1', since: null, max: 0 }), [])
  assert.equal(calls, 0)
})

test('listIds never returns more ids than max, even if a page over-delivers', async () => {
  const g = createGmail({ getToken: async () => 't', fetchImpl: async () => json({ messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextPageToken: 'p2' }) })
  assert.deepEqual(await g.listIds({ labelId: 'L1', since: null, max: 2 }), ['a', 'b'])
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
