import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { promisify } from 'node:util'

import { VideoError, readString, refuse } from './args.mjs'

/**
 * The mechanical QA gate: measures a finished mp4 and says whether it may be
 * shown to the operator.
 *
 * It is a program rather than a checklist for a recorded reason. On
 * 2026-08-06 two videos reached approval 36 minutes before their mp4 files
 * were rendered and went out as five-second silent clips; the original's own
 * header says a QA step a human ticks off is a QA step that gets ticked off
 * blind.
 *
 * Rule set 1 is `pipeline/qa_gate.py`'s `inspect()`, unchanged (spec 5.3): the
 * same quantity, the same threshold, the same ffprobe/ffmpeg invocation with
 * the same timeouts, from Node. Every threshold there came from a real
 * failure, so nothing here is tightened, loosened or replaced with a measure
 * that sounds better. In particular Q6 is a STREAM-LENGTH RATIO
 * (`audio_stream_duration / video_duration`) and Q7 is `volumedetect`'s
 * `mean_volume` over the whole track; neither is a per-window average, and
 * there is no `silencedetect`, which measures something stricter and would
 * fail videos the original passed.
 *
 * What the original has and this rule set does not: `composition`. It
 * measures the `_engine` source JSON (scenes, layers and beats per ten
 * seconds), which the kit's scene list does not have, so the rule would
 * measure nothing here; its place in this module is L8 and the reviewer's
 * `tul_keves_tartalom`. The blank-frame rule (a PNG under 12 000 bytes) is
 * NOT in `qa_gate.py` at all; it is a candidate for rule set 2 with its own
 * origin, and lives in `scripts/q9-jelolt.mjs` until it earns its place.
 *
 * Where this port reports differently from the original, and why: the
 * original files an unmeasurable volume (`mean_volume_db` returned None) as a
 * FAILED `audio_not_silent` check, and ignores ffmpeg's exit code. Here a
 * probe that did not run, printed no JSON, or a volumedetect that exited
 * non-zero or printed no `mean_volume` line throws `qa_meres_sikertelen`,
 * because "the file was measured and failed" and "the file could not be
 * measured" are different facts and the db writes a row for only one of them
 * (`ext_video_qa`'s comment in db.mjs). Neither is ever reported as a pass.
 * The measures themselves are the original's.
 *
 * `SZABALYKESZLET` is part of the `ext_video_qa` key together with the
 * file's sha256. Nothing in this file enforces that a rule change bumps it;
 * whoever changes a rule must. Once bumped, the db's UNIQUE key is what makes
 * every old pass fall silent, and a new sha (a re-render) does the same
 * without a bump.
 */
export const SZABALYKESZLET = 1

/**
 * The ids of accepted `szabaly` proposals a released rule set has actually
 * coded. A version of this file that implements one writes its proposal id
 * here; the page reads the list and marks the proposal `kodolva`, which is
 * what takes it off the backlog and out of the cap in `decideProposal`.
 *
 * Empty today, and it means what it says: rule set 1 codes no proposal,
 * because rule set 1 is the port of `qa_gate.py` and predates every
 * proposal. An id here that no rule implements would be the false report
 * this module does not make.
 */
export const KODOLT_JAVASLAT_IDK = Object.freeze([])

/** The `qa_gate.py` constants, by name and value. */
export const KUSZOBOK = Object.freeze({
  MIN_SIZE_BYTES: 100_000,
  MIN_WIDTH: 1080,
  MIN_HEIGHT: 1920,
  MIN_FPS: 24,
  MIN_DURATION: 25,
  MAX_DURATION: 130,
  TARGET_RANGE: Object.freeze([30, 90]),
  AUDIO_COVERAGE: 0.8,
  MAX_MEAN_DB: -50,
})

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 8 * 1024 * 1024
/** The original's `subprocess.run(..., timeout=)` values, in ms. */
const FFPROBE_TIMEOUT_MS = 120_000
const FFMPEG_TIMEOUT_MS = 300_000

/**
 * sha256 of the file's bytes, streamed, so a 40 MB render is not read into
 * memory in one piece. This is the Q8 fingerprint the QA row is keyed on. The
 * original's fingerprint is `size:sha256`; the size is a measurement of its
 * own here (Q1), so the row keeps the sha alone.
 */
export function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
  })
}

/** Python's `a or b or c` over ffprobe fields: the first value that is not None, '' or 0. */
function firstTruthy(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '' && v !== 0 && v !== false) return v
  return undefined
}

