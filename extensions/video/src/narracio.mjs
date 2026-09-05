import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { guard, readString, refuse } from './args.mjs'
import { resolvingExecFile } from './binaries.mjs'
import { sha256 } from './db.mjs'
import { fedettseg, idovonal } from './idozites.mjs'
import { remotionDirOf } from './katalogus.mjs'

/**
 * `videoNarrate`: the approved plan's sentences, one mp3 each, through the
 * tts extension's `narration` contract (spec 4.4), and the N-rules (5.2) on
 * this module's own measurement of what came back.
 *
 * WHOSE FILES. `public/narracio/` in the Remotion project is the operator's:
 * it holds the hand-made videos' narrations, and those cannot be made again
 * (the provider balance that made them is gone). This module asks the tts
 * for files under one namespace beneath it, NARRACIO_NEVTER, and nothing
 * else; the path it asks for is built from a video id, a plan hash and a
 * scene index, all of them this module's own hex and integers, never from a
 * sentence. It writes no file itself and deletes none: the tts writes the
 * mp3 at the path it was given, and what this module keeps is the row. A
 * later task that removes narrations works from those rows, not from a
 * listing of the directory, for the reason above.
 *
 * THE OTHER SIDE OF THAT DISCIPLINE IS A SETTING, NOT A PROMISE THIS MODULE
 * CAN KEEP. The path below is only what this module ASKS for; the tts is
 * what writes. Its `hangGyoker` setting is the one directory it will write
 * into, checked through realpath, and it refuses to replace a file no
 * request row of its own names. Set it to the Remotion project's
 * `public/narracio/swarmclaw` -- this module's namespace, the deepest
 * directory that still covers every path built here. Set to
 * `public/narracio` instead, the containment stops covering the operator's
 * own 150-odd mp3s one directory up, and only the tts's second rule stands
 * between them and a synthesis call. The tts reports the configured root on
 * its `status()` as `hangGyoker`, so what it will accept can be read rather
 * than assumed.
 *
 * WHAT IS MEASURED, AND BY WHOM. The tts answers with its own `hosszMs`, and
 * this module does not store it: the length on the row comes from this
 * module's ffprobe of the file that is actually on disk (`state.probeImpl`
 * seam, `probeDurationMs` in production). The N-rules and, later, the
 * scene bounds of the render stand on that measurement, so a tts row that
 * drifted from its file, or a cache hit copied over a changed file, cannot
 * put a length on the timeline that the audio does not have.
 *
 * WHAT A REFUSAL SAYS. The tts has a closed set of error codes, and each one
 * is a different fact: `tts_egyenleg_kimerult` is the provider refusing for
 * lack of balance, `tts_keret_kimerult` is this installation's own daily cap,
 * `tts_halozat` and `tts_idotullepes` are a call that could not be made,
 * `tts_valasz_ertelmezhetetlen` is an answer that carried no audio. The
 * host wraps the throw as `provider_threw` with the original on `cause`;
 * this module reads the code off the cause and reports it word for word as
 * `ttsKod`, with the scene it happened on, under one refusal code of its own
 * (`tts_visszautasitva`). The balance case is the one the operator hits
 * first and it must arrive named, not as "the tts failed".
 *
 * WHAT A REFUSAL LEAVES. Nothing in the table. A set is written whole or
 * not at all (`replaceNarraciok`), so a scene that failed after four that
 * succeeded leaves the four mp3s on disk and in the tts cache, and no row;
 * the next call tries the fifth again. The same holds for the N-rules: a set
 * under N2 or outside N3 is refused after every file was made.
 *
 * What the retry PAYS for the four is not this module's guarantee to make.
 * The tts answers a repeated sentence from its cache only while the mp3 the
 * cache row names is still on disk: `synthesize` checks it with
 * `fs.existsSync`, and on a miss it calls `markLost` and synthesises the
 * sentence again, for money (extensions/tts/src/synthesize.mjs). Those are
 * the same files `cleanupAll` here deletes -- every path a narration row
 * names, whatever the video's state -- so a Tisztítás between two runs turns
 * the free retry into a paid one. That breadth is the spec's 11.3 uninstall
 * path and it stays; what does not stay is a comment promising a free retry
 * behind a condition it does not check. The rerun this module CAN promise
 * costs nothing is the one below: an unchanged, complete, current set is not
 * re-narrated at all.
 *
 * THE VOICE FINGERPRINT. The tts cache key is (szolgaltato, modell, hang,
 * nyelv, szoveg_hash), and its answer carries `hang`, `modell` and `nyelv`.
 * All three go on the row, and `hangEgyezik` compares all three: a
 * comparison on two of them would call a language change "nothing changed",
 * which is the false report this module forbids (db.mjs, ext_video_narraciok).
 */

