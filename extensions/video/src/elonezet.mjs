import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { refuse } from './args.mjs'
import { resolvingSpawn } from './binaries.mjs'
import { readCatalog, remotionDirOf } from './katalogus.mjs'

/**
 * A picture of each scene type, and the cache it lives in.
 *
 * WHAT THIS IS NOT: a renderer. `fos-video` already draws any scene list
 * handed to it as input props (the Remotion project's own composition), so a
 * preview is a ONE-SCENE list built from the catalogue's sample, and this
 * file is the process call and the bookkeeping around it. Nothing here knows
 * how a scene is drawn, and that is the point: the kit changes in the other
 * repository and this file does not follow it. There is no composition of
 * this module's own, and adding one would be the drift this design exists to
 * prevent -- a second drawing of a scene that the kit's own would then
 * disagree with.
 *
 * THE CACHE HAS NO INVALIDATION. Its key is the catalogue hash, so a changed
 * catalogue -- a new type, a reworded prop, a different sample -- is a
 * different directory, and the old pictures are simply never looked at
 * again. There is no rule to get wrong about when a picture is stale. What
 * takes the old directories away is the sweep at the end of a run, which is
 * a disk-space decision and not a correctness one: deleting nothing would
 * leave the cache correct and the disk fuller.
 *
 * IT NEVER RUNS BY ITSELF. A page load must not spawn twenty-four headless
 * browsers, so generation is a call the operator makes. `allapot` and `kep`
 * only ever read what is already on disk; the single call that starts a
 * child process is `indit`.
 *
 * WHAT A RELOAD COSTS. The run's bookkeeping is one module-level variable,
 * so a reload of this extension (the host re-runs setup() on any write under
 * data/extensions) forgets that a run was on. The pictures already written
 * stay -- they are files under the hash directory, and the next `allapot`
 * counts them -- and the child process dies with the host it was spawned
 * from, because nothing here detaches. So the cost of a reload is a run that
 * stops partway and an operator who presses the button again, which is
 * exactly what the button is for.
 */
export const ELONEZET_NEVTER = path.join('out', 'swarmclaw', 'sablon-elonezet')
/**
 * The frame taken out of the one-scene video when the catalogue does not
 * state one for the type.
 *
 * A FALLBACK, NOT A MEASUREMENT, and the difference matters. A single frame
 * good for every type does not exist: each type's timing is a formula in the
 * kit, and the formula reads the sample. `fordulat` with three problems
 * strikes them through at 2 + 3*26 + 10 = 90 and reveals its solution at
 * 120, so at 85 it draws three plain lines and none of what the type is for.
 * `osszegzes` adds its total at 37 + 60 + 12 = 109, so at 85 the last number
 * is still counting up and the total row is not there yet. Both were
 * rendered, both are wrong at 85, and a fourth problem in the sample would
 * move `fordulat` again.
 *
 * So the frame belongs to the type and travels with the sample, in the
 * catalogue's `mintaKockak`; this number is what a type whose timing the
 * catalogue does not state gets. Where 85 came from is still worth knowing:
 * it is late enough that the types whose entrance animation is the whole of
 * their motion (`cimlap`, `allitas`, `szam`, `idezet`) have settled, which
 * is why it is a better guess than 60. It is a guess.
 */
export const KOCKA = 85
/**
 * A scene must outlast the frame it is sampled at, so the visible length is
 * DERIVED from the frame and never fixed.
 *
 * The failure this closes is not theoretical: `osszegzes` completes at frame
 * 109, and under a hard-coded `lathatoHossz: 90` the scene has ended before
 * that frame exists, so no frame number whatsoever could have drawn its
 * total. A fixed length silently caps every type's timing at the shortest
 * one somebody wrote down.
 *
 * The tail is there because a type is not only "finished" at its last
 * keyframe -- the kit holds a settled scene for a beat -- and sampling on
 * the exact last frame of the composition is the one frame most likely to
 * catch an exit.
 */
