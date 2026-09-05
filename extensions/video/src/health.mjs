import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { resolvingExecFile } from './binaries.mjs'
import { ESZKOZ_PROBA, KOTELEZO_FAJLOK } from './render.mjs'
import { BACKLOG_SAPKA, JAVASLAT_NYITOTT_SAPKA, TANULSAG_SAPKA } from './tanulsag.mjs'

const execFileAsync = promisify(execFile)

/**
 * What this module says about itself, and the one list both the extension
 * card and the page read it from.
 *
 * WHAT THE HOST DOES WITH `HEALTH_CODES`. `index.mjs` hands
 * `managedResources.setupChecks` the host-declared half of every entry
 * (`setupChecks()` below). The host counts them for the extension card
 * (`describeCapabilities` in src/lib/server/extensions.ts) and carries the
 * whole list in the Managed resources payload
 * (src/lib/server/extension-managed-resources.ts). It does not run a single
 * one of them, and as of today no host surface renders the individual
 * entries -- only the total. So a check declared here is a name the operator
 * may see and a promise this file has to keep; the answering is entirely
 * `runHealth`'s.
 *
 * WHY ONE LIST. The card and the page would otherwise drift: an operator
 * reading "ffmpeg on the PATH" on one surface and nothing about it on the
 * other cannot tell which is stale. Every code `runHealth` can emit is in
 * this list, and the test file holds that to be true rather than a comment
 * promising it.
 *
 * `blokkol` is this module's own field and never reaches the host: it names
 * what the unmet condition actually stops, which is the difference between
 * the three facts the page has to keep apart -- a module that cannot reach
 * its render engine, one whose narration provider is absent, and one that is
 * simply idle. `required` is the host's field and answers a different
 * question ("must an install have this?"), which is why `platform_nem_mac`
 * is `required: false` and still blocks the render: a Linux operator who has
 * not set `linuxRenderEngedely` has a healthy install that cannot render.
 *
 * `reconcile_hianyzik` is declared here and is the one check `runHealth`
 * structurally cannot answer: whether the operator has pressed Reconcile
 * lives in the host's managed-resources summary, which extension code has no
 * way to read. It is therefore reported in `nemValaszolt` and never in
 * `hibak` -- absence from `hibak` must not be readable as "this one is
 * fine". The page answers it from the host's own payload.
 */
export const HEALTH_CODES = Object.freeze([
  { checkKey: 'remotion_dir_hianyzik', displayName: 'Remotion-projekt könyvtára', description: 'remotionDir beállítva, létezik, benne package.json, src/index.ts, src/FosVideo.tsx, src/kit/katalogus.generated.json', kind: 'manual', required: true, blokkol: Object.freeze(['terv', 'render']) },
  { checkKey: 'ffmpeg_hianyzik', displayName: 'ffmpeg a PATH-on', description: 'A QA-kapu és a Q7 hangerő-mérés eszköze', kind: 'command', target: 'ffmpeg', required: true, blokkol: Object.freeze(['render']) },
  { checkKey: 'ffprobe_hianyzik', displayName: 'ffprobe a PATH-on', description: 'A narráció hosszának és a kész fájlnak a mérése', kind: 'command', target: 'ffprobe', required: true, blokkol: Object.freeze(['narracio', 'render']) },
  { checkKey: 'npx_hianyzik', displayName: 'npx a PATH-on', description: 'A render-parancs indítója', kind: 'command', target: 'npx', required: true, blokkol: Object.freeze(['render']) },
  { checkKey: 'chrome_hianyzik', displayName: 'Chrome Headless Shell a projektben', description: 'npx remotion browser ensure az első rendernél, vagy kézzel', kind: 'manual', required: true, blokkol: Object.freeze(['render']) },
  { checkKey: 'platform_nem_mac', displayName: 'macOS host a renderhez', description: 'Máshol a render névvel utasít el, a linuxRenderEngedely beállítás kapcsolja', kind: 'manual', required: false, blokkol: Object.freeze(['render']) },
  { checkKey: 'tts_szerzodes_hianyzik', displayName: 'tts extension telepítve, engedélyezve, kulccsal', description: 'Nélküle a videoNarrate névvel utasít el', kind: 'manual', required: true, blokkol: Object.freeze(['narracio']) },
  { checkKey: 'signals_szerzodes_hianyzik', displayName: 'aisignal engedélyezve', description: 'Nélküle a videoOpen csak kezi forrással megy', kind: 'manual', required: false, blokkol: Object.freeze([]) },
  { checkKey: 'reconcile_hianyzik', displayName: 'Reconcile az Extensions lapon, a Videó kártyán', description: 'Nélküle nincs ügynök és nincs ütemezés; a lap állapotsávja mondja. CLI-ből: swarmclaw extensions reconcile --extension-id video.mjs', kind: 'manual', required: true, blokkol: Object.freeze(['utemezes']) },
])

