import assert from 'node:assert/strict'
import { test } from 'node:test'

import { VideoError } from '../src/args.mjs'
import { PER_CSATORNA_LIMIT, PLAYLIST_END, YT_DLP_ALAP, csatornakOf, fetchYoutube, ytDlpUtvonalOf } from '../src/youtube.mjs'

/**
 * The YouTube listing, driven without a process.
 *
 * NO TEST HERE STARTS ONE. `fetchYoutube` takes `execFileImpl` as an
 * argument for exactly this reason, and every test below hands it a function
 * that answers from a string. A test that ran the real binary would depend on
 * a machine, a network and a stranger's upload schedule, and would measure
 * none of what this module decides: which lines become candidates, which are
 * dropped and counted, which failure is about the machine and which is about
 * one channel.
 */

/** `execFile`'s own error shape for a binary that is not on the given path. */
const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn' })
/** `execFile`'s shape for a child it killed on the timeout. */
const idotullepes = () => Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })
/** A child that ran and exited non-zero: yt-dlp's answer for a channel that is gone or private. */
const kilepett = () => Object.assign(new Error('Command failed'), { code: 1, killed: false })

/** One `--print` line as yt-dlp writes it: id, upload_date, view_count, title, joined by `|`. */
const sor = (id, datum, nezettseg, cim) => `${id}|${datum}|${nezettseg}|${cim}`

const napja = (n) => {
  const d = new Date(Date.now() - n * 86_400_000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

/** An `execFileImpl` that answers per channel URL and records what it was asked. */
function runner(valaszok) {
  const hivasok = []
  const impl = async (command, args, options) => {
    hivasok.push({ command, args, options })
    const cel = args[0]
    const valasz = valaszok[cel]
    assert.ok(valasz !== undefined, `the module asked for a channel this test did not stub: ${cel}`)
    if (typeof valasz === 'function') throw valasz()
    return { stdout: valasz, stderr: '' }
  }
  return { impl, hivasok }
}

const settings = (youtubeCsatornak, extra = {}) => ({ settings: () => ({ youtubeCsatornak, ...extra }) })

// --- the channel list, and the difference between "not asked" and "nothing" ---

test('csatornakOf turns handles into urls, keeps urls, and drops blanks', () => {
  assert.deepEqual(
    csatornakOf(settings(' @lexfridman , https://www.youtube.com/@masik ,, https://www.youtube.com/channel/UC1 ')),
    ['https://www.youtube.com/@lexfridman', 'https://www.youtube.com/@masik', 'https://www.youtube.com/channel/UC1'],
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

// --- the listing call itself ---

test('the listing runs as an argument vector with a timeout, never through a shell', async () => {
  const { impl, hivasok } = runner({ 'https://www.youtube.com/@a/videos': sor('aaaaa', 'NA', 'NA', 'Egy') })
  await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 7, ytDlp: '/bin/yt-dlp', execFileImpl: impl })
  const [hivas] = hivasok
  assert.equal(hivas.command, '/bin/yt-dlp')
  assert.deepEqual(hivas.args, [
    'https://www.youtube.com/@a/videos', '--flat-playlist', '--skip-download',
    '--playlist-end', String(PLAYLIST_END),
    '--print', '%(id)s|%(upload_date)s|%(view_count)s|%(title)s',
  ])
  assert.ok(hivas.options.timeout > 0, 'a listing that never returns must not hold the button forever')
  assert.ok(hivas.options.maxBuffer > 0, 'the output is one line per video and needs a bound of its own')
  assert.equal(hivas.options.windowsHide, true)
  assert.equal(hivas.options.shell, undefined, 'no shell: the channel url is an argument, not a command')
})

test('the module builds the watch url from an id it checked, never from the text yt-dlp printed', async () => {
  const { impl } = runner({ 'https://www.youtube.com/@a/videos': sor('NYFGCESmikA', 'NA', '1234', 'Egy cím') })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 7, ytDlp: '/bin/yt-dlp', execFileImpl: impl })
  assert.deepEqual(r.jeloltek, [{
    id: 'NYFGCESmikA', cim: 'Egy cím', url: 'https://www.youtube.com/watch?v=NYFGCESmikA', feltoltve: null, nezettseg: 1234,
  }])
})

test('a title containing the separator survives whole', async () => {
  // yt-dlp joins four fields with `|` and the fourth may contain any number of
  // them: `split('|')` alone would cut a real YouTube title in half.
  const cim = 'DHH: Future of Programming | Lex Fridman Podcast #501 | rész 2'
  const { impl } = runner({ 'https://www.youtube.com/@a/videos': sor('NYFGCESmikA', '20260901', '90', cim) })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 3650, ytDlp: '/y', execFileImpl: impl })
  assert.equal(r.jeloltek[0].cim, cim)
  assert.equal(r.jeloltek[0].url, 'https://www.youtube.com/watch?v=NYFGCESmikA')
})