export const MIN_LATHATO_HOSSZ = 90
export const KOCKA_UTAN = 30
/** 1080x1920 scaled to 360x640: a card in a grid, not a poster. */
export const SKALA = 0.333
/** Hash directories kept when a run finishes: the current one and the one before it. */
export const MEGTARTOTT_HASHEK = 2
/** One still on a warm bundle measured 1.7s; a minute is a hang, not a slow machine. */
export const STILL_TIMEOUT_MS = 60_000

/** A sha256 hex digest, and nothing else, may name a directory under the namespace. */
const HASH_ALAK = /^[0-9a-f]{64}$/
/**
 * A type name this module is willing to build a filename from.
 *
 * The catalogue's own twenty-four are all lowercase words and dashes, and a
 * name outside this shape is not refused anywhere upstream: `readCatalog`
 * drops a SAMPLE key the catalogue does not declare as a type, but a
 * catalogue that DECLARES `../../etc/passwd` in `tipusok` declares it for
 * every reader, this one included. So the membership test the global
 * constraint requires is done first and this shape test is done after it:
 * two independent reasons a name may not become a path, and a defect in
 * either one alone is not enough to write a file outside the cache.
 */
const NEV_ALAK = /^[a-z0-9][a-z0-9-]{0,63}$/
/** What the sweep is allowed to unlink inside a hash directory: this module's own two file kinds. */
const SAJAT_FAJL = /^[a-z0-9][a-z0-9-]{0,63}\.(png|props\.json)$/

/** The run in progress, or null. One at a time, and a second start is refused rather than queued. */
let futas = null

/**
 * Whether a type has a sample worth drawing.
 *
 * AN EMPTY OBJECT IS NOT A SAMPLE, and this is the one judgement this file
 * makes on its own. `{}` passes `readCatalog`'s shape check -- it is a plain
 * object of props with no props in it -- so nothing upstream refuses it.
 * Handed to `remotion still` it would spawn a browser and cost 1.7 seconds to
 * produce a picture of a scene with nothing in it: a blank card. A blank card
 * is exactly what "this type has no sample" is there to announce, and
 * announcing it with a picture is worse than announcing it in words, because
 * the operator cannot tell a template that draws nothing from a sample the
 * other repository has not written yet. So a sample with no keys is reported
 * as no sample: no browser is spawned for it, and the card says the catalogue
 * still owes it one.
 *
 * THIS IS NOT A CONTENT CHECK, and must not become one. `keszulek-sor`'s
 * sample was `{ cim: ..., kepernyok: [] }` for as long as the kit did not
 * route `kepernyok` through its filename helper -- one real prop and one
 * empty list -- and it drew a card with a title and nothing else. That was
 * a true picture of what the kit did with that sample: the process exits 0,
 * the file is a valid PNG, and none of it is a failure of anything here.
 * The kit has since given that sample its screenshots, which changed the
 * picture and not the rule: the rule is about a sample with no keys, not
 * about a sample whose keys are thin.
 */
export function vanMinta(katalogus, tipus) {
  if (!Object.hasOwn(katalogus.mintak, tipus)) return false
  return Object.keys(katalogus.mintak[tipus]).length > 0
}

/**
 * The directory this catalogue's pictures live in.
 *
 * The hash comes from `readCatalog`, which computes it with `sha256`, so it
 * is already path-safe; it is checked here anyway, because this function is
 * the only place a caller-supplied string becomes a directory name and a
 * check at the boundary does not depend on every caller being right.
 */
export function elonezetDir(remotionDir, katalogusHash) {
  if (typeof katalogusHash !== 'string' || !HASH_ALAK.test(katalogusHash)) refuse('katalogus_hash_hibas', 'a katalógus hash-e nem 64 hexjegy')
  return path.join(remotionDir, ELONEZET_NEVTER, katalogusHash)
}

