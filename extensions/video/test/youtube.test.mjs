import assert from 'node:assert/strict'
import { test } from 'node:test'

import { VideoError } from '../src/args.mjs'
import { MAX_CIM } from '../src/terv.mjs'
import { PER_CSATORNA_LIMIT, YT_DLP_ALAP, csatornaIdBol, csatornakOf, feedJeloltek, fetchYoutube, ytDlpUtvonalOf } from '../src/youtube.mjs'

/**
 * The YouTube source, driven without a process and without a request.
 *
 * NO TEST HERE STARTS EITHER. `fetchYoutube` takes `execFileImpl` and
 * `fetchImpl` as arguments for exactly this reason, and every test below hands
 * it functions that answer from strings. A test that ran the real binary or
 * made the real request would depend on a machine, a network and a stranger's
 * upload schedule, and would measure none of what this module decides: which
 * entries become candidates, which are dropped and counted, which failure is
 * about the machine and which is about one channel.
 */

/** `execFile`'s own error shape for a binary that is not on the given path. */
const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn' })
/** `execFile`'s shape for a child it killed on the timeout. */
const idotullepes = () => Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })
/** A child that ran and exited non-zero: yt-dlp's answer for a channel that is gone or private. */
const kilepett = () => Object.assign(new Error('Command failed'), { code: 1, killed: false })
/** What `fetch` rejects with once its AbortController fires. */
const megszakadt = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })

const napokkalEzelott = (n) => new Date(Date.now() - n * 86_400_000).toISOString()

/** One Atom entry as YouTube writes it, with the fields this module reads and the noise it must step over. */
function entry({ id = 'NYFGCESmikA', cim = 'Egy cím', kiadva = napokkalEzelott(1), views = '1359950' } = {}) {
  return `
 <entry>
  <id>yt:video:${id}</id>
  ${id === null ? '' : `<yt:videoId>${id}</yt:videoId>`}
  <yt:channelId>UCSHZKyawb77ixDdsGog4iWA</yt:channelId>
  ${cim === null ? '' : `<title>${cim}</title>`}
  <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
  <author><name>Lex Fridman</name><uri>https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA</uri></author>
  ${kiadva === null ? '' : `<published>${kiadva}</published>`}
  <updated>2026-08-29T15:34:37+00:00</updated>
  <media:group>
   <media:title>${cim}</media:title>
   <media:thumbnail url="https://i3.ytimg.com/vi/${id}/hqdefault.jpg" width="480" height="360"/>
   <media:description>Egy leírás, benne &lt;tag&gt; és | jel.</media:description>
   <media:community>
    <media:starRating count="14144" average="5.00" min="1" max="5"/>
    ${views === null ? '' : `<media:statistics views="${views}"/>`}
   </media:community>
  </media:group>
 </entry>`
}

/**
 * A whole feed. The channel-level `<title>` and `<published>` are here on
 * purpose: they are what a document-wide search would wrongly attribute to
 * the newest video.
 */
const feed = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>SHZKyawb77ixDdsGog4iWA</yt:channelId>
 <title>Lex Fridman</title>
 <published>2006-09-20T05:17:16+00:00</published>
${entries.join('\n')}
</feed>`

const FEED_URL = (id) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`

/** An `execFileImpl` that answers per channel url and records what it was asked. */
function ytdlp(valaszok) {
  const hivasok = []
  const impl = async (command, args, options) => {
    hivasok.push({ command, args, options })
    const cel = args[0]
    const valasz = valaszok[cel]
    assert.ok(valasz !== undefined, `the module resolved a channel this test did not stub: ${cel}`)
    if (typeof valasz === 'function') throw valasz()
    return { stdout: valasz, stderr: '' }
  }
  return { impl, hivasok }
}

/**
 * A `fetchImpl` that answers per feed url and records what it was asked. A
 * number is an HTTP status, a function is a rejection, an object is a
 * hand-built response (so a `content-length` can be tested), anything else is
 * a 200 carrying that string.
 */