/**
 * `float(x or 0.0)` as the original writes it. ffprobe prints durations as
 * decimal strings; a value that is present but not a number is a probe this
 * port cannot read, and `inspect()` would have raised on it too.
 */
function floatOf(what, raw) {
  if (raw === undefined) return 0
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || String(raw).trim() === '') throw new VideoError('qa_meres_sikertelen', `ffprobe: ${what} nem szám`)
  return n
}

/** `_fps()` from the original: `avg_frame_rate` or `r_frame_rate` or `0/1`, `num/den`, 0 on anything unreadable or a zero denominator. */
function fpsOf(stream) {
  const raw = String(firstTruthy(stream.avg_frame_rate, stream.r_frame_rate) ?? '0/1')
  const slash = raw.indexOf('/')
  const num = slash === -1 ? raw : raw.slice(0, slash)
  const den = slash === -1 ? '' : raw.slice(slash + 1)
  const d = den === '' ? 1 : Number(den)
  const n = Number(num)
  if (num.trim() === '' || !Number.isFinite(n) || !Number.isFinite(d)) return 0
  return d !== 0 ? n / d : 0
}

const round = (n, digits) => Number(n.toFixed(digits))

/**
 * Measures one file under rule set 1.
 *
 * `filePath` is required; a path that names no regular file is
 * `qa_fajl_hianyzik`. `execFileImpl` is the runner for `ffprobe` and
 * `ffmpeg`, in the shape of the promisified `execFile`: resolves with
 * `{ stdout, stderr }`, rejects on a non-zero exit. It is injected so the
 * gate can be tested without either binary; absent, the real one runs. The
 * production caller (render.mjs) injects a runner that resolves the tool's
 * name to a path first, which is what finds ffmpeg and ffprobe in the
 * packaged desktop app; a caller that passes nothing gets the bare names and
 * the operating system's own PATH search, as before.
 *
 * Returns `{ ok, meresek, bukasok, figyelmeztetesek, fileSha256, szabalykeszlet }`.
 * `meresek` carries the original's fact names (`size_bytes`, `duration_s`,
 * `width`, `height`, `fps`, `video_codec`, `audio_codec`, `audio_duration_s`,
 * `audio_coverage`, `mean_volume_db`); each entry of `bukasok` names the
 * Q-code, the original check name, what was measured and the threshold it
 * missed. `ok` is true only when `bukasok` is empty, and this function only
 * returns once every rule ran: anything it could not measure is a throw.
 */