/**
 * The file a type's picture is written to, or null when this module will not
 * name a file after it.
 *
 * Two gates, in this order: the type is one the catalogue declares (the
 * global constraint -- nothing that failed this test ever reaches a path),
 * and the name is a filename this module is willing to write (`NEV_ALAK`).
 */
export function kepUt(dir, katalogus, tipus) {
  if (typeof tipus !== 'string' || !katalogus.tipusok.includes(tipus)) return null
  if (!NEV_ALAK.test(tipus)) return null
  return path.join(dir, `${tipus}.png`)
}

/** The .png files present in a hash directory; an empty list when the directory is not there yet. */
function meglevoFajlok(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return new Set()
  }
  return new Set(entries.filter((e) => e.isFile() && e.name.endsWith('.png')).map((e) => e.name))
}

/**
 * The three lists the page draws the gallery from, walking the catalogue's
 * own type order so the grid does not reshuffle between two calls.
 *
 * A type whose name this module will not write a file for is in `hianyzo`
 * rather than dropped: a list that silently omits a type would tell the
 * operator the gallery is complete when it is not. The run then records why
 * it could not draw it, by code, without ever building the path.
 */
function listak(katalogus, dir) {
  const fajlok = meglevoFajlok(dir)
  const meglevo = []
  const hianyzo = []
  const mintaNelkul = []
  for (const tipus of katalogus.tipusok) {
    if (!vanMinta(katalogus, tipus)) {
      mintaNelkul.push(tipus)
      continue
    }
    const ut = kepUt(dir, katalogus, tipus)
    if (ut !== null && fajlok.has(path.basename(ut))) meglevo.push(tipus)
    else hianyzo.push(tipus)
  }
  return { meglevo, hianyzo, mintaNelkul }
}

/**
 * The run as the page may read it: counts, codes and names, never the child
 * process handle.
 *
 * Exported because it is the one part of `allapot` that does not need the
 * project. A run started before the operator changed the setting is still
 * on, and `templatePreviewStatus` answers with it beside the refusal code
 * rather than reporting `null` at a moment the cancel button is the thing
 * the operator wants.
 */
export function futasNezet() {
  if (futas === null) return null
  return {
    katalogusHash: futas.katalogusHash,
    osszes: futas.osszes,
    kesz: [...futas.kesz],
    hibak: { ...futas.hibak },
    megszakitva: futas.megszakitva,
    indultAt: futas.indultAt,
  }
}

/**
 * What is drawn, what is not, and what could never be. Reads the catalogue
 * and the directory on every call and starts nothing.
 */
export function allapot(state) {
  const remotionDir = remotionDirOf(state)
  const katalogus = readCatalog(remotionDir)
  const dir = elonezetDir(remotionDir, katalogus.katalogusHash)
  const { meglevo, hianyzo, mintaNelkul } = listak(katalogus, dir)
  return {
    katalogusHash: katalogus.katalogusHash,
    katalogusTipusok: katalogus.tipusok,
    meglevo,
    hianyzo,
    mintaNelkul,
    fut: futasNezet(),
  }
}

/**
 * One `remotion still`, resolved to a promise that never rejects: a failure
 * is a code on the type, because the run goes on after it.
 *
 * Exit 0 with the file on disk is the whole success test, deliberately.
 * `keszulek-sor` draws a card with a title and nothing else and exits 0, and
 * a check on the picture's content would report that true render as a
 * failure; the kit's empty-looking card is the kit's business, not this
 * module's.
 */