function halo(valaszok) {
  const hivasok = []
  const impl = async (url, init) => {
    hivasok.push({ url, init })
    const valasz = valaszok[url]
    assert.ok(valasz !== undefined, `the module fetched a feed this test did not stub: ${url}`)
    if (typeof valasz === 'function') throw valasz()
    if (typeof valasz === 'number') return { status: valasz, ok: false, text: async () => '' }
    if (typeof valasz === 'object' && valasz !== null) return valasz
    return { status: 200, ok: true, headers: fejlecek({}), text: async () => valasz }
  }
  return { impl, hivasok }
}

/** `Headers`'s one method this module uses. A response with no headers at all is also a shape a transport can produce. */
const fejlecek = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null })

const settings = (youtubeCsatornak, extra = {}) => ({ settings: () => ({ youtubeCsatornak, ...extra }) })

// --- the channel list, and the difference between "not asked" and "nothing" ---

test('csatornakOf turns handles and bare channel ids into urls, keeps urls, and drops blanks', () => {
  assert.deepEqual(
    csatornakOf(settings(' @lexfridman , https://www.youtube.com/@masik ,, UCSHZKyawb77ixDdsGog4iWA ')),
    ['https://www.youtube.com/@lexfridman', 'https://www.youtube.com/@masik', 'https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA'],
  )
})

test('an empty channel list is a named refusal, never an empty result', () => {
  for (const raw of [undefined, null, '', '   ', ' , ,, ']) {
    assert.throws(() => csatornakOf(settings(raw)), (err) => {
      assert.ok(err instanceof VideoError)
      assert.equal(err.code, 'youtube_nincs_csatorna')
      assert.ok(err.message.includes('youtubeCsatornak'), 'the refusal names the field the operator has to fill')
      return true
    })
  }
})

test('the yt-dlp path falls back to the module own default when the operator cleared the field', () => {
  assert.equal(ytDlpUtvonalOf(settings('@a')), YT_DLP_ALAP)
  assert.equal(ytDlpUtvonalOf(settings('@a', { ytDlpUtvonal: '' })), YT_DLP_ALAP)
  assert.equal(ytDlpUtvonalOf(settings('@a', { ytDlpUtvonal: '  ' })), YT_DLP_ALAP)
  assert.equal(ytDlpUtvonalOf(settings('@a', { ytDlpUtvonal: '/opt/yt-dlp' })), '/opt/yt-dlp')
})

test('csatornaIdBol reads a channel id the operator already wrote, and nothing else', () => {
  assert.equal(csatornaIdBol('https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA'), 'UCSHZKyawb77ixDdsGog4iWA')
  assert.equal(csatornaIdBol('https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA/videos'), 'UCSHZKyawb77ixDdsGog4iWA')
  assert.equal(csatornaIdBol('https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA?x=1'), 'UCSHZKyawb77ixDdsGog4iWA')
  assert.equal(csatornaIdBol('https://www.youtube.com/@lexfridman'), null)
  assert.equal(csatornaIdBol('https://www.youtube.com/channel/rossz'), null)
})

// --- the feed reader ---

test('feedJeloltek reads one entry and builds the watch url from a checked id', () => {
  const { jeloltek, eldobott, blokkok } = feedJeloltek(feed([entry({ kiadva: '2026-08-26T21:44:41+00:00' })]))
  assert.equal(eldobott, 0)
  assert.equal(blokkok, 1, 'how many entry blocks the body carried, before any of them was judged')
  assert.equal(feedJeloltek(feed([])).atom, true, 'and whether the body was a feed at all')
  assert.deepEqual(jeloltek, [{
    id: 'NYFGCESmikA',
    cim: 'Egy cím',
    url: 'https://www.youtube.com/watch?v=NYFGCESmikA',
    feltoltve: '2026-08-26T21:44:41.000Z',
    nezettseg: 1359950,
  }])
})

test('feedJeloltek reads the entry own title and date, never the channel own', () => {
  // The feed carries a channel-level <title>Lex Fridman</title> and a
  // channel-level <published>2006-…</published>. A document-wide search would
  // put the channel's creation date on the newest video and call every card
  // "Lex Fridman".
  const { jeloltek } = feedJeloltek(feed([entry({ cim: 'A videó címe', kiadva: '2026-08-26T21:44:41+00:00' })]))
  assert.equal(jeloltek[0].cim, 'A videó címe')
  assert.equal(jeloltek[0].feltoltve, '2026-08-26T21:44:41.000Z')
})