/** public/-relative root of every mp3 this module asks for; nothing else under public/narracio/ is this module's. */
export const NARRACIO_NEVTER = 'narracio/swarmclaw'
/** N2: narrated ms over the visible ms of the whole timeline, at least this. */
export const N2_MIN_FEDETTSEG = 0.8
/** N3: the whole timeline in seconds, inside this window (the Q4 window, brought forward like L7). */
export const N3_MIN_MP = 25
export const N3_MAX_MP = 130
/**
 * How long ffprobe may take on one file. It reads a local file's container
 * header and answers in milliseconds; the bound is there so a wedged binary
 * cannot hang the tool after the tts has already been paid.
 */
export const PROBE_TIMEOUT_MS = 15_000
/**
 * The three fields the tts cache key is made of, as they cross the contract
 * and as they sit on the narration row. `hangEgyezik` compares exactly these.
 */
export const HANG_MEZOK = Object.freeze(['hang', 'modell', 'nyelv'])

const execFileAsync = promisify(execFile)

/**
 * Duration in ms from ffprobe; throws on anything but a positive number.
 *
 * The file path is one this module built (see NARRACIO_NEVTER) and it goes
 * to ffprobe as an argument vector, never through a shell. The error
 * carries why ffprobe failed in words an operator can act on, and not its
 * stderr: the tool's message is what the agent reads next.
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
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('az ffprobe nem adott pozitív hosszt')
  return Math.round(seconds * 1000)
}

function probeFailureReason(err) {
  const e = err && typeof err === 'object' ? err : {}
  if (e.code === 'ENOENT') return 'az ffprobe nincs telepítve vagy nincs a PATH-on'
  if (e.killed === true || e.signal === 'SIGTERM') return `az ffprobe nem végzett ${PROBE_TIMEOUT_MS} ms alatt`
  if (typeof e.code === 'number') return `az ffprobe ${e.code} kóddal lépett ki`
  return err instanceof Error ? err.message : String(err)
}

/**
 * The tts contract, or a refusal carrying the host's reason word for word:
 * `provider_missing`, `provider_disabled` and `version_mismatch` are three
 * different things for the operator to do (spec 4.4). `why` is null when
 * the host answered null for it, so none of the three is claimed when none
 * was observed.
 */
export function ttsHandle(state) {
  const handle = state.contracts.get('tts', 'narration')
  if (!handle) {
    const why = state.contracts.why('tts', 'narration')
    refuse('tts_szerzodes_hianyzik', 'a tts.narration szerződés nem oldható fel', { why: typeof why === 'string' ? why : null })
  }
  return handle
}

/**
 * The plan's sentences in scene order, each with its hash. `videoDraft`
 * admitted the plan only with exactly one sentence per scene, 0..n-1
 * (katalogus.mjs, validateDraft), so the list is dense once sorted.
 */
export function narracioSorok(terv) {
  return JSON.parse(terv.narracio)
    .slice()
    .sort((a, b) => a.jelenet - b.jelenet)
    .map((n) => ({ jelenet: n.jelenet, szoveg: n.szoveg, szovegHash: sha256(n.szoveg) }))
}

/**
 * Whether a stored narration row was made with the voice the tts would use
 * now: all three of HANG_MEZOK equal, as strings. This is the render gate's
 * comparison (`narracio_hang_valtozott`); it lives here, beside the writer,
 * so the fields written and the fields compared are one list. A row from
 * before migration v2 has `nyelv` '' and never matches, which is the safe
 * direction (db.mjs, ext_video_narraciok).
 */