function egyKep(menetAllapot, spawner, remotionDir, propsPath, outPath, kocka) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawner('npx', ['remotion', 'still', 'src/index.ts', 'fos-video', outPath, `--props=${propsPath}`, `--frame=${kocka}`, `--scale=${SKALA}`], {
        cwd: remotionDir, shell: false, stdio: ['ignore', 'ignore', 'ignore'],
      })
    } catch {
      resolve({ kod: 'inditas_sikertelen' })
      return
    }
    // The run is carried down rather than read back off the module variable:
    // a child's exit arrives after the run it belongs to may already have
    // been replaced, and writing to whatever `futas` happens to be then would
    // be one run clearing another run's child.
    menetAllapot.gyerek = child
    let done = false
    const finish = (hiba) => {
      if (done) return
      done = true
      clearTimeout(timer)
      menetAllapot.gyerek = null
      resolve(hiba)
    }
    const timer = setTimeout(() => {
      olj(child, 'SIGKILL')
      finish({ kod: 'idotullepes' })
    }, STILL_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', () => finish({ kod: 'inditas_sikertelen' }))
    child.on('exit', (code, signal) => {
      if (code === null) {
        finish({ kod: 'megszakadt', jel: typeof signal === 'string' ? signal : '' })
        return
      }
      if (code !== 0) {
        finish({ kod: 'kilepesi_kod', kilepesiKod: code })
        return
      }
      finish(fs.existsSync(outPath) ? null : { kod: 'nincs_fajl' })
    })
  })
}

/** A signal to the child, never a throw: a process that is already gone is the outcome the caller wanted. */
function olj(child, jel) {
  try {
    if (child && typeof child.kill === 'function') child.kill(jel)
  } catch {
    // Already gone, or not ours to signal.
  }
}

/**
 * Deletes one hash directory, and only the files this module writes into it.
 *
 * NOT a recursive remove. The Remotion project holds narration audio and
 * rendered videos under a sibling path, none of it regenerable, and a
 * recursive delete on a computed path is one arithmetic mistake away from
 * reaching them. So the unlink list is filtered by `SAJAT_FAJL` -- this
 * module's own two file kinds and nothing else -- and the directory itself
 * goes with a plain `rmdir`, which fails on a directory that still holds
 * anything. A file somebody else put here therefore keeps the whole
 * directory, which is the right way round: an undeleted directory costs disk
 * space, and a deleted one costs the operator something they cannot get back.
 */
function torolHashMappa(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isFile() || !SAJAT_FAJL.test(e.name)) continue
    try {
      fs.unlinkSync(path.join(dir, e.name))
    } catch {
      // Already gone.
    }
  }
  try {
    fs.rmdirSync(dir)
  } catch {
    // Something else is in there: it stays, and so does the directory.
  }
}

/**
 * Keeps the run's own hash directory and the newest of the others, and takes
 * the rest.
 *
 * THE CURRENT HASH IS NOT SORTED, IT IS KEPT. Age is a bad proxy for "live":
 * `mkdirSync(dir, { recursive: true })` on a directory that already exists
 * does not touch its mtime, so a run that finds nothing missing never
 * refreshes its own directory, and two other hashes edited later are both
 * newer than the cache the operator is looking at. The precondition is
 * ordinary -- edit the kit twice, revert to an earlier catalogue, press the
 * button -- and the outcome was a complete cache swept away by the run that
 * had just decided it was complete. So the live hash is named to this
 * function and taken out of the candidates before the sort, which is also
 * what `MEGTARTOTT_HASHEK` has always said out loud: the current one and the
 * one before it.
 *
 * Three independent conditions before any path is deleted, because one bug
 * elsewhere must not be enough: the entry's name is 64 hex digits (so it
 * cannot be `.`, `..`, or anything with a separator in it), the entry is a
 * real directory and not a symlink pointing out of here, and the path built
 * from it has the namespace root as its immediate parent -- which is also
 * what makes it impossible for this to name the root itself.
 */