test('an XML-escaped title comes back as the text the channel wrote', () => {
  const { jeloltek } = feedJeloltek(feed([entry({ cim: 'DHH: Vibe Coding &amp; Linux &lt;b&gt; &quot;idézet&quot; &#39;aposztróf&#39; | #501' })]))
  assert.equal(jeloltek[0].cim, 'DHH: Vibe Coding & Linux <b> "idézet" \'aposztróf\' | #501')
})

test('the ampersand is undone last, so an escaped entity does not become markup', () => {
  // `&amp;lt;` is how a channel writes a literal `&lt;` in its title. Undoing
  // `&amp;` first would turn it into `<` -- this module inventing markup that
  // nobody wrote.
  const { jeloltek } = feedJeloltek(feed([entry({ cim: 'Egy &amp;lt;script&amp;gt; a címben' })]))
  assert.equal(jeloltek[0].cim, 'Egy &lt;script&gt; a címben')
})

test('an entry missing an id, a title or a readable date is dropped whole and counted', () => {
  const { jeloltek, eldobott, blokkok } = feedJeloltek(feed([
    entry({ id: null }),
    entry({ id: '../../etc/passwd' }),
    entry({ id: 'abc' }),
    entry({ id: 'x'.repeat(33) }),
    entry({ cim: '   ' }),
    entry({ kiadva: null }),
    entry({ kiadva: 'nem dátum' }),
    entry({ id: 'joVideoId12' }),
  ]))
  assert.deepEqual(jeloltek.map((j) => j.id), ['joVideoId12'], 'nothing half-built ever reaches a card')
  assert.equal(eldobott, 7, 'a feed the module took almost nothing from must not read as a quiet channel')
  assert.equal(blokkok, 8, 'the body WAS read; it is the entries that were refused')
})

test('a title longer than the module stores is cut where it is read', () => {
  // `mezo` matches `[^<]*`, so nothing between a channel's <title> and this
  // module's storage bounds it except the 4 MB body cap. The cut is here
  // rather than at the rpc so that no oversized title exists in the module at
  // all: `feedJeloltek` is what the rpc, these tests and anything later built
  // on this file read.
  const { jeloltek } = feedJeloltek(feed([entry({ cim: 'á'.repeat(50_000) })]))
  assert.equal(jeloltek.length, 1, 'an oversized title is cut, never a reason to drop the entry')
  assert.equal(jeloltek[0].cim.length, MAX_CIM)
  assert.equal(jeloltek[0].cim, 'á'.repeat(MAX_CIM))
})

test('a title that is only whitespace is still dropped after the cut', () => {
  // The cut runs BEFORE the blank test, so the drop test judges the string
  // that would actually be stored: two hundred spaces followed by text is a
  // blank title, and a cut applied afterwards would have let it through.
  const { jeloltek, eldobott } = feedJeloltek(feed([entry({ cim: ' '.repeat(MAX_CIM + 50) + 'valami' })]))
  assert.deepEqual(jeloltek, [])
  assert.equal(eldobott, 1)
})

test('a missing view count is null rather than zero', () => {
  const { jeloltek } = feedJeloltek(feed([entry({ views: null })]))
  assert.equal(jeloltek[0].nezettseg, null, 'a video nobody watched and a feed that did not say are two facts')
})

test('feedJeloltek does not throw on a body that is not a string', () => {
  // The guard exists because `res.text()` is a double's return value as much
  // as a real fetch's, and a reader that threw here would turn one odd
  // response into a bug report rather than a per-channel code.
  for (const rossz of [null, undefined, 42, {}]) {
    assert.deepEqual(feedJeloltek(rossz), { jeloltek: [], eldobott: 0, blokkok: 0, atom: false })
  }
})

