import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { guard, readString, refuse } from './args.mjs'
import { resolvingExecFile, resolvingSpawn } from './binaries.mjs'
import { uid } from './db.mjs'
import { idovonal } from './idozites.mjs'
import { assetUtvonal } from './kit-tabla.mjs'
import { readCatalog, remotionDirOf } from './katalogus.mjs'
import { hangEgyezik, narracioSorok, ttsHandle } from './narracio.mjs'
import { SZABALYKESZLET, fileSha256, runQaGate } from './qa.mjs'

const execFileAsync = promisify(execFile)

export const OUT_NEVTER = 'out/swarmclaw'
export const NARRACIO_PUBLIC_NEVTER = 'public/narracio/swarmclaw'
export const DEFAULT_RENDER_MAX_PERC = 40
export const DEFAULT_MEGTARTOTT = 3
export const KOTELEZO_FAJLOK = Object.freeze(['package.json', 'src/index.ts', 'src/FosVideo.tsx', 'src/kit/katalogus.generated.json'])
/** Each tool with the argument that makes it exit 0 and print a version; the order is the order of refusal. */
export const ESZKOZ_PROBA = Object.freeze({ ffmpeg: ['-version'], ffprobe: ['-version'], npx: ['--version'] })
/** How far two boot timestamps may differ and still be the same boot (spec 3.4 step 1). */
const BOOT_TURES_S = 5
const SIGKILL_UTAN_MS = 10_000
const BROWSER_ENSURE_TIMEOUT_MS = 10 * 60_000

/** The machine's boot time in seconds, from uptime; the same rule on every host and on every call. */
export function hostBootAtNow() {
  return Math.round((Date.now() - os.uptime() * 1000) / 1000)
}

function wholeSetting(state, key, fallback, min) {
  const raw = (state.settings() || {})[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min) refuse('beallitas_hibas', `${key}: egész szám kell, legalább ${min}`)
  return n
}