function seper(remotionDir, jelenlegiHash) {
  const root = path.join(remotionDir, ELONEZET_NEVTER)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { torolt: 0 }
  }
  const mappak = []
  let jelenlegiVan = false
  for (const e of entries) {
    if (!HASH_ALAK.test(e.name)) continue
    if (!e.isDirectory()) continue
    // Never a candidate, whatever its mtime says.
    if (e.name === jelenlegiHash) {
      jelenlegiVan = true
      continue
    }
    const dir = path.join(root, e.name)
    if (dir === root || path.dirname(dir) !== root) continue
    let mtime = 0
    try {
      mtime = fs.statSync(dir).mtimeMs
    } catch {
      continue
    }
    mappak.push({ dir, mtime })
  }
  mappak.sort((a, b) => b.mtime - a.mtime)
  // `MEGTARTOTT_HASHEK` counts what survives, the current directory
  // included, so it takes one of the places when it is there.
  const megtartottRegi = Math.max(0, MEGTARTOTT_HASHEK - (jelenlegiVan ? 1 : 0))
  let torolt = 0
  for (const m of mappak.slice(megtartottRegi)) {
    torolHashMappa(m.dir)
    torolt += 1
  }
  return { torolt }
}

/**
 * The frame this type is sampled at: the catalogue's own number when it
 * states one, and `KOCKA` when it does not.
 *
 * A catalogue from before the field exists carries none, and every type then
 * gets the fallback -- which is what the module did before the field, so the
 * gallery does not get worse while the other repository catches up.
 */
export function kockaFor(katalogus, tipus) {
  const kockak = katalogus.mintaKockak || {}
  return Object.hasOwn(kockak, tipus) ? kockak[tipus] : KOCKA
}

/** Long enough that the sampled frame is inside the scene, with a beat after it. */
export function lathatoHosszFor(kocka) {
  return Math.max(MIN_LATHATO_HOSSZ, kocka + KOCKA_UTAN)
}

/**
 * The one-scene list `fos-video` is handed: the sample, its type, and a
 * visible length this module writes rather than reads from the sample (spec
 * 3.2). The length is derived from the frame, so a type the catalogue says
 * settles late gets a scene that is still running when the still is taken.
 */
function propsFor(katalogus, tipus, kocka) {
  return { lista: [{ tipus, ...katalogus.mintak[tipus], lathatoHossz: lathatoHosszFor(kocka) }], hatter: true }
}

/**
 * The run itself: one type at a time, and one type's failure lands on that
 * type rather than on the run.
 *
 * Serial on purpose. Twenty-four headless browsers at once is not four times
 * faster than six, it is a machine the operator cannot use while it happens,
 * and the run already tells them where it is.
 */
async function menet(state, menetAllapot, { remotionDir, katalogus, dir, hianyzo, spawner }) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const tipus of hianyzo) {
      if (menetAllapot.megszakitva) break
      const outPath = kepUt(dir, katalogus, tipus)
      if (outPath === null) {
        menetAllapot.hibak[tipus] = { kod: 'tipus_neve_nem_fajlnev' }
        continue
      }
      const propsPath = path.join(dir, `${tipus}.props.json`)
      const kocka = kockaFor(katalogus, tipus)
      let hiba = null
      try {
        fs.writeFileSync(propsPath, JSON.stringify(propsFor(katalogus, tipus, kocka)))
        hiba = await egyKep(menetAllapot, spawner, remotionDir, propsPath, outPath, kocka)
      } catch {
        hiba = { kod: 'inditas_sikertelen' }
      } finally {
        try {
          fs.unlinkSync(propsPath)
        } catch {
          // Never written, or already gone.
        }
      }
      if (hiba === null) menetAllapot.kesz.push(tipus)
      else menetAllapot.hibak[tipus] = hiba
    }
    seper(remotionDir, katalogus.katalogusHash)
  } catch (err) {
    state.log.warn('video: az előnézet-generálás megszakadt', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    // Only this run releases the lock, and only if it still holds it: a
    // module reload or a test reset can have moved on without it.
    if (futas === menetAllapot) futas = null
  }
}