test('feedJeloltek reports whether the body was Atom at all, separately from how many entries it had', () => {
  // THE TWO OBSERVATIONS, AND WHY NEITHER ALONE IS ENOUGH. `eldobott` cannot
  // separate these: a body with no entry block produces zero drops, not
  // fifteen. And `blokkok === 0` alone cannot either -- a real feed for a
  // channel with no public uploads has zero entries and is perfectly fine.

  // Not a feed at all: a consent interstitial, a rate-limit page, an error
  // page served with HTTP 200.
  for (const rossz of ['', '<html><body>404</body></html>', '{"error":"quota"}']) {
    const r = feedJeloltek(rossz)
    assert.deepEqual(r.jeloltek, [])
    assert.equal(r.eldobott, 0, 'there is nothing to drop, which is exactly why eldobott cannot catch this')
    assert.equal(r.blokkok, 0)
    assert.equal(r.atom, false)
  }

  // A REAL feed with no entry: the channel has published nothing. Both the
  // opening tag and the namespace uri count as the signal, either alone.
  for (const ures of [
    '<feed><title>Üres</title></feed>',
    '<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>Üres</title></feed>',
    '<x xmlns="http://www.w3.org/2005/Atom"/>',
  ]) {
    const r = feedJeloltek(ures)
    assert.equal(r.atom, true, 'this body IS a feed; it just carries nothing')
    assert.equal(r.blokkok, 0)
  }

  // A feed WITH entries that are all unusable: the body was read, and the
  // entries were refused.
  // `ro` is too short for ID_ALAK; `rossz` would have been five characters and
  // therefore a perfectly acceptable id.
  const mind = feedJeloltek(feed([entry({ id: 'ro' }), entry({ kiadva: null })]))
  assert.equal(mind.atom, true)
  assert.equal(mind.blokkok, 2)
  assert.equal(mind.eldobott, 2)
})

// --- resolve, then read ---

test('a channel is resolved with yt-dlp once, then read from its feed once', async () => {
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': 'UCSHZKyawb77ixDdsGog4iWA\n' })
  const net = halo({ [FEED_URL('UCSHZKyawb77ixDdsGog4iWA')]: feed([entry()]) })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 7, ytDlp: '/bin/yt-dlp', execFileImpl: yt.impl, fetchImpl: net.impl })

  assert.equal(yt.hivasok.length, 1)
  const [hivas] = yt.hivasok
  assert.equal(hivas.command, '/bin/yt-dlp')
  assert.deepEqual(hivas.args, [
    'https://www.youtube.com/@a/videos', '--flat-playlist', '--skip-download',
    '--playlist-end', '1', '--no-update', '--print', '%(playlist_channel_id)s',
  ])
  assert.ok(hivas.args.includes('--no-update'), 'without it the binary prints three lines of version warning on every run')
  assert.ok(hivas.options.timeout > 0, 'a resolve that never returns must not hold the button forever')
  assert.ok(hivas.options.maxBuffer > 0)
  assert.equal(hivas.options.windowsHide, true)
  assert.equal(hivas.options.shell, undefined, 'no shell: the channel url is an argument, not a command')

  assert.equal(net.hivasok.length, 1)
  assert.ok(net.hivasok[0].init.signal, 'the request carries a deadline of its own')
  assert.equal(r.jeloltek.length, 1)
})

test('a channel the operator gave by id starts no process at all', async () => {
  const yt = ytdlp({})
  const net = halo({ [FEED_URL('UCSHZKyawb77ixDdsGog4iWA')]: feed([entry()]) })
  const r = await fetchYoutube({
    csatornak: ['https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA'],
    napok: 7, ytDlp: '/bin/yt-dlp', execFileImpl: yt.impl, fetchImpl: net.impl,
  })
  assert.deepEqual(yt.hivasok, [], 'there is nothing to resolve, so seconds are not spent resolving it')
  assert.equal(r.jeloltek.length, 1)
})

// --- the window filter, which is real now ---