test('an upload_date outside the window is dropped and counted, and an unknown one is kept', async () => {
  const { impl } = runner({
    'https://www.youtube.com/@a/videos': [
      sor('friss1', napja(1), '10', 'Friss'),
      sor('regi01', napja(90), '20', 'Régi'),
      sor('regi02', napja(31), '30', 'Alig régi'),
      // The measured reality of `--flat-playlist` on a channel tab: yt-dlp
      // prints NA. An unknown date is not a date outside the window.
      sor('ismer1', 'NA', 'NA', 'Dátum nélkül'),
    ].join('\n'),
  })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 30, ytDlp: '/y', execFileImpl: impl })
  assert.deepEqual(r.jeloltek.map((j) => j.id), ['friss1', 'ismer1'])
  assert.equal(r.eldobott, 2, 'a page the module took nothing from must not read as an empty page')
  assert.equal(r.jeloltek[0].feltoltve, `${napja(1).slice(0, 4)}-${napja(1).slice(4, 6)}-${napja(1).slice(6, 8)}T00:00:00.000Z`)
  assert.equal(r.jeloltek[1].feltoltve, null)
})

test('a line whose id is not shaped like a video id is dropped and counted, never pasted into a url', async () => {
  const { impl } = runner({
    'https://www.youtube.com/@a/videos': [
      sor('../../etc/passwd', 'NA', 'NA', 'Rossz'),
      sor('a b c', 'NA', 'NA', 'Szóköz'),
      sor('abc', 'NA', 'NA', 'Túl rövid'),
      sor('x'.repeat(33), 'NA', 'NA', 'Túl hosszú'),
      sor('NYFGCESmikA', 'NA', 'NA', 'Jó'),
      'nincs benne elvalaszto',
      '',
    ].join('\n'),
  })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 30, ytDlp: '/y', execFileImpl: impl })
  assert.deepEqual(r.jeloltek.map((j) => j.id), ['NYFGCESmikA'])
  // Five rows the module would not take: four bad ids and one line that did
  // not carry the four fields at all. The last is the format drift the
  // counter exists for. A blank line is not a row and is not counted.
  assert.equal(r.eldobott, 5)
  for (const j of r.jeloltek) assert.ok(j.url.startsWith('https://www.youtube.com/watch?v='))
})

test('at most PER_CSATORNA_LIMIT candidates come from one channel', async () => {
  const sorok = []
  for (let n = 0; n < PER_CSATORNA_LIMIT + 20; n += 1) sorok.push(sor(`vid${String(n).padStart(4, '0')}`, 'NA', 'NA', `Cím ${n}`))
  const { impl } = runner({ 'https://www.youtube.com/@a/videos': sorok.join('\n') })
  const r = await fetchYoutube({ csatornak: ['https://www.youtube.com/@a'], napok: 30, ytDlp: '/y', execFileImpl: impl })
  assert.equal(r.jeloltek.length, PER_CSATORNA_LIMIT)
  assert.equal(r.jeloltek.at(-1).id, `vid${String(PER_CSATORNA_LIMIT - 1).padStart(4, '0')}`)
})

// --- two facts, two answers ---

test('a missing binary refuses the whole source by name, because it is a fact about the machine', async () => {
  const { impl, hivasok } = runner({
    'https://www.youtube.com/@a/videos': enoent,
    'https://www.youtube.com/@b/videos': sor('NYFGCESmikA', 'NA', 'NA', 'Egy'),
  })
  await assert.rejects(
    fetchYoutube({ csatornak: ['https://www.youtube.com/@a', 'https://www.youtube.com/@b'], napok: 30, ytDlp: '/nincs/yt-dlp', execFileImpl: impl }),
    (err) => {
      assert.ok(err instanceof VideoError)
      assert.equal(err.code, 'ytdlp_hianyzik')
      assert.ok(err.message.includes('ytDlpUtvonal'), 'the refusal names the setting the operator has to fix')
      assert.equal(err.message.includes('/nincs/yt-dlp'), false, 'a refusal never repeats a value the operator stored')
      return true
    },
  )
  assert.equal(hivasok.length, 1, 'a binary that is not there will not be there for the second channel either')
})

test('one channel failing does not take the others with it, and the failure is named per channel', async () => {
  const { impl } = runner({
    'https://www.youtube.com/@a/videos': kilepett,
    'https://www.youtube.com/@b/videos': idotullepes,
    'https://www.youtube.com/@c/videos': sor('NYFGCESmikA', 'NA', 'NA', 'Egy'),
  })
  const r = await fetchYoutube({
    csatornak: ['https://www.youtube.com/@a', 'https://www.youtube.com/@b', 'https://www.youtube.com/@c'],
    napok: 30, ytDlp: '/y', execFileImpl: impl,
  })
  assert.deepEqual(r.jeloltek.map((j) => j.id), ['NYFGCESmikA'], 'the third channel ran')
  assert.deepEqual(r.csatornaHibak, [
    { csatorna: 'https://www.youtube.com/@a', ok: 'csatorna_nem_valaszolt' },
    { csatorna: 'https://www.youtube.com/@b', ok: 'csatorna_idotullepes' },
  ])
})
