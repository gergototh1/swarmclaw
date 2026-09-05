import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { resolvingExecFile } from './binaries.mjs'
import { napOf, sha256 } from './db.mjs'
import { FIZETETT_KODOK, HANG_KITERJESZTES, TtsError, synthesizeRemote } from './soniox.mjs'

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
 *
 * THE TARGET PATH IS ALSO UNTRUSTED, AND IT IS A WRITE. `celFajl` reaches
 * this module from an agent through the MCP shim and from another extension
 * through the narration contract; both are callers this side cannot vouch
 * for, and what the path names is `writeFileSync`. An absolute `.mp3` with no
 * `..` in it is not a safe path: `/Users/…/public/narracio/valami.mp3` passes
 * every one of those tests and is one of the operator's own narrations, made
 * with a balance that is now spent and unrecoverable if it is written over.
 * So two rules stand between the argument and the write, and both are in
 * `celFajlEllenorzes` and `idegenFajlEllenorzes` below:
 *
 *   1. It has to be inside `hangGyoker`, the configured root, checked through
 *      `fs.realpathSync` so a symlink cannot lead out of it (the same shape
 *      `render.mjs` uses for its own namespace in the video module).
 *   2. If a file is already there, some `ext_tts_kerelmek` row has to name it.
 *      A file this extension never made is not this extension's to replace,
 *      whatever the root says.
 *
 * Rule 2 is checked once, before the cache is consulted, because the cache
 * path writes too: a hit copies the stored mp3 to the caller's target, and a
 * hit costs nothing and touches no counter, so a cache-served call was the
 * cheapest way there was to destroy a file.
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
  for (const key of ['endpoint', 'modell', 'hang', 'nyelv', 'hangGyoker']) {
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
  // A root that is present and not an absolute path is refused by name here
  // rather than at the first write: a relative root would be resolved against
  // whatever directory the host happens to run from, which is not a decision
  // this module may make on the operator's behalf.
  const hangGyoker = text('hangGyoker', '')
  if (hangGyoker !== '' && !path.isAbsolute(hangGyoker)) throw new TtsError('tts_beallitas_hibas', 'hangGyoker: abszolút útvonal kell')
  return {
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
    endpoint: text('endpoint', ''),
    hangGyoker,
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

/** The real path of `file`, or null when it is not there or cannot be resolved. */
function valodiUt(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return null
  }
}

/**
 * True when `celFajl` lands under `gyokerValodi` (already a real path), false
 * for anything else.
 *
 * The file itself usually does not exist yet, and neither does its directory,
 * so this cannot simply realpath the target the way `render.mjs`'s
 * `underNamespace` does with files it is about to delete. It resolves the
 * deepest ancestor that DOES exist and appends the rest: a path component
 * that is not on disk cannot be a symlink, so what is resolved is exactly
 * what could bend the path elsewhere. When the target itself exists -- the
 * overwrite case, the dangerous one -- the deepest existing component is the
 * target, so a symlink planted there is followed and judged on where it
 * really points.
 */
function gyokerAlatt(celFajl, gyokerValodi) {
  let letezo = celFajl
  const maradek = []
  for (;;) {
    const real = valodiUt(letezo)
    if (real !== null) return path.resolve(real, ...maradek).startsWith(gyokerValodi + path.sep)
    const szulo = path.dirname(letezo)
    if (szulo === letezo) return false
    maradek.unshift(path.basename(letezo))
    letezo = szulo
  }
}

/**
 * Why a target path is refused, or null. The caller says where the file goes;
 * this only says whether it may. The reason never repeats the path.
 *
 * `gyoker` is the `hangGyoker` setting: the one directory this extension
 * writes into. Without it there is no answer to "may this path be written",
 * so a call with an empty root is refused before it here, under
 * `tts_gyoker_hianyzik`, and this function is never asked.
 */
export function celFajlEllenorzes(celFajl, gyoker) {
  if (typeof celFajl !== 'string' || !path.isAbsolute(celFajl) || !celFajl.endsWith(HANG_KITERJESZTES)) return `abszolút, ${HANG_KITERJESZTES} végű útvonal kell`
  if (celFajl.split(/[\\/]/).some((s) => s === '..')) return 'az útvonalban nem lehet ..'
  if (hasControlCharacter(celFajl)) return 'vezérlőkarakter az útvonalban'
  if (typeof gyoker !== 'string' || gyoker === '' || !path.isAbsolute(gyoker)) return 'a hangGyoker beállítás nincs beállítva'
  const gyokerValodi = valodiUt(gyoker)
  if (gyokerValodi === null) return 'a hangGyoker beállítás könyvtára nem létezik'
  if (!gyokerAlatt(celFajl, gyokerValodi)) return 'az útvonal a hangGyoker beállítás könyvtárán kívülre esik'
  return null
}

/**
 * Why an existing file may not be written over, or null.
 *
 * A path inside the root is not on its own a path this extension may write:
 * the root can hold the operator's own narrations beside this module's, and
 * one call would replace one of them for good. So a file that is already
 * there has to be named by some `ext_tts_kerelmek` row -- finished, failed or
 * lost, any of the three, because all three are rows this extension wrote
 * about a file it made. Nothing else is replaced, and the refusal says so
 * without repeating the path.
 *
 * There is a window between this check and the write in which the file could
 * appear. It is not closed here and cannot be with these primitives; what it
 * costs is one racing write, not a category of destruction.
 */
export function idegenFajlEllenorzes(repo, celFajl) {
  let all
  try {
    all = fs.lstatSync(celFajl)
  } catch {
    // Nothing is there. The write creates the file, and the containment check
    // above already decided the directory it lands in.
    return null
  }
  // `lstat`, not `stat`, so a symlink is seen as a symlink. A link is refused
  // whatever it points at, including a dangling one: `writeFileSync` follows
  // it and creates the file at its destination, which is a path the
  // containment check never saw. This module writes files, not through links.
  if (all.isSymbolicLink()) return 'ezen az útvonalon symlink áll; a modul nem ír linken keresztül'
  // A directory cannot be written over: the write fails with EISDIR and
  // nothing is lost, so it is left to the write path, which reports the errno
  // the operator can act on rather than a refusal about ownership.
  if (all.isDirectory()) return null
  if (repo.fajlIsmert(celFajl)) return null
  return 'ezen az útvonalon már van fájl, és egyetlen kérés-sor sem nevezi meg; ezt a modul nem írja felül'
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

/**
 * Writes a finished row, or answers the row that already holds the key.
 *
 * Two calls for the same sentence can overlap across the network await, and
 * the second `insertKerelem` of a finished row is refused by the partial
 * unique index. The file each call wrote is still its caller's; the row that
 * holds the key is the one to report. Both calls were paid for and both were
 * counted, which is the truth. An insert that fails for any other reason has
 * no winner behind it and is rethrown.
 */
function kerelemVagyGyoztes(repo, key, row) {
  try {
    return repo.insertKerelem(row)
  } catch (err) {
    const winner = repo.cacheHit(key)
    if (!winner) throw err
    return { id: winner.id }
  }
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
     * Order: refuse the settings, refuse the arguments, answer from the cache,
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
     *   the provider answered 2xx and the   the reservation stands as the
     *   audio was unusable, unwritable,     estimate: the money is gone and
     *   unmeasurable, or its body broke     there is nothing better to charge
     *   the call never got a status line:   the reservation is released in
     *   a refusal, a timeout, a broken      full
     *   socket
     *
     * Which failures fall in the middle row is not decided here: `soniox.mjs`
     * decides it, at the only place that can see the status line, and names
     * the set `FIZETETT_KODOK`. This layer adds the two failures of its own
     * that can only happen after a 2xx -- an unwritable file and an
     * unmeasurable one -- and charges them for the same reason.
     */
    async synthesize({ szoveg, celFajl, kerte }) {
      if (typeof kerte !== 'string' || kerte === '') throw new TypeError('synthesize: kerte must name the route')
      const cfg = readSettings(state)
      if (cfg.apiKey === '') throw new TtsError('tts_kulcs_hianyzik', 'az apiKey beállítás üres')
      if (cfg.endpoint === '') throw new TtsError('tts_vegpont_hianyzik', 'az endpoint beállítás üres')
      // The root is read before the path is judged, because without it there
      // is no rule to judge the path by; the two refusals are separate codes
      // so an operator is told to configure a directory rather than to fix a
      // path that is fine.
      if (cfg.hangGyoker === '') throw new TtsError('tts_gyoker_hianyzik', 'a hangGyoker beállítás üres: nincs könyvtár, ahova a modul írhatna')
      const szovegHiba = szovegEllenorzes(szoveg)
      if (szovegHiba) throw new TtsError('tts_szoveg_ervenytelen', szovegHiba)
      const celHiba = celFajlEllenorzes(celFajl, cfg.hangGyoker)
      if (celHiba) throw new TtsError('tts_celfajl_ervenytelen', celHiba)

      const repo = state.repo
      // Before the cache, because the cache writes: a hit copies its mp3 to
      // this target, free of charge and without touching the day's counter.
      const idegenHiba = idegenFajlEllenorzes(repo, celFajl)
      if (idegenHiba) throw new TtsError('tts_celfajl_foglalt', idegenHiba)
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
        // `FIZETETT_KODOK` are the failures the provider answered 2xx to: it
        // accepted the work, and this side could not use or could not finish
        // reading what came back. The money is gone, so the reservation
        // stands as the estimate. Every other failure -- a refusal, a
        // timeout, a socket that broke before a status line -- made no audio
        // and was billed for none, so the room goes back. The list lives in
        // soniox.mjs because that is the only file that sees the status line;
        // no code is classified twice.
        const fizetve = err instanceof TtsError && FIZETETT_KODOK.includes(err.code)
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
        // no file rather than nothing at all.
        //
        // This is the one paid failure that CANNOT be cached, and the
        // difference from the measurement failure below is the bytes: there
        // they are on disk and whole, here there is no file, or a truncated
        // one from a write that stopped halfway. A `kesz` row here would name
        // a file the next call would serve as narration. So the sentence is
        // not cached, and the retry pays again -- which is the true cost of a
        // disk that cannot take the file, not an accounting choice.
        repo.insertKerelem({ ...rowBase, hosszMs: 0, bajt: bytes.length, status: 'hiba', hibaKod: 'tts_fajl_iras_sikertelen' })
        throw new TtsError('tts_fajl_iras_sikertelen', `a fájl nem írható: ${writeFailureReason(err)}`)
      }

      let hosszMs
      try {
        hosszMs = await probeDurationMs(celFajl, resolvingExecFile(state, state.execFileImpl || execFileAsync))
      } catch (err) {
        // The provider answered and was paid, the bytes are on disk and
        // whole, and only the measurement failed -- which on a packaged
        // desktop app is an ordinary event, not an exotic one: `ffprobe` is
        // not on a GUI process's PATH and `ctx.resolveBinary` can still
        // answer null (src/binaries.mjs).
        //
        // The row is `kesz` because the audio IS finished, and that is what
        // makes the sentence cacheable: the cache index is partial on 'kesz',
        // so a `hiba` row here would leave the sentence uncached and every
        // retry would be a fresh paid call producing nothing recoverable,
        // until the daily cap ran out. The length is the one thing not known,
        // so it is stored as 0 -- absent, not guessed -- and `hiba_kod`
        // carries `tts_hossz_meres_sikertelen` on the finished row so the
        // page and the operator can see which rows have no measurement.
        //
        // The call still throws: a caller that asked for a narration must not
        // be handed a length of 0 as though it were measured. It is the retry
        // that is free, not this call that succeeds.
        //
        // The reservation stands as the estimate, as on every other paid
        // failure; releasing it would let a broken ffprobe spend past the cap
        // one call at a time.
        kerelemVagyGyoztes(repo, key, { ...rowBase, hosszMs: 0, bajt: bytes.length, status: 'kesz', hibaKod: 'tts_hossz_meres_sikertelen' })
        throw new TtsError('tts_hossz_meres_sikertelen', err instanceof Error ? err.message : String(err))
      }
      // The measurement replaces the estimate: the day is charged what this
      // call actually made, not what it was guessed to make.
      repo.igazit(nap, hosszMs / 1000 - becsultMp)

      const { id } = kerelemVagyGyoztes(repo, key, { ...rowBase, hosszMs, bajt: bytes.length, status: 'kesz', hibaKod: '' })
      return { kerelemId: id, fajl: celFajl, hosszMs, cache: false, hang: cfg.hang, modell: cfg.modell, nyelv: cfg.nyelv }
    },

    /**
     * The settings and the day's counter, without the key's value. `hang`,
     * `modell` and `nyelv` are here because a consumer that stored a result
     * needs the current voice to know whether it still matches.
     *
     * `hangGyoker` is here so a caller can build a path this module will
     * accept instead of guessing one and being refused: it is the only
     * directory `synthesize` writes into.
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
        // The root is reported by value, not as a boolean: it is the one
        // setting a caller has to know to name a target this module will
        // accept, and it is a directory the operator chose, not a secret.
        hangGyoker: cfg.hangGyoker,
        maiMasodperc: state.repo.maiMasodperc(napOf(new Date().toISOString())),
        napiKeret: cfg.napiKeretMp,
        hang: cfg.hang,
        modell: cfg.modell,
        nyelv: cfg.nyelv,
      }
    },
  }
}