test('an upload outside the window is dropped and counted, and the fresh ones are kept', async () => {
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': 'UCSHZKyawb77ixDdsGog4iWA' })
  const net = halo({
    [FEED_URL('UCSHZKyawb77ixDdsGog4iWA')]: feed([
      entry({ id: 'friss000001', kiadva: napokkalEzelott(1) }),
      entry({ id: 'friss000002', kiadva: napokkalEzelott(29) }),
      entry({ id: 'regi0000001', kiadva: napokkalEzelott(31) }),
      entry({ id: 'regi0000002', kiadva: napokkalEzelott(400) }),
    ]),
  })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 30, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl })
  assert.deepEqual(r.jeloltek.map((j) => j.id), ['friss000001', 'friss000002'])
  assert.equal(r.eldobott, 2)
  assert.deepEqual(r.csatornaHibak, [])
})

test('a channel whose uploads are all older than the window says so rather than going quiet', async () => {
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': 'UCSHZKyawb77ixDdsGog4iWA' })
  const net = halo({ [FEED_URL('UCSHZKyawb77ixDdsGog4iWA')]: feed([entry({ kiadva: napokkalEzelott(200) })]) })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 7, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl })
  assert.deepEqual(r.jeloltek, [])
  assert.equal(r.eldobott, 1)
  assert.deepEqual(r.csatornaHibak, [{ csatorna: 'https://www.youtube.com/@a', ok: 'csatorna_nincs_friss' }],
    '"this channel had nothing" and "this channel could not be read" are the two states a quiet board most needs told apart')
})

test('the per-channel cap counts what it leaves behind rather than walking away from it', async () => {
  const entries = []
  for (let n = 0; n < PER_CSATORNA_LIMIT + 20; n += 1) entries.push(entry({ id: `videoid${String(n).padStart(4, '0')}` }))
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': 'UCSHZKyawb77ixDdsGog4iWA' })
  const net = halo({ [FEED_URL('UCSHZKyawb77ixDdsGog4iWA')]: feed(entries) })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 30, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl })
  assert.equal(r.jeloltek.length, PER_CSATORNA_LIMIT)
  // A break that walked away would answer "0 dropped" over twenty unread
  // entries -- under-reporting exactly when the input is strangest, which is
  // the one moment the counter is for.
  assert.equal(r.eldobott, 20)
})

// --- one fact about the machine, eight about a channel ---

test('a missing binary refuses the whole source by name, because it is a fact about the machine', async () => {
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': enoent, 'https://www.youtube.com/@b/videos': 'UCSHZKyawb77ixDdsGog4iWA' })
  const net = halo({})
  await assert.rejects(
    fetchYoutube({ csatornak: ['https://www.youtube.com/@a', 'https://www.youtube.com/@b'], napok: 30, ytDlp: '/nincs/yt-dlp', execFileImpl: yt.impl, fetchImpl: net.impl }),
    (err) => {
      assert.ok(err instanceof VideoError)
      assert.equal(err.code, 'ytdlp_hianyzik')
      assert.ok(err.message.includes('ytDlpUtvonal'), 'the refusal names the setting the operator has to fix')
      assert.equal(err.message.includes('/nincs/yt-dlp'), false, 'a refusal never repeats a value the operator stored')
      return true
    },
  )
  assert.equal(yt.hivasok.length, 1, 'a binary that is not there will not be there for the second channel either')
  assert.deepEqual(net.hivasok, [], 'and nothing was fetched over a source that cannot be read')
})

test('the per-channel facts stay apart, and one bad channel does not take the others', async () => {
  const yt = ytdlp({
    'https://www.youtube.com/@a/videos': kilepett,
    'https://www.youtube.com/@b/videos': idotullepes,
    'https://www.youtube.com/@c/videos': 'NA',
    'https://www.youtube.com/@d/videos': 'UCddddddddddddddddddddd',
    'https://www.youtube.com/@e/videos': 'UCeeeeeeeeeeeeeeeeeeeee',
    'https://www.youtube.com/@f/videos': 'UCfffffffffffffffffffff',
  })
  const net = halo({
    [FEED_URL('UCddddddddddddddddddddd')]: 404,
    [FEED_URL('UCeeeeeeeeeeeeeeeeeeeee')]: megszakadt,
    [FEED_URL('UCfffffffffffffffffffff')]: feed([entry()]),
  })
  const r = await fetchYoutube({
    csatornak: ['@a', '@b', '@c', '@d', '@e', '@f'].map((h) => `https://www.youtube.com/${h}`),
    napok: 30, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl,
  })
  assert.deepEqual(r.jeloltek.map((j) => j.id), ['NYFGCESmikA'], 'the last channel ran')
  assert.deepEqual(r.csatornaHibak, [
    { csatorna: 'https://www.youtube.com/@a', ok: 'csatorna_nem_valaszolt' },
    { csatorna: 'https://www.youtube.com/@b', ok: 'csatorna_idotullepes' },
    // yt-dlp answered, just not with a channel id: a renamed handle or a url
    // that is not a channel. The feed url is never built out of `NA`.
    { csatorna: 'https://www.youtube.com/@c', ok: 'csatorna_azonosito_ismeretlen' },
    { csatorna: 'https://www.youtube.com/@d', ok: 'csatorna_feed_nem_valaszolt' },
    { csatorna: 'https://www.youtube.com/@e', ok: 'csatorna_feed_idotullepes' },
  ])
})