export function createRenderOps(state) {
  const repo = () => state.repo
  // Both runners resolve the tool's name to a path before spawning it, and put
  // that path's own directory on the child's PATH so a script tool finds the
  // interpreter it was installed beside -- `npx` is `#!/usr/bin/env node`. That
  // is what makes `npx`, `ffmpeg` and `ffprobe` work in the packaged desktop
  // app, where the inherited PATH holds neither Homebrew, nor nvm, nor a
  // user-level ~/.local/bin install (src/binaries.mjs). The wrapping is here
  // rather than at each call site so the QA gate, which is handed
  // `execFileImpl()`, resolves by the same rule as the preflight.
  const spawnImpl = () => resolvingSpawn(state, state.spawnImpl || spawn)
  const execFileImpl = () => resolvingExecFile(state, state.execFileImpl || execFileAsync)
  const killImpl = () => state.killImpl || ((pid, signal) => process.kill(pid, signal))
  const platform = () => state.platform || process.platform
  const bootAt = () => (state.bootAt ? state.bootAt() : hostBootAtNow())
  const nowMs = () => (state.now ? state.now() : Date.now())
  const renderMaxPerc = () => wholeSetting(state, 'renderMaxPerc', DEFAULT_RENDER_MAX_PERC, 1)
  const megtartott = () => wholeSetting(state, 'megtartottRenderek', DEFAULT_MEGTARTOTT, 1)
  const linuxEngedely = () => (state.settings() || {}).linuxRenderEngedely === true

  /**
   * Signal 0 to the process GROUP: true when any process in it exists. A
   * null pid (spawn failed before the pid was stored) is dead by definition.
   * EPERM means a live group this user may not signal; it is reported alive
   * and left alone.
   */
  function groupAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      killImpl()(-pid, 0)
      return true
    } catch (err) {
      return Boolean(err) && err.code === 'EPERM'
    }
  }

  /**
   * SIGTERM to the group now, SIGKILL ten seconds later, and a sentence
   * saying what those calls ACTUALLY did. The caller writes that sentence
   * onto the render row, so a row never asserts a signal the kernel refused:
   * an orphaned Chrome Headless Shell under a row that says it was killed is
   * the process-tree failure the spec's 11.3 calls unrecoverable, and the
   * only thing worse than it is not knowing it happened.
   *
   * A throwing SIGTERM is not one fact but three, and only one of them means
   * the process is gone. ESRCH is the group already exited: nothing is left
   * to kill and no SIGKILL is scheduled. EPERM is a LIVE group this user may
   * not signal -- `groupAlive` reads it exactly that way -- and a SIGKILL
   * would be refused for the same reason, so none is scheduled and the
   * sentence says the process may still be running. Anything else is
   * reported with its own code or message.
   *
   * The SIGKILL timer is unref'd. That is deliberate (a held-open timer would
   * outlive a module reload and hold the host's exit), and it means a host
   * that quits inside those ten seconds never sends the second signal. So the
   * sentence promises it only "if the host is still running": the row may not
   * claim a signal whose delivery depends on the host outliving a timer that
   * cannot keep it alive.
   */
  function killGroup(pid) {
    try {
      killImpl()(-pid, 'SIGTERM')
    } catch (err) {
      const kod = err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : ''
      if (kod === 'ESRCH') return { kiment: false, szoveg: 'a SIGTERM ESRCH-t adott: a csoport addigra elment, jel nem ment ki' }
      if (kod === 'EPERM') return { kiment: false, szoveg: 'a SIGTERM-et EPERM utasította el: a csoport él, de ez a felhasználó nem jelezheti; SIGKILL sem ment ki, a folyamat futhat tovább' }
      let miert = kod
      if (miert === '') miert = err instanceof Error ? err.message : String(err)
      return { kiment: false, szoveg: `a SIGTERM nem ment ki (${miert}); SIGKILL sem, a folyamat futhat tovább` }
    }
    const timer = setTimeout(() => {
      try {
        killImpl()(-pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }, SIGKILL_UTAN_MS)
    timer.unref()
    return { kiment: true, szoveg: `a csoport SIGTERM-et kapott; ${SIGKILL_UTAN_MS / 1000} másodperc múlva SIGKILL következik, ha a host addig még fut` }
  }

  /** Writes the video's status only while this render's plan is still the latest: a newer plan owns the status. */
  function videoStatusAfterRender(render, status) {
    const latest = repo().latestTerv(render.video_id)
    if (latest && latest.id === render.terv_id) repo().setVideoStatus(render.video_id, status)
  }

  /**
   * Closes a finished render from its file: sha256 onto the row, the QA gate,
   * the video's status.
   *
   * `megjegyzes` is how this row came to be closed, when that is not "the
   * process exited and we saw it". `closeDead` closes a render whose process
   * nobody watched end, and a `kesz` row with an empty `hiba_kod` reads as a
   * clean render -- a partial mp4 from a killed process would then read as
   * "rendered, then failed QA", which is a different and more flattering
   * story than the truth. The note is carried into whichever sentence this
   * path writes, so it survives a QA that could not measure the file too.
   */
  async function closeWithFile(render, megjegyzes = null) {
    const sha = await fileSha256(render.out_path)
    if (!repo().finishRender(render.id, { status: 'kesz', fileSha256: sha })) return
    const jegyzettel = (szoveg) => (megjegyzes === null ? szoveg : `${megjegyzes}; ${szoveg}`)
    let qa
    try {
      qa = await runQaGate({ filePath: render.out_path, execFileImpl: execFileImpl() })
    } catch (err) {
      repo().setRenderHiba(render.id, 'qa_meres_sikertelen', jegyzettel(err instanceof Error ? err.message : String(err)))
      videoStatusAfterRender(render, 'qa_meretlen')
      return
    }
    // `sha` names the bytes the row closed on; `qa.fileSha256` names the bytes
    // the gate measured. The file is not locked, so these are two reads of one
    // path and can differ. When they do, the measurement is a measurement of
    // something the row does not name: the QA row would sit under a
    // fingerprint `qaFor(id, file_sha256, keszlet)` never asks for, and the
    // video would still be told `qa_ok` -- a pass on a file whose sha is not
    // the row's, which is the one shape this gate exists to forbid. An
    // unmeasurable render and a badly finished one are different facts, so it
    // is recorded as the former.
    if (qa.fileSha256 !== sha) {
      repo().setRenderHiba(render.id, 'qa_meres_sikertelen', jegyzettel('a fájl a lezárás és a mérés között megváltozott; a mérés nem a soron álló sha256-ra vonatkozik'))
      videoStatusAfterRender(render, 'qa_meretlen')
      return
    }
    // `insertQa` writes ON CONFLICT DO NOTHING on (render_id, file_sha256,
    // szabalykeszlet) and answers with the row that STANDS for that key --
    // the earlier measurement when this fingerprint was measured before. The
    // video follows that row and not this run's `qa.ok`, because taking the
    // fresh boolean would set `qa_ok` while the row every later `qaFor` reads
    // says ok = 0: the video's status and the QA row would be two answers to
    // one question, and the row is the one the gate consults.
    const allo = repo().insertQa({ renderId: render.id, fileSha256: qa.fileSha256, szabalykeszlet: SZABALYKESZLET, ok: qa.ok, meresek: { ...qa.meresek, figyelmeztetesek: qa.figyelmeztetesek }, bukasok: qa.bukasok })
    if (allo === null) {
      // The write went through and the key does not read back: the gate has
      // no row, so the video has no pass. Not a measurement failure of the
      // file, but it is the same fact for the operator -- nothing measured.
      repo().setRenderHiba(render.id, 'qa_meres_sikertelen', jegyzettel('a QA sor a beírás után nem olvasható vissza a saját kulcsán'))
      videoStatusAfterRender(render, 'qa_meretlen')
      return
    }
    if (megjegyzes !== null) repo().setRenderHiba(render.id, 'render_folyamat_eltunt', megjegyzes)
    videoStatusAfterRender(render, allo.ok === 1 ? 'qa_ok' : 'qa_hiba')
  }

  /** Closes a running render as a failure; false when the row was no longer running, so the caller does not write onto a row somebody else closed. */
  function closeWithError(render, kod, szoveg) {
    if (!repo().finishRender(render.id, { status: 'hiba', hibaKod: kod, hibaSzoveg: szoveg })) return false
    videoStatusAfterRender(render, 'render_hiba')
    return true
  }

  /**
   * The exit handler's body and the status call's closer. It starts from the
   * row, never from memory, and `finishRender`'s WHERE status = 'fut' is what
   * makes a second call -- from an old module instance's closure, from a
   * status call racing the exit event -- a no-op. Correct from a module
   * instance the host has since reloaded, because it does only these
   * idempotent writes through the same host storage.
   */
  async function finalize(renderId, { code, signal }) {
    const render = repo().render(renderId)
    if (!render || render.status !== 'fut') return
    const fileExists = render.out_path !== null && fs.existsSync(render.out_path)
    if (code === 0 && fileExists) return closeWithFile(render)
    if (code === 0) return closeWithError(render, 'render_kimenet_hianyzik', 'a folyamat 0-val lépett ki, de a kimeneti fájl nincs meg')
    if (code === null) return closeWithError(render, 'render_megszakadt', `a folyamat jellel állt le: ${String(signal)}; napló: ${render.log_path}`)
    return closeWithError(render, 'render_kilepesi_kod', `kilépési kód ${code}; napló: ${render.log_path}`)
  }

  /**
   * Spec 3.4 steps 1-2: a render whose process is gone is closed from the
   * disk, and no signal is sent. `miert` goes onto the row in every branch,
   * the branch that finds the file included: how a render ended is a fact
   * about the file that came out of it.
   */
  async function closeDead(render, miert) {
    if (render.out_path !== null && fs.existsSync(render.out_path)) return closeWithFile(render, miert)
    const dir = render.out_path === null ? null : path.dirname(render.out_path)
    if (dir === null || !fs.existsSync(dir)) return closeWithError(render, 'render_kimenet_hianyzik', `${miert}; a kimeneti könyvtár sincs meg (kézzel törölve?)`)
    return closeWithError(render, 'render_megszakadt', `${miert}; a könyvtár megvan, a fájl nincs; napló: ${render.log_path}`)
  }

  /**
   * Spec 11.2's second `render_kimenet_hianyzik` case: a `kesz` row whose
   * file LATER disappeared. The first case (a `fut` row whose output
   * directory the operator removed) is `closeDead`'s; this one has no process
   * left to watch, so the only moment it can be noticed is a read, and
   * `videoRenderStatus` is the read the spec names. Without it the answer is
   * a path, a sha256 and a QA pass for a file that is not there, which is the
   * producer handing the operator a video that does not exist.
   *
   * Only an outside deletion is reported. The module's own sweeps go through
   * `markRenderDeleted`, which nulls all three paths and stamps `torolve_at`,
   * so a row this module emptied names no file and is skipped here.
   *
   * The QA row is left standing. It is a true measurement of bytes that
   * existed, and hiding it would replace one false report with another; what
   * changes is that the answer no longer offers the path under `hiba: null`
   * as if the operator could open it. An earlier code is kept inside the
   * text, because `qa_meres_sikertelen` ("the gate never ran") and this one
   * ("the file is gone") are two facts and the column holds one code. No QA
   * is run here: the spec is explicit that a missing file is not a
   * measurement failure.
   */
  function noteMissingOutput(render) {
    if (render === null || render.status !== 'kesz' || render.out_path === null || render.torolve_at !== null) return
    if (render.hiba_kod === 'render_kimenet_hianyzik' || fs.existsSync(render.out_path)) return
    const elozo = render.hiba_kod === '' ? '' : `${render.hiba_kod}: ${render.hiba_szoveg}; `
    repo().setRenderHiba(render.id, 'render_kimenet_hianyzik', `${elozo}a lezáráskor mért fájl azóta eltűnt a lemezről: ${render.out_path}`)
  }

  function summary(render) {
    const qa = render.file_sha256 ? repo().qaFor(render.id, render.file_sha256, SZABALYKESZLET) : null
    const started = Date.parse(render.started_at)
    return {
      renderId: render.id,
      videoId: render.video_id,
      status: render.status,
      outPath: render.out_path,
      logPath: render.log_path,
      fileSha256: render.file_sha256,
      qa: qa ? { ok: qa.ok === 1, meresek: JSON.parse(qa.meresek), bukasok: JSON.parse(qa.bukasok) } : null,
      hiba: render.hiba_kod ? { kod: render.hiba_kod, szoveg: render.hiba_szoveg } : null,
      elteltMs: render.finished_at ? Date.parse(render.finished_at) - started : nowMs() - started,
      hostUjraindult: render.status === 'fut' && Math.abs(render.host_boot_at - bootAt()) > BOOT_TURES_S,
      startedAt: render.started_at,
      finishedAt: render.finished_at,
    }
  }

  async function status(renderId) {
    const render = repo().render(renderId)
    if (!render) refuse('render_ismeretlen', `nincs render ezzel az id-vel: ${renderId}`)
    if (render.status === 'fut') {
      if (Math.abs(render.host_boot_at - bootAt()) > BOOT_TURES_S) {
        await closeDead(render, 'a gép a render indítása óta újraindult; a pid egy másik folyamaté lehet, jel nem ment ki')
      } else if (!groupAlive(render.pid)) {
        await closeDead(render, 'a folyamatcsoport nem él')
      } else if (nowMs() - Date.parse(render.started_at) > renderMaxPerc() * 60_000) {
        // The signals are made first and the row says what they returned; the
        // sentence is never written ahead of the calls it describes.
        const jel = killGroup(render.pid)
        closeWithError(render, 'render_idotullepes', `${renderMaxPerc()} percnél régebb óta fut; ${jel.szoveg}`)
      }
    }
    noteMissingOutput(repo().render(renderId))
    return summary(repo().render(renderId))
  }

  function cancel(renderId) {
    const render = repo().render(renderId)
    if (!render) refuse('render_ismeretlen', `nincs render ezzel az id-vel: ${renderId}`)
    if (render.status !== 'fut') refuse('render_nem_fut', `a render státusza ${render.status}`)
    // The row closes first so the exit event that follows the kill finds
    // nothing to do; what the signals returned is written onto it afterwards,
    // because until they are made there is nothing true to write.
    const zart = closeWithError(render, 'render_megszakitva', 'az operátor leállította a lapról')
    const jel = groupAlive(render.pid) ? killGroup(render.pid) : { kiment: false, szoveg: 'a folyamatcsoport addigra nem élt, jel nem ment ki' }
    if (zart) repo().setRenderHiba(render.id, 'render_megszakitva', `az operátor leállította a lapról; ${jel.szoveg}`)
    return summary(repo().render(renderId))
  }

  async function toolPresent(name, args) {
    try {
      await execFileImpl()(name, args)
      return true
    } catch {
      return false
    }
  }

  async function start(tervId) {
    const terv = repo().terv(tervId)
    if (!terv) refuse('terv_ismeretlen', `nincs terv ezzel az id-vel: ${tervId}`)
    // A closed video is closed for the render too, and the refusal is the one
    // videoNarrate, videoDraft and videoVerdict already make. Without it this
    // render's close would call `videoStatusAfterRender`, and `setVideoStatus`
    // would write `qa_ok` over `lezart` -- a closed video reopened by a run
    // nobody was allowed to start. Nothing calls `lezarVideo` yet; the guard
    // is here because the write that would follow it is already here.
    const video = repo().video(terv.video_id)
    if (video && video.status === 'lezart') refuse('video_lezart', 'a videó le van zárva')
    const latest = repo().latestTerv(terv.video_id)
    if (latest.id !== terv.id) refuse('terv_elavult', `a(z) ${terv.verzio}. verzió nem a legfrissebb`, { legfrissebbTervId: latest.id })
    // 1. a passing verdict on this id AND this hash -- passingVerdikt itself
    // answers from the LATEST verdict on the pair, so a pass a reviewer has
    // since reversed with a later fail is never returned here (db.mjs).
    const verdikt = repo().passingVerdikt(terv.id, terv.terv_hash)
    if (!verdikt) {
      const masHash = repo().verdiktek(terv.id).some((v) => v.verdikt === 'atmegy')
      refuse(masHash ? 'verdikt_elavult' : 'verdikt_hianyzik', masHash ? 'van atmegy verdikt erre a tervre, de más hash-sel; a lektornak újra kell néznie' : 'erre a tervre nincs atmegy verdikt')
    }
    const remotionDir = remotionDirOf(state)
    // 2. the referenced files are what the reviewer saw
    const valtozott = []
    for (const a of JSON.parse(terv.asset_ujjlenyomatok)) {
      const r = assetUtvonal(remotionDir, a.utvonal)
      if (r.code || r.sha256 !== a.sha256) valtozott.push(a.utvonal)
    }
    if (valtozott.length > 0) refuse('asset_valtozott', `a beadás óta megváltozott vagy eltűnt: ${valtozott.join(', ')}`, { valtozott })
    // 3. a narration row per scene for the current sentence, the file present, in the tts's current voice
    const tts = ttsHandle(state)
    const ttsStatus = await tts.status()
    const sorok = narracioSorok(terv)
    const narraciok = new Map(repo().narraciok(terv.id).map((n) => [n.jelenet, n]))
    const hianyos = []
    const hangValtozott = []
    for (const sor of sorok) {
      const n = narraciok.get(sor.jelenet)
      if (!n || n.terv_hash !== terv.terv_hash || n.szoveg_hash !== sor.szovegHash || !fs.existsSync(path.join(remotionDir, 'public', n.fajl))) {
        hianyos.push(sor.jelenet)
        continue
      }
      // hangEgyezik compares all three of the tts cache key's voice fields
      // (hang, modell, nyelv); comparing only two by hand would let a
      // language change under an unchanged voice name pass as unchanged.
      if (!ttsStatus || !hangEgyezik(n, ttsStatus)) hangValtozott.push(sor.jelenet)
    }
    if (hianyos.length > 0) refuse('narracio_hianyos', `nincs a jelenlegi szöveghez narráció (vagy a fájl hiányzik): jelenetek ${hianyos.join(', ')}; futtasd a videoNarrate-et`, { jelenetek: hianyos })
    if (hangValtozott.length > 0) refuse('narracio_hang_valtozott', `a tts hangja, modellje vagy nyelve más, mint amivel a narráció készült: jelenetek ${hangValtozott.join(', ')}; futtasd újra a videoNarrate-et`, { jelenetek: hangValtozott })
    // 4. one render at a time (the index is the barrier; this is the named refusal before it)
    const running = repo().runningRender()
    if (running) refuse('render_folyamatban', `már fut egy render: ${running.id}`, { renderId: running.id })
    // 5. platform
    if (platform() !== 'darwin' && !linuxEngedely()) {
      refuse('render_host_platform', `a host ${platform()}; a render macOS-en fut, mert a tipográfia rendszerbetű; a linuxRenderEngedely beállítás kapcsolja`)
    }
    // 6. files, tools, browser
    for (const f of KOTELEZO_FAJLOK) if (!fs.existsSync(path.join(remotionDir, f))) refuse('remotion_dir_hianyzik', `hiányzik a projektből: ${f}`, { hianyzik: f })
    for (const [eszkoz, args] of Object.entries(ESZKOZ_PROBA)) if (!(await toolPresent(eszkoz, args))) refuse('render_eszkoz_hianyzik', `${eszkoz} nincs a PATH-on`, { eszkoz })
    try {
      await execFileImpl()('npx', ['remotion', 'browser', 'ensure'], { cwd: remotionDir, timeout: BROWSER_ENSURE_TIMEOUT_MS })
    } catch (err) {
      refuse('chrome_hianyzik', `npx remotion browser ensure nem futott le: ${err instanceof Error ? err.message : String(err)}`)
    }
    // 7. old renders of this video beyond the cap
    takarit(terv.video_id)
    // 8. the props and the row
    const katalogus = readCatalog(remotionDir)
    const figyelmeztetesek = katalogus.katalogusHash === terv.katalogus_hash ? [] : ['katalogus_valtozott']
    const hosszak = sorok.map((sor) => narraciok.get(sor.jelenet).hossz_ms)
    const iv = idovonal(hosszak)
    const lista = JSON.parse(terv.jelenetek).map((j, i) => ({ ...j, hang: narraciok.get(i).fajl, lathatoHossz: iv.elemek[i].lathato }))
    const renderId = uid()
    const dir = path.join(remotionDir, OUT_NEVTER, terv.video_id, renderId)
    const propsPath = path.join(dir, 'props.json')
    const outPath = path.join(dir, 'video.mp4')
    const logPath = path.join(dir, 'render.log')
    const claim = repo().claimRender({ id: renderId, videoId: terv.video_id, tervId: terv.id, tervHash: terv.terv_hash, verdiktId: verdikt.id, hostBootAt: bootAt(), jelenetHatarok: iv.elemek, propsPath, outPath, logPath, platform: platform() })
    if (claim.error) refuse('render_folyamatban', `már fut egy render: ${claim.renderId}`, { renderId: claim.renderId })
    let child
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(propsPath, JSON.stringify({ lista, hatter: true }))
      const logFd = fs.openSync(logPath, 'a')
      try {
        child = spawnImpl()('npx', ['remotion', 'render', 'src/index.ts', 'fos-video', outPath, '--props', propsPath], {
          cwd: remotionDir, shell: false, detached: true, stdio: ['ignore', logFd, logFd],
        })
      } finally {
        fs.closeSync(logFd)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      repo().finishRender(renderId, { status: 'hiba', hibaKod: 'render_inditas_sikertelen', hibaSzoveg: message })
      refuse('render_inditas_sikertelen', message)
    }
    if (typeof child.pid === 'number') repo().setRenderPid(renderId, child.pid)
    const safely = (fn) => async (...a) => {
      try {
        await fn(...a)
      } catch (err) {
        state.log.warn('video: a render lezárása hibára futott', { renderId, message: err instanceof Error ? err.message : String(err) })
      }
    }
    child.on('error', safely((err) => {
      const row = repo().render(renderId)
      if (row && row.status === 'fut') closeWithError(row, 'render_inditas_sikertelen', err instanceof Error ? err.message : String(err))
    }))
    child.on('exit', safely((code, signal) => finalize(renderId, { code, signal })))
    child.unref()
    repo().setVideoStatus(terv.video_id, 'renderel')
    return { renderId, status: 'fut', outPath, figyelmeztetesek }
  }

  /** True when the file's real path is under the namespace root's real path; false for anything else, including a missing file. */
  function underNamespace(file, nevterRoot) {
    let real
    let root
    try {
      real = fs.realpathSync(file)
      root = fs.realpathSync(nevterRoot)
    } catch {
      return false
    }
    return real.startsWith(root + path.sep)
  }

  function rmdirIfEmpty(dir) {
    try {
      fs.rmdirSync(dir)
    } catch {
      // Not empty, or already gone: either way it stays.
    }
  }

  /** Deletes exactly the three paths on the row, each checked against the namespace, then the row's directory if it emptied. */
  function deleteRowFiles(render, remotionDir) {
    const root = path.join(remotionDir, OUT_NEVTER)
    for (const f of [render.out_path, render.props_path, render.log_path]) {
      if (f === null || !underNamespace(f, root)) continue
      try {
        fs.unlinkSync(f)
      } catch {
        // Already gone.
      }
    }
    if (render.out_path !== null && underNamespace(path.dirname(render.out_path), root)) rmdirIfEmpty(path.dirname(render.out_path))
    repo().markRenderDeleted(render.id)
  }

  /** Keeps the newest `megtartottRenderek` finished renders of a video; the older rows lose their files (spec 11.2). */
  function takarit(videoId) {
    const remotionDir = remotionDirOf(state)
    const keep = megtartott()
    const rows = repo().rendersForVideo(videoId).filter((r) => r.status !== 'fut')
    let torolt = 0
    for (const r of rows.slice(keep)) {
      if (r.torolve_at !== null) continue
      deleteRowFiles(r, remotionDir)
      torolt += 1
    }
    rmdirIfEmpty(path.join(remotionDir, OUT_NEVTER, videoId))
    return { torolt }
  }

  function walk(dir, out) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (e.isFile()) out.push(p)
    }
    return out
  }

  /** Files under the two namespaces that no row names. Counted, never deleted: they are the operator's. */
  function orphanCount() {
    const remotionDir = remotionDirOf(state)
    const known = new Set()
    for (const r of repo().rendersAll()) for (const f of [r.out_path, r.props_path, r.log_path]) if (f !== null) known.add(f)
    for (const n of repo().narraciokAll()) known.add(path.join(remotionDir, 'public', n.fajl))
    const files = [...walk(path.join(remotionDir, OUT_NEVTER), []), ...walk(path.join(remotionDir, NARRACIO_PUBLIC_NEVTER), [])]
    return files.filter((f) => !known.has(f)).length
  }

  /** Every row-bound file in both namespaces, for the page's Tisztítás and the uninstall guide (spec 11.3). */
  function cleanupAll() {
    const remotionDir = remotionDirOf(state)
    let renderek = 0
    let narraciok = 0
    for (const r of repo().rendersAll()) {
      if (r.status === 'fut' || r.torolve_at !== null) continue
      deleteRowFiles(r, remotionDir)
      renderek += 1
    }
    const narRoot = path.join(remotionDir, NARRACIO_PUBLIC_NEVTER)
    for (const n of repo().narraciokAll()) {
      const abs = path.join(remotionDir, 'public', n.fajl)
      if (!underNamespace(abs, narRoot)) continue
      try {
        fs.unlinkSync(abs)
        narraciok += 1
      } catch {
        // Already gone.
      }
      rmdirIfEmpty(path.dirname(abs))
      rmdirIfEmpty(path.dirname(path.dirname(abs)))
    }
    for (const r of repo().rendersAll()) rmdirIfEmpty(path.join(remotionDir, OUT_NEVTER, r.video_id))
    return { renderek, narraciok, sorNelkul: orphanCount() }
  }

  return { start, status, cancel, finalize, takarit, cleanupAll, orphanCount, summary }
}

export function createRenderTools(state, ops = createRenderOps(state)) {
  return [
    {
      name: 'videoRender',
      description: 'Elindítja a legfrissebb, átment és narrált terv renderelését a Remotion-projektben, és azonnal visszatér a render id-jével; a kész fájlt a videoRenderStatus méri. Egyszerre egy render fut.',
      parameters: { type: 'object', required: ['tervId'], properties: { tervId: { type: 'string' } } },
      execute(args) {
        return guard(() => ops.start(readString('tervId', args.tervId, { required: true, max: 64 })))
      },
    },
    {
      name: 'videoRenderStatus',
      description: 'Egy render állapota a sorból: futó rendernél ellenőrzi a folyamatot (újraindítás, halott csoport, időtúllépés), kilépettnél lezárja (sha256, QA-kapu) és a QA eredményét adja.',
      parameters: { type: 'object', required: ['renderId'], properties: { renderId: { type: 'string' } } },
      execute(args) {
        return guard(() => ops.status(readString('renderId', args.renderId, { required: true, max: 64 })))
      },
    },
  ]
}
