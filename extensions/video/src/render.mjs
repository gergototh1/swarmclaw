import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { guard, readString, refuse } from './args.mjs'
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
  const spawnImpl = () => state.spawnImpl || spawn
  const execFileImpl = () => state.execFileImpl || execFileAsync
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
   * SIGTERM to the group now, SIGKILL after ten seconds. A SIGTERM that throws
   * means there is no group left to signal, so no SIGKILL is scheduled for it;
   * the timer is unref'd, so a pending one never holds the process open.
   */
  function killGroup(pid) {
    try {
      killImpl()(-pid, 'SIGTERM')
    } catch {
      return
    }
    const timer = setTimeout(() => {
      try {
        killImpl()(-pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }, SIGKILL_UTAN_MS)
    timer.unref()
  }

  /** Writes the video's status only while this render's plan is still the latest: a newer plan owns the status. */
  function videoStatusAfterRender(render, status) {
    const latest = repo().latestTerv(render.video_id)
    if (latest && latest.id === render.terv_id) repo().setVideoStatus(render.video_id, status)
  }

  async function closeWithFile(render) {
    const sha = await fileSha256(render.out_path)
    if (!repo().finishRender(render.id, { status: 'kesz', fileSha256: sha })) return
    let qa
    try {
      qa = await runQaGate({ filePath: render.out_path, execFileImpl: execFileImpl() })
    } catch (err) {
      repo().setRenderHiba(render.id, 'qa_meres_sikertelen', err instanceof Error ? err.message : String(err))
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
      repo().setRenderHiba(render.id, 'qa_meres_sikertelen', 'a fájl a lezárás és a mérés között megváltozott; a mérés nem a soron álló sha256-ra vonatkozik')
      videoStatusAfterRender(render, 'qa_meretlen')
      return
    }
    repo().insertQa({ renderId: render.id, fileSha256: qa.fileSha256, szabalykeszlet: SZABALYKESZLET, ok: qa.ok, meresek: { ...qa.meresek, figyelmeztetesek: qa.figyelmeztetesek }, bukasok: qa.bukasok })
    videoStatusAfterRender(render, qa.ok ? 'qa_ok' : 'qa_hiba')
  }

  function closeWithError(render, kod, szoveg) {
    if (!repo().finishRender(render.id, { status: 'hiba', hibaKod: kod, hibaSzoveg: szoveg })) return
    videoStatusAfterRender(render, 'render_hiba')
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

  /** Spec 3.4 steps 1-2: a render whose process is gone is closed from the disk, and no signal is sent. */
  async function closeDead(render, miert) {
    if (render.out_path !== null && fs.existsSync(render.out_path)) return closeWithFile(render)
    const dir = render.out_path === null ? null : path.dirname(render.out_path)
    if (dir === null || !fs.existsSync(dir)) return closeWithError(render, 'render_kimenet_hianyzik', `${miert}; a kimeneti könyvtár sincs meg (kézzel törölve?)`)
    return closeWithError(render, 'render_megszakadt', `${miert}; a könyvtár megvan, a fájl nincs; napló: ${render.log_path}`)
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
        killGroup(render.pid)
        closeWithError(render, 'render_idotullepes', `${renderMaxPerc()} percnél régebb óta fut; a csoport SIGTERM-et kapott, tíz másodperc múlva SIGKILL-t`)
      }
    }
    return summary(repo().render(renderId))
  }

  function cancel(renderId) {
    const render = repo().render(renderId)
    if (!render) refuse('render_ismeretlen', `nincs render ezzel az id-vel: ${renderId}`)
    if (render.status !== 'fut') refuse('render_nem_fut', `a render státusza ${render.status}`)
    // The row closes first so the exit event that follows the kill finds nothing to do.
    closeWithError(render, 'render_megszakitva', 'az operátor leállította a lapról')
    if (groupAlive(render.pid)) killGroup(render.pid)
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