test('a feed answering with something that is not a response is not read as an empty channel', async () => {
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': 'UCSHZKyawb77ixDdsGog4iWA' })
  const r = await fetchYoutube({
    csatornak: ['https://www.youtube.com/@a'], napok: 30, ytDlp: '/y',
    execFileImpl: yt.impl, fetchImpl: async () => 'nem válasz',
  })
  assert.deepEqual(r.csatornaHibak, [{ csatorna: 'https://www.youtube.com/@a', ok: 'csatorna_feed_nem_valaszolt' }])
  assert.deepEqual(r.jeloltek, [])
})

test('the four ways a channel yields no candidate arrive as four different facts', async () => {
  // THE DEFECT THIS PINS, end to end, and the one every round of review has
  // found rotated one notch: distinct facts sharing a sentence that is false
  // about at least one of them. All four channels below produce zero
  // candidates, and the operator does something different about each.
  const yt = ytdlp({
    'https://www.youtube.com/@a/videos': 'UCaaaaaaaaaaaaaaaaaaaaa',
    'https://www.youtube.com/@b/videos': 'UCbbbbbbbbbbbbbbbbbbbbb',
    'https://www.youtube.com/@c/videos': 'UCccccccccccccccccccccc',
    'https://www.youtube.com/@d/videos': 'UCddddddddddddddddddddd',
  })
  const net = halo({
    // 1. Not a feed: a consent interstitial served with HTTP 200.
    [FEED_URL('UCaaaaaaaaaaaaaaaaaaaaa')]: '<html><body>Before you continue to YouTube</body></html>',
    // 2. A real feed with no entry: a channel that has published nothing.
    [FEED_URL('UCbbbbbbbbbbbbbbbbbbbbb')]: feed([]),
    // 3. A real feed whose entries all drifted out of shape.
    [FEED_URL('UCccccccccccccccccccccc')]: feed([entry({ id: 'ro' }), entry({ kiadva: null }), entry({ cim: '  ' })]),
    // 4. A real feed with usable entries, none of them inside the window.
    [FEED_URL('UCddddddddddddddddddddd')]: feed([entry({ id: 'stale000001', kiadva: napokkalEzelott(300) }), entry({ id: 'stale000002', kiadva: napokkalEzelott(200) }), entry({ id: 'stale000003', kiadva: napokkalEzelott(100) })]),
  })
  const r = await fetchYoutube({
    csatornak: ['@a', '@b', '@c', '@d'].map((h) => `https://www.youtube.com/${h}`),
    napok: 7, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl,
  })
  assert.deepEqual(r.jeloltek, [])
  assert.deepEqual(r.csatornaHibak, [
    { csatorna: 'https://www.youtube.com/@a', ok: 'csatorna_feed_ertelmezhetetlen' },
    // NOT ertelmezhetetlen: this channel is fine and the advice for an
    // unreadable feed ("open it in a browser") would be false about it.
    { csatorna: 'https://www.youtube.com/@b', ok: 'csatorna_nincs_feltoltes' },
    // NOT nincs_friss: nothing here is about freshness, the feed's own shape
    // moved, and a global `eldobott` sum cannot say which channel it was.
    { csatorna: 'https://www.youtube.com/@c', ok: 'csatorna_feed_ertelmezhetetlen' },
    { csatorna: 'https://www.youtube.com/@d', ok: 'csatorna_nincs_friss' },
  ])
  assert.equal(r.eldobott, 6, 'three unreadable entries and three stale ones, all counted')
})