/**
 * Starts the generation of every missing picture and returns at once.
 *
 * IT RETURNS BEFORE THE RUN FINISHES, and that is the design. Twenty-four
 * stills at 1.7 seconds each is most of a minute, and this is called over an
 * http request the page is waiting on; holding that request open for a
 * minute would give the operator a spinner with nothing behind it and cost
 * them the cancel button, which is a second request. So the answer is "it
 * started" and `allapot` is what says where it got to.
 *
 * A SECOND START IS REFUSED BY NAME, never queued. A queue here would mean
 * the operator's second press eventually spawns twenty-four more browsers at
 * a moment nobody chose; the refusal says the run is already on, and the run
 * is what they wanted.
 *
 * `spawnImpl` is the seam, the same one `render.mjs` uses: an explicit
 * argument first, then `state.spawnImpl`, then the real `spawn`. Both are
 * honoured so a caller can inject one call's spawn without touching the
 * shared state, and so a test that already set `state.spawnImpl` for the
 * render never spawns a browser here either.
 */
export async function indit(state, spawnImpl = state.spawnImpl || spawn) {
  if (futas !== null) refuse('mar_fut', 'már fut egy generálás')
  const remotionDir = remotionDirOf(state)
  const katalogus = readCatalog(remotionDir)
  const dir = elonezetDir(remotionDir, katalogus.katalogusHash)
  const { hianyzo } = listak(katalogus, dir)
  const menetAllapot = {
    katalogusHash: katalogus.katalogusHash,
    osszes: hianyzo.length,
    kesz: [],
    hibak: {},
    megszakitva: false,
    gyerek: null,
    indultAt: new Date().toISOString(),
  }
  futas = menetAllapot
  // Not awaited: the run outlives this call, and `menet` clears `futas` in a
  // finally of its own, so nothing here can leave the lock held.
  //
  // The `.catch` is not decoration. `menet`'s body is wrapped, so the only
  // way it rejects is its own last resort throwing -- `state.log.warn`
  // itself failing inside the catch -- and a promise nobody is holding that
  // rejects is an unhandled rejection, which Node ends the process on by
  // default. A logger that cannot log must not take the host down with it.
  menet(state, menetAllapot, { remotionDir, katalogus, dir, hianyzo, spawner: resolvingSpawn(state, spawnImpl) }).catch(() => {})
  return { indult: true }
}

/**
 * Stops the run before the next type, and signals the one in flight.
 *
 * What is already generated stays: those pictures are correct for this
 * catalogue hash, and a cancel is "stop spending my machine", not "throw away
 * what you did". The next start picks up the types still missing.
 */
export function megszakit() {
  if (futas === null) return { megszakitva: false }
  futas.megszakitva = true
  olj(futas.gyerek, 'SIGTERM')
  return { megszakitva: true }
}

/**
 * One template's picture as a data URL, or null with the reason.
 *
 * A data URL rather than a file the page fetches: the pictures live inside
 * the operator's Remotion project, which the app serves nothing from, and
 * opening a static route onto a configured directory would be a much larger
 * decision than a gallery needs. At 360x640 a still is tens of kilobytes and
 * the grid asks per card.
 */
export function kep(state, tipus) {
  const remotionDir = remotionDirOf(state)
  const katalogus = readCatalog(remotionDir)
  const dir = elonezetDir(remotionDir, katalogus.katalogusHash)
  const ut = kepUt(dir, katalogus, tipus)
  if (ut === null) return { dataUrl: null, ok: 'tipus_ismeretlen' }
  if (!vanMinta(katalogus, tipus)) return { dataUrl: null, ok: 'nincs_minta' }
  let bytes
  try {
    bytes = fs.readFileSync(ut)
  } catch {
    return { dataUrl: null, ok: 'nincs_kep' }
  }
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
}

/** Test seam: forgets a run the suite left behind, so one test's lock is not the next one's refusal. */
export function _resetFutas() {
  futas = null
}
