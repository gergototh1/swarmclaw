import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { napOf, sha256 } from './db.mjs'
import { HANG_KITERJESZTES, TtsError, synthesizeRemote } from './soniox.mjs'

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
 * It is the spec's estimate, not a measurement. Every call is charged this
 * estimate before the request goes out, because the cap has to be defended
 * against a call that is still in flight; the charge is then corrected to the
 * measured length, released in full when the call turned out to cost nothing,
 * or left standing as the estimate when the provider was paid and no
 * measurement could be taken. `synthesize` says which case is which.
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

/**
 * Why the file could not be written, in words an operator can act on. The
 * errno code carries the whole of it -- ENOSPC, EACCES, EROFS, ENOTDIR,
 * EISDIR -- and the message Node builds around it repeats the path, which
 * this layer does not quote (see `celFajlEllenorzes`).
 */
function writeFailureReason(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string') return err.code
  return err instanceof Error && err.name ? err.name : 'ismeretlen ok'
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
  if (typeof celFajl !== 'string' || !path.isAbsolute(celFajl) || !celFajl.endsWith(HANG_KITERJESZTES)) return `abszolút, ${HANG_KITERJESZTES} végű útvonal kell`
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
     * *reserve* the estimate against the cap, call, write, measure, correct
     * the reservation, record. The reservation comes after the cache because
     * a cached sentence costs nothing; the provider is called only after
     * every refusal that needs no network.
     *
     * WHY THE ROOM IS TAKEN BEFORE THE CALL AND NOT COUNTED AFTER IT. The cap
     * exists to bound what the operator pays in a day, and the provider is
     * paid while the call is in flight. A cap that is read before the request
     * and written after it is no cap under concurrency: two calls that both
     * read an empty counter both see room, and the day ends over budget by
     * the whole of the second call. So `repo.foglal` takes the estimate out
     * of the day's room in one step before the request goes out, and what
     * happens to that reservation afterwards is decided by whether the money
     * was spent:
     *
     *   the call was answered and measured  the reservation is corrected to
     *                                       the measured length, up or down
     *   the provider answered 2xx but the   the reservation stands as the
     *   audio was unusable, unwritable or   estimate: the money is gone and
     *   unmeasurable                        there is nothing better to charge
     *   the call cost nothing: a refusal,   the reservation is released in
     *   a timeout, a broken socket          full
     *
     * The middle row is the one that used to differ between paths: a failed
     * measurement was charged and an unparseable 2xx was not, though both had
     * been paid for. They are charged alike now, and the estimate is the
     * charge because no measurement exists on either.
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
      const foglalas = repo.foglal(nap, becsultMp, cfg.napiKeretMp)
      if (!foglalas.ok) {
        throw new TtsError(
          'tts_keret_kimerult',
          `ma ${Math.round(foglalas.mai)} mp készült vagy van úton, a keret ${cfg.napiKeretMp} mp, ez a kérés becsülve ~${Math.ceil(becsultMp)} mp`,
          { maiMasodperc: foglalas.mai, napiKeret: cfg.napiKeretMp },
        )
      }
      // From here on the day's counter holds `becsultMp` for this call, and
      // every exit below either releases it, corrects it, or says why it
      // stands. There is no path out of this method that leaves it unaddressed.

      const rowBase = { szolgaltato: SZOLGALTATO, modell: cfg.modell, hang: cfg.hang, nyelv: cfg.nyelv, szoveg, fajl: celFajl, kerte }
      let bytes
      try {
        bytes = await synthesizeRemote({
          endpoint: cfg.endpoint, apiKey: cfg.apiKey, modell: cfg.modell, hang: cfg.hang, nyelv: cfg.nyelv, szoveg,
          fetchImpl: state.fetchImpl || fetch,
        })
      } catch (err) {
        // `tts_valasz_ertelmezhetetlen` is the one failure here that the
        // provider answered 2xx to: it accepted the work and this side could
        // not use what came back. The money is gone, so the reservation
        // stands as the estimate. Every other failure -- a refusal, a
        // timeout, a broken socket -- made no audio and was billed for none,
        // so the room goes back.
        const fizetve = err instanceof TtsError && err.code === 'tts_valasz_ertelmezhetetlen'
        if (!fizetve) repo.igazit(nap, -becsultMp)
        // A failed call is a row with its code and no seconds. The index is
        // partial on 'kesz', so this row does not hold the cache key.
        if (err instanceof TtsError) repo.insertKerelem({ ...rowBase, hosszMs: 0, bajt: 0, status: 'hiba', hibaKod: err.code })
        throw err
      }

      try {
        fs.mkdirSync(path.dirname(celFajl), { recursive: true })
        fs.writeFileSync(celFajl, bytes)
      } catch (err) {
        // A full disk, a read-only mount, a directory where the file should
        // go: the audio was bought and cannot be delivered. The reservation
        // stands for the same reason it does on a failed measurement, and the
        // row records the code so the operator sees a paid call that produced
        // no file rather than nothing at all. No finished row is written, so
        // the sentence is not cached to a file that is not there.
        repo.insertKerelem({ ...rowBase, hosszMs: 0, bajt: bytes.length, status: 'hiba', hibaKod: 'tts_fajl_iras_sikertelen' })
        throw new TtsError('tts_fajl_iras_sikertelen', `a fájl nem írható: ${writeFailureReason(err)}`)
      }

      let hosszMs
      try {
        hosszMs = await probeDurationMs(celFajl, state.execFileImpl || execFileAsync)
      } catch (err) {
        // The provider answered and was paid, and the measurement failed.
        // Releasing the reservation would let a broken ffprobe spend past the
        // cap one call at a time, so the estimate stands in place of the
        // measurement and the row says so through its code. The file stays
        // where the caller asked for it, but no finished row claims it, so
        // the next call for this sentence makes it again rather than trusting
        // an unmeasured file.
        repo.insertKerelem({ ...rowBase, hosszMs: 0, bajt: bytes.length, status: 'hiba', hibaKod: 'tts_hossz_meres_sikertelen' })
        throw new TtsError('tts_hossz_meres_sikertelen', err instanceof Error ? err.message : String(err))
      }
      // The measurement replaces the estimate: the day is charged what this
      // call actually made, not what it was guessed to make.
      repo.igazit(nap, hosszMs / 1000 - becsultMp)

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
     *
     * `maiMasodperc` is what the day is committed to, not only what it has
     * finished: a call still waiting on the provider holds its estimate in
     * this number. That is what makes it useful for seeing a refusal coming,
     * and it means the figure can fall when a call fails and gives its
     * reservation back.
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