export async function runQaGate({ filePath: rawFilePath, execFileImpl: rawExecFileImpl } = {}) {
  const filePath = readString('filePath', rawFilePath, { required: true })
  if (rawExecFileImpl !== undefined && typeof rawExecFileImpl !== 'function') refuse('argumentum_hibas', 'execFileImpl: függvény kell')
  const execFileImpl = rawExecFileImpl === undefined ? execFileAsync : rawExecFileImpl

  // file_exists: the original returns a single failed check; here the absent
  // file is a refusal by name, since a file that is not there was not measured.
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw new VideoError('qa_fajl_hianyzik', `nincs ilyen fájl: ${filePath}`)
  }
  if (!stat.isFile()) throw new VideoError('qa_fajl_hianyzik', `nem reguláris fájl: ${filePath}`)

  const meresek = { file_exists: true, size_bytes: stat.size }
  const bukasok = []
  const figyelmeztetesek = []
  const fail = (kod, nev, mert, kuszob) => bukasok.push({ kod, nev, mert, kuszob })

  // Q1 file_size: size >= MIN_SIZE_BYTES.
  if (stat.size < KUSZOBOK.MIN_SIZE_BYTES) fail('Q1', 'file_size', stat.size, KUSZOBOK.MIN_SIZE_BYTES)

  let probe
  try {
    const { stdout } = await execFileImpl('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', filePath], { maxBuffer: MAX_BUFFER, timeout: FFPROBE_TIMEOUT_MS })
    probe = JSON.parse(String(stdout))
  } catch (err) {
    throw new VideoError('qa_meres_sikertelen', `ffprobe: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof probe !== 'object' || probe === null || Array.isArray(probe)) throw new VideoError('qa_meres_sikertelen', 'ffprobe: a kimenet nem objektum')
  const streams = Array.isArray(probe.streams) ? probe.streams : []
  const format = typeof probe.format === 'object' && probe.format !== null ? probe.format : {}
  const video = streams.find((s) => s && s.codec_type === 'video') || null
  const audio = streams.find((s) => s && s.codec_type === 'audio') || null
  const duration = floatOf('format.duration', firstTruthy(format.duration))
  meresek.duration_s = round(duration, 2)

  // Q2 video_stream, portrait_9_16: a video stream exists; h > w, w >= 1080, h >= 1920.
  // Q3 framerate: avg_frame_rate (or r_frame_rate) >= 24.
  meresek.video_codec = video ? video.codec_name : null
  if (!video) {
    fail('Q2', 'video_stream', null, 'van videó-stream')
  } else {
    const w = Math.trunc(floatOf('width', firstTruthy(video.width)))
    const h = Math.trunc(floatOf('height', firstTruthy(video.height)))
    const fps = fpsOf(video)
    meresek.width = w
    meresek.height = h
    meresek.fps = round(fps, 2)
    if (!(h > w && w >= KUSZOBOK.MIN_WIDTH && h >= KUSZOBOK.MIN_HEIGHT)) fail('Q2', 'portrait_9_16', `${w}x${h}`, `legalább ${KUSZOBOK.MIN_WIDTH}x${KUSZOBOK.MIN_HEIGHT}, álló`)
    if (fps < KUSZOBOK.MIN_FPS) fail('Q3', 'framerate', meresek.fps, KUSZOBOK.MIN_FPS)
  }

  // Q4 duration: 25 <= duration <= 130 from the format; inside that but
  // outside 30..90 passes with a warning, as the original's "[FIGYELEM]" note.
  const inRange = duration >= KUSZOBOK.MIN_DURATION && duration <= KUSZOBOK.MAX_DURATION
  if (!inRange) fail('Q4', 'duration', meresek.duration_s, `${KUSZOBOK.MIN_DURATION}-${KUSZOBOK.MAX_DURATION} s`)
  else if (duration < KUSZOBOK.TARGET_RANGE[0] || duration > KUSZOBOK.TARGET_RANGE[1]) figyelmeztetesek.push('celsavon_kivul')

  // Q5 audio_stream: an audio stream exists. This is the 2026-08-06 failure in
  // one line: without it the mp4 played as a muted animation.
  meresek.audio_codec = audio ? audio.codec_name : null
  if (!audio) {
    fail('Q5', 'audio_stream', null, 'van hang-stream')
  } else {
    // Q6 audio_coverage: the audio stream's own `duration` (or the format's,
    // when the stream carries none) over the format duration, >= 0.80. A
    // stream-length ratio: it does not look at what the track contains.
    const audioDuration = floatOf('audio.duration', firstTruthy(audio.duration, format.duration))
    const coverage = duration ? audioDuration / duration : 0
    meresek.audio_duration_s = round(audioDuration, 2)
    meresek.audio_coverage = round(coverage, 3)
    if (coverage < KUSZOBOK.AUDIO_COVERAGE) fail('Q6', 'audio_coverage', meresek.audio_coverage, KUSZOBOK.AUDIO_COVERAGE)

    // Q7 audio_not_silent: volumedetect's mean_volume over the whole track,
    // strictly above -50 dB and at most 0 dB. A track that is narrated for
    // one second and silent for thirty still averages loud enough to pass;
    // this rule catches a track that is silence with a codec on it, and the
    // original measured no more than that.
    let db
    try {
      const { stderr } = await execFileImpl('ffmpeg', ['-nostats', '-v', 'info', '-i', filePath, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { maxBuffer: MAX_BUFFER, timeout: FFMPEG_TIMEOUT_MS })
      const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(String(stderr))
      if (!m) throw new Error('nincs mean_volume sor a kimenetben')
      db = Number(m[1])
    } catch (err) {
      throw new VideoError('qa_meres_sikertelen', `ffmpeg volumedetect: ${err instanceof Error ? err.message : String(err)}`)
    }
    meresek.mean_volume_db = db
    if (!(db <= 0 && db > KUSZOBOK.MAX_MEAN_DB)) fail('Q7', 'audio_not_silent', db, `${KUSZOBOK.MAX_MEAN_DB} dB fölött és 0 alatt`)
  }

  // Q8: the fingerprint. The file is not locked, so the sha names the bytes
  // on disk when the hash ran, not necessarily the bytes ffprobe read a
  // moment earlier. What binds the two is the caller: the render row already
  // holds the sha `finishRender` recorded, and a QA row is looked up under
  // that sha (`ext_video_qa` in db.mjs), so a file rewritten under a running gate produces a row that
  // matches nothing and gates nothing.
  const sha = await fileSha256(filePath)
  return { ok: bukasok.length === 0, meresek, bukasok, figyelmeztetesek, fileSha256: sha, szabalykeszlet: SZABALYKESZLET }
}