/** The fields `ExtensionSetupCheckDeclaration` (src/types/extension.ts) declares. `blokkol` is not among them. */
const SETUP_CHECK_MEZOK = Object.freeze(['checkKey', 'displayName', 'description', 'kind', 'target', 'required'])

/**
 * `HEALTH_CODES` in the host's shape, for `managedResources.setupChecks`.
 * A fresh object per call and per entry: the host spreads what it is given
 * into its own payload and freezing is not promised anywhere, so nothing
 * this module holds is handed over by reference.
 */
export function setupChecks() {
  return HEALTH_CODES.map((code) => {
    const out = {}
    for (const mezo of SETUP_CHECK_MEZOK) if (code[mezo] !== undefined) out[mezo] = code[mezo]
    return out
  })
}

/** The codes `runHealth` cannot answer at all, reported by name so their absence from `hibak` is not read as a pass. */
export const HEALTH_NEM_VALASZOLT = Object.freeze(HEALTH_CODES.filter((c) => c.checkKey === 'reconcile_hianyzik').map((c) => c.checkKey))

const BLOKKOL = new Map(HEALTH_CODES.map((c) => [c.checkKey, c.blokkol]))

/**
 * True when the named binary answers its version probe.
 *
 * The same call `render.mjs`'s preflight makes, through the same
 * `execFileImpl` seam, with the same arguments and no timeout of its own.
 * That is deliberate: if this probe were stricter or more patient than the
 * preflight's, the page could say a tool is missing while `videoRender`
 * finds it, or the reverse, and an operator has no way to tell which of the
 * two lied. The name is resolved by the same rule as the preflight's, for
 * the same reason (src/binaries.mjs). A test sets the seam so the suite
 * never runs a binary.
 */
async function present(state, name, args) {
  const run = resolvingExecFile(state, state.execFileImpl || execFileAsync)
  try {
    await run(name, args)
    return true
  } catch {
    return false
  }
}

/**
 * Every condition this module can check, answered now.
 *
 * THREE FACTS, KEPT APART. A module that cannot reach its render engine, one
 * whose narration provider is absent, and one that is simply idle are three
 * different things, and a single boolean would report them alike. So:
 * `hibak` carries only the codes that block something and `ok` follows it;
 * `figyelmeztetesek` carries the ones that limit the module without blocking
 * anything (today `signals_szerzodes_hianyzik`: without the contract
 * `videoOpen` still works from a `kezi` source); `blokkol` names the
 * capabilities actually stopped right now; and being idle is `counts` and a
 * null `futoRender`, which is not a failure and appears in neither list.
 *
 * NO NUMBER IS GUESSED. `sorNelkul` counts files under the module's two
 * namespaces that no row names, and it needs a readable project to mean
 * anything; without one it is `null` -- "not counted" -- and never 0, which
 * would read as "nothing left behind". The same rule is why `hossz`-style
 * absences elsewhere in this module are words rather than zeroes.
 *
 * NOTHING HERE IS A SIDE EFFECT. The running render is read and summarised,
 * never adjudicated: the watchdog in render.mjs kills processes and closes
 * rows, and loading a page must not do that. `summary` carries
 * `hostUjraindult`, so the page can say "elapsed time unknown since the host
 * restarted" (spec 11.2) without this call touching the row.
 *
 * NO SETTING VALUE LEAVES EXCEPT THE THREE NAMED HERE. `remotionDir` is a
 * path the operator typed and the page shows as text; `linuxRenderEngedely`
 * and `forduloRogzites` are switches with closed vocabularies. The settings
 * object is never spread into the answer, so a key added to
 * `ui.settingsFields` later -- an API key among them -- cannot ride out of
 * here (spec 8.1: "kulcs- és tokenérték soha").
 */
