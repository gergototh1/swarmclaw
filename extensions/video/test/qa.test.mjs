import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { KUSZOBOK, SZABALYKESZLET, fileSha256, runQaGate } from '../src/qa.mjs'

/**
 * The fixtures are rendered here with the machine's ffmpeg, once per run. No
 * ffmpeg is a failure, not a skip: this suite runs on the operator's Mac,
 * where qa_gate.py already depends on it, and a green run that measured
 * nothing is the false report this module exists to prevent.
 *
 * The second half of the suite injects a fake runner instead: it pins the
 * exact ffprobe/ffmpeg argv the port issues and walks the branches a real
 * render would take hours to produce (a landscape file, a 131 s file, a
 * track that covers a quarter of the picture, a probe that prints garbage).
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-qa-'))
function ffmpeg(args, out) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, out], { encoding: 'utf8' })
  if (r.error || r.status !== 0) throw new Error(`ffmpeg kell a QA tesztjeihez (brew install ffmpeg): ${r.error ? r.error.message : r.stderr}`)
  return out
}
const VIDEO = ['-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30']
const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100']
const SILENCE = ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono']
const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
const good = ffmpeg([...VIDEO, ...TONE, '-t', '26', ...X264, '-c:a', 'aac', '-shortest'], path.join(dir, 'good.mp4'))
const noAudio = ffmpeg([...VIDEO, '-t', '26', ...X264], path.join(dir, 'noaudio.mp4'))
const silent = ffmpeg([...VIDEO, ...SILENCE, '-t', '26', ...X264, '-c:a', 'aac', '-shortest'], path.join(dir, 'silent.mp4'))
const tiny = ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30', '-t', '1', ...X264], path.join(dir, 'tiny.mp4'))

const kodok = (r) => r.bukasok.map((b) => b.kod)
const nevek = (r) => r.bukasok.map((b) => b.nev)

test('the thresholds are the qa_gate.py constants', () => {
  assert.deepEqual(KUSZOBOK, { MIN_SIZE_BYTES: 100_000, MIN_WIDTH: 1080, MIN_HEIGHT: 1920, MIN_FPS: 24, MIN_DURATION: 25, MAX_DURATION: 130, TARGET_RANGE: [30, 90], AUDIO_COVERAGE: 0.8, MAX_MEAN_DB: -50 })
  assert.ok(Object.isFrozen(KUSZOBOK) && Object.isFrozen(KUSZOBOK.TARGET_RANGE))
  assert.equal(SZABALYKESZLET, 1)
})

test('a good file passes with the original measurement names, and warns outside the target band', async () => {
  const r = await runQaGate({ filePath: good })
  assert.equal(r.ok, true, JSON.stringify(r.bukasok))
  assert.deepEqual(r.bukasok, [])
  assert.deepEqual(r.figyelmeztetesek, ['celsavon_kivul'])
  assert.deepEqual(Object.keys(r.meresek).sort(), ['audio_codec', 'audio_coverage', 'audio_duration_s', 'duration_s', 'file_exists', 'fps', 'height', 'mean_volume_db', 'size_bytes', 'video_codec', 'width'])
  assert.equal(r.meresek.file_exists, true)
  assert.equal(r.meresek.width, 1080); assert.equal(r.meresek.height, 1920); assert.equal(r.meresek.fps, 30)
  assert.equal(r.meresek.video_codec, 'h264'); assert.equal(r.meresek.audio_codec, 'aac')
  assert.equal(Math.round(r.meresek.duration_s), 26); assert.ok(r.meresek.audio_coverage >= 0.8)
  assert.ok(r.meresek.mean_volume_db > -50 && r.meresek.mean_volume_db <= 0)
  assert.ok(r.meresek.size_bytes >= 100_000)
  assert.equal(r.fileSha256, await fileSha256(good)); assert.equal(r.szabalykeszlet, 1)
})

test('no audio stream is Q5; a silent track is Q7; a tiny file fails Q1, Q4 and Q5', async () => {
  const a = await runQaGate({ filePath: noAudio })
  assert.equal(a.ok, false); assert.deepEqual(kodok(a), ['Q5']); assert.equal(a.bukasok[0].nev, 'audio_stream')
  assert.equal(a.meresek.audio_codec, null); assert.equal('mean_volume_db' in a.meresek, false)
  const s = await runQaGate({ filePath: silent })
  assert.equal(s.ok, false); assert.deepEqual(kodok(s), ['Q7']); assert.equal(s.bukasok[0].nev, 'audio_not_silent'); assert.ok(s.meresek.mean_volume_db < -50)
  const t = await runQaGate({ filePath: tiny })
  assert.equal(t.ok, false); assert.deepEqual(kodok(t), ['Q1', 'Q4', 'Q5']); assert.deepEqual(nevek(t), ['file_size', 'duration', 'audio_stream'])
  assert.deepEqual(t.bukasok[0], { kod: 'Q1', nev: 'file_size', mert: t.meresek.size_bytes, kuszob: 100_000 })
})

test('a changed byte changes the fingerprint; a missing file and a failing probe are named errors', async () => {
  const before = await fileSha256(good)
  const copy = path.join(dir, 'copy.mp4'); fs.copyFileSync(good, copy); fs.appendFileSync(copy, 'x')
  assert.notEqual(await fileSha256(copy), before)
  assert.equal(before, (await runQaGate({ filePath: good })).fileSha256)
  await assert.rejects(runQaGate({ filePath: path.join(dir, 'nincs.mp4') }), (e) => e.code === 'qa_fajl_hianyzik')
  await assert.rejects(runQaGate({ filePath: dir }), (e) => e.code === 'qa_fajl_hianyzik')
  await assert.rejects(runQaGate({ filePath: good, execFileImpl: async () => { throw new Error('boom') } }), (e) => e.code === 'qa_meres_sikertelen' && /boom/.test(e.message))
})

test('an absent filePath and a runner that is not a function are refused by name, not coerced', async () => {
  await assert.rejects(runQaGate(), (e) => e.code === 'argumentum_hibas')
  await assert.rejects(runQaGate({}), (e) => e.code === 'argumentum_hibas')
  await assert.rejects(runQaGate({ filePath: '   ' }), (e) => e.code === 'argumentum_hibas')
  await assert.rejects(runQaGate({ filePath: 42 }), (e) => e.code === 'argumentum_hibas')
  await assert.rejects(runQaGate({ filePath: good, execFileImpl: 'ffprobe' }), (e) => e.code === 'argumentum_hibas')
  await assert.rejects(runQaGate({ filePath: good, execFileImpl: null }), (e) => e.code === 'argumentum_hibas')
})

// --- fake runner: the port's argv and the branches the fixtures cannot reach ---

const VIDEO_STREAM = { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1', r_frame_rate: '30/1' }
const AUDIO_STREAM = { codec_type: 'audio', codec_name: 'aac', duration: '40.000000' }
const probeOf = ({ streams = [VIDEO_STREAM, AUDIO_STREAM], duration = '40.000000' } = {}) => ({ streams, format: { duration } })

/** Answers ffprobe with `probe` and ffmpeg with a volumedetect line, and keeps every call. */
function fakeRunner({ probe = probeOf(), meanDb = -12.3, probeStdout, volumeStderr } = {}) {
  const calls = []
  const impl = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    if (cmd === 'ffprobe') return { stdout: probeStdout !== undefined ? probeStdout : JSON.stringify(probe), stderr: '' }
    if (cmd === 'ffmpeg') return { stdout: '', stderr: volumeStderr !== undefined ? volumeStderr : `[Parsed_volumedetect_0 @ 0x1] n_samples: 1\n[Parsed_volumedetect_0 @ 0x1] mean_volume: ${meanDb} dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -1.0 dB\n` }
    throw new Error(`unexpected command ${cmd}`)
  }
  return { impl, calls }
}
const bigFile = path.join(dir, 'big.bin')
fs.writeFileSync(bigFile, Buffer.alloc(120_000, 7))

