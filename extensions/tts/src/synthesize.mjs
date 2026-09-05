import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { napOf, sha256 } from './db.mjs'
import { TtsError, synthesizeRemote } from './soniox.mjs'

/**
 * The synthesis path: settings, cache, daily cap, the provider call, the file,
 * the measurement, the row. Every caller in this extension -- the narration
 * contract for other extensions and the rpc behind the MCP shim -- goes
 * through `createSynthesizer`, so the key, the cache and the counter live in
 * exactly one place and no second route can spend around them.
 *
 * The text is untrusted content written by strangers. Here it is hashed for
 * the cache key, stored raw in its own column for the page to render as text,
 * and handed to `synthesizeRemote` for the request body. It never becomes a
 * file name (the caller names the file, and this layer only checks the name),
 * never enters an error message, and is never logged.
 */

const execFileAsync = promisify(execFile)

export const SZOLGALTATO = 'soniox'
export const DEFAULTS = Object.freeze({ modell: 'tts-rt-v1', hang: 'Kenji', nyelv: 'hu', napiKeretMp: 900 })
/** Longer than any narration sentence the video module sends; a paragraph is refused, not split. */
export const MAX_SZOVEG = 2000
/**
 * The pre-call budget estimate for Hungarian speech, characters per second.
 * It is the spec's estimate, not a measurement: it decides whether a call may
 * go out under the cap, and it stands in for a measurement on the one path
 * where the audio arrived and could not be measured. The counter itself is
 * otherwise fed by ffprobe.
 */
export const BECSULT_KARAKTER_PER_MP = 14
/**
 * How long ffprobe may take on one file. It reads the container header of a
 * local file and answers in milliseconds; this bound is there so a wedged
 * binary cannot hang the call after the provider has already been paid.
 */
export const PROBE_TIMEOUT_MS = 15_000

/**
 * Settings, read by the rule the whole platform uses: a blank field is the
 * default, a present value that cannot be honoured is refused by name. The
 * host writes each field's `defaultValue` once for a never-configured
 * install, but a field the operator clears stores '' and the host default
 * never fires again, which is why '' is the default here too.
 *
 * The secret is returned to the caller inside this module and never leaves
 * it in a return value or a log.
 */
export function readSettings(state) {
  const s = state.settings() || {}
  const text = (key, fallback) => (typeof s[key] === 'string' && s[key].trim() !== '' ? s[key].trim() : fallback)
  for (const key of ['endpoint', 'modell', 'hang', 'nyelv']) {
    if (s[key] !== undefined && s[key] !== null && typeof s[key] !== 'string') {
      throw new TtsError('tts_beallitas_hibas', `${key}: szöveg kell`)
    }
  }
  let napiKeretMp = DEFAULTS.napiKeretMp
  if (s.napiKeretMp !== undefined && s.napiKeretMp !== null && s.napiKeretMp !== '') {
    const n = typeof s.napiKeretMp === 'number' || typeof s.napiKeretMp === 'string' ? Number(s.napiKeretMp) : NaN
    if (!Number.isFinite(n) || n <= 0) throw new TtsError('tts_beallitas_hibas', 'napiKeretMp: pozitív szám kell')
    napiKeretMp = n
  }
  return {
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
    endpoint: text('endpoint', ''),
    modell: text('modell', DEFAULTS.modell),
    hang: text('hang', DEFAULTS.hang),
    nyelv: text('nyelv', DEFAULTS.nyelv),
    napiKeretMp,
  }
}

/**
 * Duration in ms from ffprobe; throws on anything but a positive number.
 *
 * `execFileImpl` defaults to the module's own promisified `execFile`, with
 * the timeout in the options so a wedged ffprobe is killed rather than
 * waited for. A double ignores the options and answers what the test says.
 * The file path is the caller's own, already checked by
 * `celFajlEllenorzes`; it is passed as an argument vector, never through a
 * shell.
 */
export async function probeDurationMs(file, execFileImpl = execFileAsync) {
  let stdout
  try {
    ({ stdout } = await execFileImpl(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    ))
  } catch (err) {
    throw new Error(probeFailureReason(err))
  }
  const seconds = Number(String(stdout).trim())
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe nem adott pozitív hosszt')
  return Math.round(seconds * 1000)
}

