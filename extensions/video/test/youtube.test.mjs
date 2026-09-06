import assert from 'node:assert/strict'
import { test } from 'node:test'

import { VideoError } from '../src/args.mjs'
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

/** A `fetchImpl` that answers per feed url and records what it was asked. */
function halo(valaszok) {
  const hivasok = []
  const impl = async (url, init) => {
    hivasok.push({ url, init })
    const valasz = valaszok[url]
    assert.ok(valasz !== undefined, `the module fetched a feed this test did not stub: ${url}`)
    if (typeof valasz === 'function') throw valasz()
    if (typeof valasz === 'number') return { status: valasz, ok: false, text: async () => '' }
    return { status: 200, ok: true, text: async () => valasz }
  }
  return { impl, hivasok }
}

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
  const { jeloltek, eldobott } = feedJeloltek(feed([entry({ kiadva: '2026-08-26T21:44:41+00:00' })]))
  assert.equal(eldobott, 0)
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
  const { jeloltek, eldobott } = feedJeloltek(feed([
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
})

test('a missing view count is null rather than zero', () => {
  const { jeloltek } = feedJeloltek(feed([entry({ views: null })]))
  assert.equal(jeloltek[0].nezettseg, null, 'a video nobody watched and a feed that did not say are two facts')
})

test('feedJeloltek answers empty for a body that is not a feed at all', () => {
  for (const rossz of ['', '<html><body>404</body></html>', null, undefined]) {
    assert.deepEqual(feedJeloltek(rossz), { jeloltek: [], eldobott: 0 })
  }
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

test('at most PER_CSATORNA_LIMIT candidates come from one channel', async () => {
  const entries = []
  for (let n = 0; n < PER_CSATORNA_LIMIT + 20; n += 1) entries.push(entry({ id: `videoid${String(n).padStart(4, '0')}` }))
  const yt = ytdlp({ 'https://www.youtube.com/@a/videos': 'UCSHZKyawb77ixDdsGog4iWA' })
  const net = halo({ [FEED_URL('UCSHZKyawb77ixDdsGog4iWA')]: feed(entries) })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 30, ytDlp: '/y', execFileImpl: yt.impl, fetchImpl: net.impl })
  assert.equal(r.jeloltek.length, PER_CSATORNA_LIMIT)
})

// --- one fact about the machine, five about a channel ---

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

test('the five per-channel facts stay five, and one bad channel does not take the others', async () => {
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