test('the port issues the same ffprobe and ffmpeg calls as qa_gate.py, with its timeouts', async () => {
  const { impl, calls } = fakeRunner()
  const r = await runQaGate({ filePath: bigFile, execFileImpl: impl })
  assert.equal(r.ok, true, JSON.stringify(r.bukasok))
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
    ['ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', bigFile]],
    ['ffmpeg', ['-nostats', '-v', 'info', '-i', bigFile, '-af', 'volumedetect', '-vn', '-f', 'null', '-']],
  ])
  assert.equal(calls[0].opts.timeout, 120_000); assert.equal(calls[1].opts.timeout, 300_000)
  assert.deepEqual(r.meresek, { file_exists: true, size_bytes: 120_000, duration_s: 40, video_codec: 'h264', width: 1080, height: 1920, fps: 30, audio_codec: 'aac', audio_duration_s: 40, audio_coverage: 1, mean_volume_db: -12.3 })
  assert.deepEqual(r.figyelmeztetesek, [])
})

test('Q2 names video_stream when there is none and portrait_9_16 when the frame is landscape or small', async () => {
  const none = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [AUDIO_STREAM] }) }).impl })
  assert.deepEqual(none.bukasok.map((b) => [b.kod, b.nev]), [['Q2', 'video_stream']])
  assert.equal(none.meresek.video_codec, null); assert.equal('width' in none.meresek, false)
  const landscape = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [{ ...VIDEO_STREAM, width: 1920, height: 1080 }, AUDIO_STREAM] }) }).impl })
  assert.deepEqual(landscape.bukasok, [{ kod: 'Q2', nev: 'portrait_9_16', mert: '1920x1080', kuszob: 'legalább 1080x1920, álló' }])
  const small = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [{ ...VIDEO_STREAM, width: 720, height: 1280 }, AUDIO_STREAM] }) }).impl })
  assert.deepEqual(kodok(small), ['Q2']); assert.equal(small.bukasok[0].mert, '720x1280')
})