export async function runHealth(state, ops) {
  const s = state.settings() || {}
  const dir = typeof s.remotionDir === 'string' ? s.remotionDir.trim() : ''
  const hibak = []
  const figyelmeztetesek = []
  const jelent = (kod) => ((BLOKKOL.get(kod) || []).length > 0 ? hibak : figyelmeztetesek).push(kod)

  const remotion = { beallitva: dir !== '', letezik: dir !== '' && fs.existsSync(dir), hianyzoFajlok: [] }
  if (remotion.letezik) for (const f of KOTELEZO_FAJLOK) if (!fs.existsSync(path.join(dir, f))) remotion.hianyzoFajlok.push(f)
  const remotionKesz = remotion.letezik && remotion.hianyzoFajlok.length === 0
  if (!remotionKesz) jelent('remotion_dir_hianyzik')

  const eszkozok = {}
  for (const [name, args] of Object.entries(ESZKOZ_PROBA)) {
    eszkozok[name] = await present(state, name, args)
    if (!eszkozok[name]) jelent(`${name}_hianyzik`)
  }

  // The browser is reported by the presence of the directory `npx remotion
  // browser ensure` writes into, and `megjegyzes` says exactly that. Running
  // the ensure command here would download a browser on a page load, and
  // claiming the browser starts would be a fact this check has not measured.
  const chromeDir = remotion.letezik && fs.existsSync(path.join(dir, 'node_modules', '.remotion'))
  if (!chromeDir) jelent('chrome_hianyzik')

  const platform = state.platform || process.platform
  const linuxRenderEngedely = s.linuxRenderEngedely === true
  if (platform !== 'darwin' && !linuxRenderEngedely) jelent('platform_nem_mac')

  // The host's own reason for each contract, verbatim (`provider_missing`,
  // `provider_disabled`, `not_declared`, `version_mismatch`), or null when it
  // resolves. These are host vocabulary, not text anyone wrote at this
  // module, which is why they are passed through rather than translated.
  const szerzodesek = { tts: state.contracts.why('tts', 'narration'), signals: state.contracts.why('aisignal', 'signals') }
  if (szerzodesek.tts) jelent('tts_szerzodes_hianyzik')
  if (szerzodesek.signals) jelent('signals_szerzodes_hianyzik')

  let sorNelkul = null
  if (remotionKesz) {
    try {
      sorNelkul = ops.orphanCount()
    } catch {
      // An unreadable project is already reported above; a failed count stays
      // null rather than becoming a zero the operator would read as "clean".
      sorNelkul = null
    }
  }

  const futo = state.repo.runningRender()
  const blokkolt = [...new Set(hibak.flatMap((kod) => [...(BLOKKOL.get(kod) || [])]))].sort()
  return {
    ok: hibak.length === 0,
    hibak,
    figyelmeztetesek,
    blokkolt,
    nemValaszolt: [...HEALTH_NEM_VALASZOLT],
    remotion,
    eszkozok,
    chrome: { konyvtar: chromeDir, megjegyzes: 'a node_modules/.remotion könyvtár léte a projektben; hogy a böngésző indul-e, az első render vagy egy kézi npx remotion browser ensure mondja meg' },
    platform,
    linuxRenderEngedely,
    szerzodesek,
    futoRender: futo ? ops.summary(futo) : null,
    sorNelkul,
    counts: state.repo.counts(),
    forduloRogzites: s.forduloRogzites === 'mind' ? 'mind' : 'sajat',
    sapkak: { nyitottJavaslat: JAVASLAT_NYITOTT_SAPKA, tanulsagCelonkent: TANULSAG_SAPKA, backlog: BACKLOG_SAPKA },
  }
}