export function hangEgyezik(sor, jelenlegi) {
  return HANG_MEZOK.every((mezo) => typeof sor[mezo] === 'string' && sor[mezo] !== '' && sor[mezo] === jelenlegi[mezo])
}

/** The tts's own code off a `provider_threw` contract error, or null when the provider threw something uncoded. */
function ttsKodOf(err) {
  return err instanceof Error && err.code === 'provider_threw' && err.cause instanceof Error && typeof err.cause.code === 'string' && err.cause.code !== ''
    ? err.cause.code
    : null
}

/** The two counter fields a `tts_keret_kimerult` carries, when it carries them; they say when a retry may pass. */
function keretMezok(cause) {
  const out = {}
  for (const mezo of ['maiMasodperc', 'napiKeret']) if (typeof cause[mezo] === 'number') out[mezo] = cause[mezo]
  return out
}

/**
 * The plan's narration set as it stands on disk, in scene order, when every
 * part of it is already current -- otherwise null. This is the check that
 * makes `videoNarrate` cross the tts contract only when the narration hash
 * changed (spec 10, point 8): with a full, current, voice-matching set there
 * is nothing to synthesise, and asking anyway spends the operator's balance
 * on files it already has.
 *
 * It asks exactly what the render gate asks, field for field (render.mjs,
 * `start`, step 3): a row per sentence and no more, the plan's current hash,
 * the sentence's current hash, the mp3 present under public/, and all three
 * voice fields equal to the tts's current setting. Anything laxer would skip
 * a call the render then demands by name (`narracio_hianyos`,
 * `narracio_hang_valtozott`); anything stricter would pay for a file that is
 * already right.
 *
 * `jelenlegiHang` is the tts's `status()`, which synthesises nothing and
 * costs nothing. A null one means "not current": re-narrating is the safe
 * direction, and a tts that cannot say which voice it is set to cannot vouch
 * for the voice its old files were made in.
 */
export function naprakeszNarracio({ rows, sorok, tervHash, publicDir, jelenlegiHang }) {
  if (!jelenlegiHang || sorok.length === 0 || rows.length !== sorok.length) return null
  const jelenetenkent = new Map(rows.map((r) => [r.jelenet, r]))
  const rendezett = []
  for (const sor of sorok) {
    const n = jelenetenkent.get(sor.jelenet)
    if (!n || n.terv_hash !== tervHash || n.szoveg_hash !== sor.szovegHash) return null
    if (!fs.existsSync(path.join(publicDir, n.fajl))) return null
    if (!hangEgyezik(n, jelenlegiHang)) return null
    rendezett.push(n)
  }
  return rendezett
}