test('Q3 reads avg_frame_rate first, falls back to r_frame_rate, and treats an unreadable rate as 0', async () => {
  const slow = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [{ ...VIDEO_STREAM, avg_frame_rate: '23976/1000' }, AUDIO_STREAM] }) }).impl })
  assert.deepEqual(slow.bukasok, [{ kod: 'Q3', nev: 'framerate', mert: 23.98, kuszob: 24 }])
  const fallback = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [{ ...VIDEO_STREAM, avg_frame_rate: '', r_frame_rate: '25' }, AUDIO_STREAM] }) }).impl })
  assert.equal(fallback.ok, true); assert.equal(fallback.meresek.fps, 25)
  const zeroDen = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [{ ...VIDEO_STREAM, avg_frame_rate: '0/0' }, AUDIO_STREAM] }) }).impl })
  assert.deepEqual(kodok(zeroDen), ['Q3']); assert.equal(zeroDen.meresek.fps, 0)
  const junk = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [{ ...VIDEO_STREAM, avg_frame_rate: 'x/y' }, AUDIO_STREAM] }) }).impl })
  assert.deepEqual(kodok(junk), ['Q3']); assert.equal(junk.meresek.fps, 0)
})

test('Q4 is 25 to 130 s inclusive; inside it, outside 30 to 90 s is a warning and not a failure', async () => {
  const at = (duration) => runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ duration, streams: [VIDEO_STREAM, { ...AUDIO_STREAM, duration }] }) }).impl })
  assert.deepEqual((await at('131.000000')).bukasok, [{ kod: 'Q4', nev: 'duration', mert: 131, kuszob: '25-130 s' }])
  assert.deepEqual(kodok(await at('24.990000')), ['Q4'])
  const floor = await at('25.000000'); assert.equal(floor.ok, true); assert.deepEqual(floor.figyelmeztetesek, ['celsavon_kivul'])
  const ceiling = await at('130.000000'); assert.equal(ceiling.ok, true); assert.deepEqual(ceiling.figyelmeztetesek, ['celsavon_kivul'])
  const target = await at('90.000000'); assert.equal(target.ok, true); assert.deepEqual(target.figyelmeztetesek, [])
  const missing = await at(null); assert.deepEqual(kodok(missing), ['Q4', 'Q6']); assert.equal(missing.meresek.duration_s, 0); assert.equal(missing.meresek.audio_coverage, 0)
})

test('Q6 is the audio stream length over the video length, from the stream field or the format field', async () => {
  const quarter = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [VIDEO_STREAM, { ...AUDIO_STREAM, duration: '10.000000' }] }) }).impl })
  assert.deepEqual(quarter.bukasok, [{ kod: 'Q6', nev: 'audio_coverage', mert: 0.25, kuszob: 0.8 }])
  assert.equal(quarter.meresek.audio_duration_s, 10)
  const noField = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [VIDEO_STREAM, { codec_type: 'audio', codec_name: 'aac' }] }) }).impl })
  assert.equal(noField.ok, true); assert.equal(noField.meresek.audio_coverage, 1)
  const edge = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: probeOf({ streams: [VIDEO_STREAM, { ...AUDIO_STREAM, duration: '32.000000' }] }) }).impl })
  assert.equal(edge.ok, true); assert.equal(edge.meresek.audio_coverage, 0.8)
})

test('Q7 needs mean_volume strictly above -50 dB and at most 0 dB', async () => {
  const at = (meanDb) => runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ meanDb }).impl })
  assert.deepEqual((await at(-50)).bukasok, [{ kod: 'Q7', nev: 'audio_not_silent', mert: -50, kuszob: '-50 dB fölött és 0 alatt' }])
  assert.deepEqual(kodok(await at(-91)), ['Q7'])
  assert.deepEqual(kodok(await at(1.5)), ['Q7'])
  assert.equal((await at(0)).ok, true)
  assert.equal((await at(-49.9)).ok, true)
})

test('a probe that is not JSON, a probe with no streams and a volumedetect with no mean_volume are measurement failures, not verdicts', async () => {
  await assert.rejects(runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probeStdout: 'not json' }).impl }), (e) => e.code === 'qa_meres_sikertelen' && /ffprobe/.test(e.message))
  await assert.rejects(runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probeStdout: '[]' }).impl }), (e) => e.code === 'qa_meres_sikertelen')
  await assert.rejects(runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ volumeStderr: 'size=N/A time=00:00:40.00\n' }).impl }), (e) => e.code === 'qa_meres_sikertelen' && /mean_volume/.test(e.message))
  const noStreams = await runQaGate({ filePath: bigFile, execFileImpl: fakeRunner({ probe: { format: { duration: '40' } } }).impl })
  assert.deepEqual(kodok(noStreams), ['Q2', 'Q5'])
})

test('ffmpeg exiting non-zero is a measurement failure even when a mean_volume line was printed', async () => {
  const impl = async (cmd, args) => {
    if (cmd === 'ffprobe') return { stdout: JSON.stringify(probeOf()), stderr: '' }
    const err = Object.assign(new Error(`Command failed: ffmpeg ${args.join(' ')}`), { code: 1, stderr: 'mean_volume: -12.0 dB\nError while decoding' })
    throw err
  }
  await assert.rejects(runQaGate({ filePath: bigFile, execFileImpl: impl }), (e) => e.code === 'qa_meres_sikertelen' && /volumedetect/.test(e.message))
})