test('a real feed whose entries are all stale is a quiet channel, and a widened guard would say otherwise', async () => {
  // THE GUARD THIS PINS. `fetchYoutube` refuses a channel whose feed yielded
  // no USABLE entry (`olvasott.jeloltek.length === 0`), which is measured
  // BEFORE the window filter. A guard widened to look after it -- "no
  // candidate survived, so the feed must be broken" -- would turn every quiet
  // channel into an unreadable one. Three well-formed entries make that
  // mistake visible: the reader hands back three, and the window drops all
  // three.
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': 'UCSHZKyawb77ixDdsGog4iWA' })
  const net = halo({
    [FEED_URL('UCSHZKyawb77ixDdsGog4iWA')]: feed([
      entry({ id: 'stale000001', kiadva: napokkalEzelott(300) }),
      entry({ id: 'stale000002', kiadva: napokkalEzelott(200) }),
      entry({ id: 'stale000003', kiadva: napokkalEzelott(100) }),
    ]),
  })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 7, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl })
  assert.deepEqual(r.csatornaHibak, [{ csatorna: 'https://www.youtube.com/@a', ok: 'csatorna_nincs_friss' }])
  assert.equal(r.eldobott, 3, 'all three were readable and all three were outside the window')

  // And the same three inside a wider window are ordinary candidates, so the
  // channel says nothing about itself at all.
  const tag = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 365, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl })
  assert.equal(tag.jeloltek.length, 3)
  assert.deepEqual(tag.csatornaHibak, [])
})

test('a feed bigger than the module will read is refused by name rather than truncated', async () => {
  const yt = ytdlp({
    'https://www.youtube.com/@a/videos': 'UCaaaaaaaaaaaaaaaaaaaaa',
    'https://www.youtube.com/@b/videos': 'UCbbbbbbbbbbbbbbbbbbbbb',
  })
  let olvasott = false
  const net = halo({
    // Refused on the header, before a byte of the body is read.
    [FEED_URL('UCaaaaaaaaaaaaaaaaaaaaa')]: {
      status: 200, ok: true, headers: fejlecek({ 'content-length': String(9 * 1024 * 1024) }),
      text: async () => { olvasott = true; return 'x' },
    },
    // Chunked, so there is no header to refuse on; the length is checked once
    // it is in hand, and a cut feed is never handed on as a whole one.
    [FEED_URL('UCbbbbbbbbbbbbbbbbbbbbb')]: {
      status: 200, ok: true, headers: fejlecek({}),
      text: async () => feed([entry()]) + 'x'.repeat(5 * 1024 * 1024),
    },
  })
  const r = await fetchYoutube({
    csatornak: ['https://www.youtube.com/@a', 'https://www.youtube.com/@b'],
    napok: 30, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl,
  })
  assert.equal(olvasott, false, 'a content-length over the cap is refused before the body is read')
  assert.deepEqual(r.csatornaHibak, [
    { csatorna: 'https://www.youtube.com/@a', ok: 'csatorna_feed_tul_nagy' },
    { csatorna: 'https://www.youtube.com/@b', ok: 'csatorna_feed_tul_nagy' },
  ])
  assert.deepEqual(r.jeloltek, [], 'nothing is taken from a body the module would only have half of')
})

test('a response with no headers at all is read rather than refused', async () => {
  // Not every transport gives a `headers` object; the cap must not turn that
  // into a failure on a feed that is perfectly ordinary.
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': 'UCSHZKyawb77ixDdsGog4iWA' })
  const net = halo({
    [FEED_URL('UCSHZKyawb77ixDdsGog4iWA')]: { status: 200, ok: true, text: async () => feed([entry()]) },
  })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 30, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl })
  assert.equal(r.jeloltek.length, 1)
  assert.deepEqual(r.csatornaHibak, [])
})