/** Why ffprobe failed, in words an operator can act on, without its stderr. */
function probeFailureReason(err) {
  const e = err && typeof err === 'object' ? err : {}
  if (e.code === 'ENOENT') return 'az ffprobe nincs telepítve vagy nincs a PATH-on'
  if (e.killed === true || e.signal === 'SIGTERM') return `az ffprobe nem végzett ${PROBE_TIMEOUT_MS} ms alatt`
  if (typeof e.code === 'number') return `az ffprobe ${e.code} kóddal lépett ki`
  return err instanceof Error ? err.message : String(err)
}

/**
 * Why a target path is refused, or null. The caller says where the file goes;
 * this only says whether it may. The reason never repeats the path.
 */
export function celFajlEllenorzes(celFajl) {
  if (typeof celFajl !== 'string' || !path.isAbsolute(celFajl) || !celFajl.endsWith('.mp3')) return 'abszolút, .mp3 végű útvonal kell'
  if (celFajl.split(/[\\/]/).some((s) => s === '..')) return 'az útvonalban nem lehet ..'
  if (hasControlCharacter(celFajl)) return 'vezérlőkarakter az útvonalban'
  return null
}

/** Any C0 control (NUL, newline, tab, escape and the rest) or DEL. */
function hasControlCharacter(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Whether the text may be synthesised, or why not. The reason never repeats
 * the text. Exported for the cache import on the rpc, which admits a sentence
 * under the same rule a call would, so an imported row is one a call could
 * hit.
 */
export function szovegEllenorzes(szoveg) {
  if (typeof szoveg !== 'string') return 'a szöveg sztring kell legyen'
  if (szoveg.trim() === '') return 'a szöveg üres'
  if (szoveg.length > MAX_SZOVEG) return `a szöveg ${szoveg.length} karakter, a felső határ ${MAX_SZOVEG}`
  return null
}

export function createSynthesizer(state) {
  return {
    /**
     * One sentence to one mp3 at `celFajl`. Returns
     * `{ kerelemId, fajl, hosszMs, cache, hang, modell, nyelv }` or throws a
     * `TtsError`. `hang`, `modell` and `nyelv` are the settings this result
     * was made with, the three the cache key is made of, so a consumer can
     * tell later whether the voice has changed under it.
     *
     * Order: refuse the arguments, refuse the settings, answer from the cache,
     * refuse on the cap, call, write, measure, count, record. The cap is
     * checked after the cache because a cached sentence costs nothing; the
     * provider is called only after every refusal that needs no network.
     */
    async synthesize({ szoveg, celFajl, kerte }) {
      const szovegHiba = szovegEllenorzes(szoveg)
      if (szovegHiba) throw new TtsError('tts_szoveg_ervenytelen', szovegHiba)
      const celHiba = celFajlEllenorzes(celFajl)
      if (celHiba) throw new TtsError('tts_celfajl_ervenytelen', celHiba)
      if (typeof kerte !== 'string' || kerte === '') throw new TypeError('synthesize: kerte must name the route')
      const cfg = readSettings(state)
      if (cfg.apiKey === '') throw new TtsError('tts_kulcs_hianyzik', 'az apiKey beállítás üres')
      if (cfg.endpoint === '') throw new TtsError('tts_vegpont_hianyzik', 'az endpoint beállítás üres')

      const repo = state.repo
      const key = { szolgaltato: SZOLGALTATO, modell: cfg.modell, hang: cfg.hang, nyelv: cfg.nyelv, szovegHash: sha256(szoveg) }
      const hit = repo.cacheHit(key)
      if (hit) {
        if (fs.existsSync(hit.fajl)) {
          if (hit.fajl !== celFajl) {
            fs.mkdirSync(path.dirname(celFajl), { recursive: true })
            fs.copyFileSync(hit.fajl, celFajl)
          }
          return { kerelemId: hit.id, fajl: celFajl, hosszMs: hit.hossz_ms, cache: true, hang: cfg.hang, modell: cfg.modell, nyelv: cfg.nyelv }
        }
        // The row said the file exists and it does not: release the key so
        // this call, not a later one, makes the sentence again.
        repo.markLost(hit.id)
      }

      const nap = napOf(new Date().toISOString())
      const becsultMp = szoveg.length / BECSULT_KARAKTER_PER_MP
      const mai = repo.maiMasodperc(nap)
      if (mai + becsultMp > cfg.napiKeretMp) {
        throw new TtsError(
          'tts_keret_kimerult',
          `ma ${Math.round(mai)} mp készült, a keret ${cfg.napiKeretMp} mp, ez a kérés becsülve ~${Math.ceil(becsultMp)} mp`,
          { maiMasodperc: mai, napiKeret: cfg.napiKeretMp },
        )
      }

      const rowBase = { szolgaltato: SZOLGALTATO, modell: cfg.modell, hang: cfg.hang, nyelv: cfg.nyelv, szoveg, fajl: celFajl, kerte }
      let bytes
      try {
        bytes = await synthesizeRemote({
          endpoint: cfg.endpoint, apiKey: cfg.apiKey, modell: cfg.modell, hang: cfg.hang, nyelv: cfg.nyelv, szoveg,
          fetchImpl: state.fetchImpl || fetch,
        })
      } catch (err) {
        // A failed call is a row with its code and no seconds: the counter is
        // for audio that was made, and a refusal, a timeout or a broken
        // socket made none. The index is partial on 'kesz', so this row does
        // not hold the cache key.
        if (err instanceof TtsError) repo.insertKerelem({ ...rowBase, hosszMs: 0, bajt: 0, status: 'hiba', hibaKod: err.code })
        throw err
      }

      fs.mkdirSync(path.dirname(celFajl), { recursive: true })
      fs.writeFileSync(celFajl, bytes)

      let hosszMs
      try {
        hosszMs = await probeDurationMs(celFajl, state.execFileImpl || execFileAsync)
      } catch (err) {
        // The provider answered and was paid, and the measurement failed. Not
        // counting it would let a broken ffprobe spend past the cap one call
        // at a time, so the estimate is charged in place of the measurement;
        // that is the one path where the counter holds an estimate, and the
        // row says so through its code. The file stays where the caller
        // asked for it, but no finished row claims it, so the next call for
        // this sentence makes it again rather than trusting an unmeasured
        // file.
        repo.addMasodperc(nap, becsultMp)
        repo.insertKerelem({ ...rowBase, hosszMs: 0, bajt: bytes.length, status: 'hiba', hibaKod: 'tts_hossz_meres_sikertelen' })
        throw new TtsError('tts_hossz_meres_sikertelen', err instanceof Error ? err.message : String(err))
      }
      repo.addMasodperc(nap, hosszMs / 1000)

      let id
      try {
        id = repo.insertKerelem({ ...rowBase, hosszMs, bajt: bytes.length, status: 'kesz', hibaKod: '' }).id
      } catch (err) {
        // Two calls for the same sentence overlapped across the network await
        // and the other one finished first: the index refused this row. The
        // file written above is still the caller's; the row that holds the key
        // is the one to report. Both calls were paid for and both were
        // counted, which is the truth.
        const winner = repo.cacheHit(key)
        if (!winner) throw err
        id = winner.id
      }
      return { kerelemId: id, fajl: celFajl, hosszMs, cache: false, hang: cfg.hang, modell: cfg.modell, nyelv: cfg.nyelv }
    },

    /**
     * The settings and the day's counter, without the key's value. `hang`,
     * `modell` and `nyelv` are here because a consumer that stored a result
     * needs the current voice to know whether it still matches.
     */
    status() {
      const cfg = readSettings(state)
      return {
        kulcsBeallitva: cfg.apiKey !== '',
        vegpontBeallitva: cfg.endpoint !== '',
        maiMasodperc: state.repo.maiMasodperc(napOf(new Date().toISOString())),
        napiKeret: cfg.napiKeretMp,
        hang: cfg.hang,
        modell: cfg.modell,
        nyelv: cfg.nyelv,
      }
    },
  }
}