export function createNarrateTool(state) {
  return {
    name: 'videoNarrate',
    description: 'Jelenetenkénti narrációt kér a tts extensiontől a legfrissebb, átment tervhez, ffprobe-bal méri a hosszakat, és ha a fedettség és a teljes hossz megfelel (N1–N3), a készletet a tervre írja és a videó narralt lesz. Ha a tervhez már megvan a teljes, aktuális, a mostani hanggal készült narráció, egyetlen tts-hívás sem megy ki (valtozatlan: true). Bukásnál nem ír sort; a már elkészült mp3-ak a lemezen maradnak, és amíg ott vannak, az újrahívás a tts cache-éből szolgál ki.',
    parameters: { type: 'object', required: ['tervId'], properties: { tervId: { type: 'string' } } },
    execute(args) {
      return guard(async () => {
        const repo = state.repo
        const tervId = readString('tervId', args.tervId, { required: true, max: 64 })
        const terv = repo.terv(tervId)
        if (!terv) refuse('terv_ismeretlen', 'nincs terv a megadott tervId-vel')
        const video = repo.video(terv.video_id)
        if (video && video.status === 'lezart') refuse('video_lezart', 'a videó le van zárva')
        const latest = repo.latestTerv(terv.video_id)
        if (latest.id !== terv.id) refuse('terv_elavult', `a(z) ${terv.verzio}. verzió nem a legfrissebb; a legfrissebb a v${latest.verzio}`, { legfrissebbTervId: latest.id })
        if (!repo.passingVerdikt(terv.id, terv.terv_hash)) refuse('verdikt_hianyzik', 'ehhez a tervhez nincs atmegy verdikt a jelenlegi hash-sel')
        // A render on this video reads the narration rows at its start and
        // writes the video's status at its end; a set replaced under it and a
        // `narralt` written over `renderel` would both be overwritten by the
        // render's close. Same rule as videoDraft and videoVerdict.
        const futo = repo.runningRender()
        if (futo && futo.video_id === terv.video_id) refuse('render_folyamatban', 'ezen a videón render fut; várd meg a végét', { renderId: futo.id })
        const remotionDir = remotionDirOf(state)
        const publicDir = path.join(remotionDir, 'public')
        const tts = ttsHandle(state)
        // video_id is this module's hex id and terv_hash its sha256: nothing
        // a stranger wrote is in this path, and the scene index is an integer.
        const celDir = path.join(publicDir, NARRACIO_NEVTER, terv.video_id, terv.terv_hash)
        // The probe runs ffprobe by name; resolving it first is what makes it
        // findable in the packaged desktop app (src/binaries.mjs). A test's
        // `probeImpl` takes the file alone and ignores the runner, as before.
        const probe = state.probeImpl || ((file) => probeDurationMs(file, resolvingExecFile(state, state.execFileImpl || execFileAsync)))
        const sorok = narracioSorok(terv)
        // A tts `status()` that throws is not this tool's refusal to make: the
        // same tts is about to refuse the synthesize call with its own code,
        // and that code is the sentence the operator needs. An unreadable
        // status only means the set cannot be called current.
        let jelenlegiHang = null
        try {
          jelenlegiHang = await tts.status()
        } catch {
          jelenlegiHang = null
        }
        const naprakesz = naprakeszNarracio({ rows: repo.narraciok(terv.id), sorok, tervHash: terv.terv_hash, publicDir, jelenlegiHang })
        if (naprakesz !== null) {
          // Nothing was asked of the tts and nothing is written -- not even
          // the video's status: a call that changed nothing must not move a
          // video that has since been rendered back to `narralt`. `cache` is
          // absent from the scenes for the same reason. A cache hit is
          // something the tts reports about a call, and no call was made; a
          // `cache: true` here would be this module inventing an answer. The
          // N-rules are not re-run either: they were measured on these exact
          // lengths when the set was written, and nothing since has changed.
          const megvanHosszak = naprakesz.map((n) => n.hossz_ms)
          const megvanIv = idovonal(megvanHosszak)
          return {
            valtozatlan: true,
            jelenetek: naprakesz.map((n) => ({ jelenet: n.jelenet, fajl: n.fajl, hosszMs: n.hossz_ms })),
            osszHosszMs: megvanHosszak.reduce((sum, x) => sum + x, 0),
            teljesMs: megvanIv.teljesMs,
            fedettseg: Number(fedettseg(megvanHosszak).toFixed(3)),
            hang: { hang: naprakesz[0].hang, modell: naprakesz[0].modell, nyelv: naprakesz[0].nyelv },
          }
        }
        const eredmeny = []
        for (const sor of sorok) {
          const celFajl = path.join(celDir, `${sor.jelenet}.mp3`)
          let valasz
          try {
            valasz = await tts.synthesize({ szoveg: sor.szoveg, celFajl })
          } catch (err) {
            const kod = ttsKodOf(err)
            // An uncoded throw is not a tts refusal and is not dressed as one;
            // guard names it szerzodes_hiba with the provider's message. The
            // cause's message is quoted because it is the tts's own, and the
            // tts's TtsError never carries the sentence, the key or the
            // endpoint (extensions/tts/src/soniox.mjs); the sentence this
            // module sent is in no message of its own either.
            if (!kod) throw err
            refuse('tts_visszautasitva', `jelenet ${sor.jelenet}: ${kod}: ${err.cause.message}`, { ttsKod: kod, jelenet: sor.jelenet, ...keretMezok(err.cause) })
          }
          // The answer's shape is checked field by field, not trusted for
          // having arrived: a voice triple with a field missing would be
          // stored as a fingerprint the render gate compares two thirds of.
          const alak = valasz !== null && typeof valasz === 'object' && typeof valasz.fajl === 'string'
            && HANG_MEZOK.every((mezo) => typeof valasz[mezo] === 'string' && valasz[mezo] !== '')
          if (!alak) refuse('tts_valasz_hibas', `jelenet ${sor.jelenet}: a tts válaszából hiányzik a fajl, hang, modell vagy nyelv mező`, { jelenet: sor.jelenet })
          const relativ = path.relative(publicDir, valasz.fajl).split(path.sep).join('/')
          if (relativ !== `${NARRACIO_NEVTER}/${terv.video_id}/${terv.terv_hash}/${sor.jelenet}.mp3`) {
            refuse('tts_valasz_hibas', `jelenet ${sor.jelenet}: a tts nem a kért fájlt nevezte meg a válaszban`, { jelenet: sor.jelenet })
          }
          // "It answered" and "the file is there" are two facts; a probe on a
          // missing file would report a measurement failure that never ran.
          if (!fs.existsSync(valasz.fajl)) refuse('tts_valasz_hibas', `jelenet ${sor.jelenet}: a tts által megnevezett fájl nincs a lemezen`, { jelenet: sor.jelenet })
          let hosszMs
          try {
            hosszMs = await probe(valasz.fajl)
          } catch (err) {
            refuse('narracio_meres_sikertelen', `jelenet ${sor.jelenet}: ${err instanceof Error ? err.message : String(err)}`, { jelenet: sor.jelenet })
          }
          if (!Number.isFinite(hosszMs) || hosszMs <= 0) refuse('narracio_meres_sikertelen', `jelenet ${sor.jelenet}: a mért hossz nem pozitív szám`, { jelenet: sor.jelenet })
          eredmeny.push({
            jelenet: sor.jelenet, fajl: relativ, hosszMs, cache: valasz.cache === true,
            hang: valasz.hang, modell: valasz.modell, nyelv: valasz.nyelv,
            ttsKeresId: typeof valasz.kerelemId === 'string' ? valasz.kerelemId : '', szovegHash: sor.szovegHash,
          })
        }
        const hosszak = eredmeny.map((e) => e.hosszMs)
        const fed = fedettseg(hosszak)
        const iv = idovonal(hosszak)
        const teljesMp = iv.teljesMs / 1000
        if (fed < N2_MIN_FEDETTSEG) {
          refuse('fedettseg_alacsony', `a narrált hossz a látható hossz ${Math.round(fed * 100)}%-a; legalább ${N2_MIN_FEDETTSEG * 100}% kell`, { fedettseg: Number(fed.toFixed(3)), teljesMs: iv.teljesMs })
        }
        if (teljesMp < N3_MIN_MP || teljesMp > N3_MAX_MP) {
          refuse('hossz_tartomanyon_kivul', `a teljes látható hossz ${teljesMp.toFixed(1)} s; ${N3_MIN_MP} és ${N3_MAX_MP} s között kell`, { teljesMp: Number(teljesMp.toFixed(1)), teljesMs: iv.teljesMs })
        }
        repo.replaceNarraciok(terv.id, eredmeny.map((e) => ({
          tervHash: terv.terv_hash, jelenet: e.jelenet, szovegHash: e.szovegHash,
          hang: e.hang, modell: e.modell, nyelv: e.nyelv, fajl: e.fajl, hosszMs: e.hosszMs, ttsKeresId: e.ttsKeresId,
        })))
        repo.setVideoStatus(terv.video_id, 'narralt')
        return {
          valtozatlan: false,
          jelenetek: eredmeny.map((e) => ({ jelenet: e.jelenet, fajl: e.fajl, hosszMs: e.hosszMs, cache: e.cache })),
          osszHosszMs: hosszak.reduce((s, x) => s + x, 0),
          teljesMs: iv.teljesMs,
          fedettseg: Number(fed.toFixed(3)),
          hang: { hang: eredmeny[0].hang, modell: eredmeny[0].modell, nyelv: eredmeny[0].nyelv },
        }
      })
    },
  }
}
