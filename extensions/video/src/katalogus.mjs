import fs from 'node:fs'
import path from 'node:path'
import { guard, refuse } from './args.mjs'
import { sha256 } from './db.mjs'
import { ALAP_KARAKTER_PER_MP } from './idozites.mjs'
import { KOZOS_TILTOTT, KULDHETO_TIPUSOK, NEM_KULDHETO_TIPUSOK, assetProp, assetUtvonal, ellenorizProp, tablaHianyai, tablaOf } from './kit-tabla.mjs'
import { karakterPerMp, sablonStat } from './sablon.mjs'

/**
 * The catalogue the Remotion project generates, and the L1-L9 check of a
 * submitted scene list against it and the kit table (spec 4.1, 4.2, 5.1).
 *
 * What is refused here is refused at submission, before a TTS call and
 * before a render, and by name: the scene index, the type or prop as the
 * catalogue and the table spell it, and the rule. What is never in a
 * refusal is the text the agent sent -- a type name the catalogue does not
 * have, a prop name the type does not have, a path that is not a file.
 * Those are text a stranger's material became, and a message that quoted
 * them would carry that text into a log line and into the agent's next
 * prompt as this module's own words. The closed lists in the messages are
 * the module's and the catalogue's vocabulary.
 */

export const KATALOGUS_RELATIV = path.join('src', 'kit', 'katalogus.generated.json')
/** L7 window in seconds: the Q4 duration window, brought forward (spec 5.1). */
export const L7_MIN_MP = 25
export const L7_MAX_MP = 130
/** L8: a cimlap and a closing allitas alone are not a video. */
export const L8_MIN_JELENET = 3

/**
 * The configured Remotion project, or a refusal. Read from the settings on
 * every call and never cached: the operator can change the setting, and the
 * host re-runs setup() on a reload, so a copy taken once would be the stale
 * value this module promises not to act on.
 */
export function remotionDirOf(state) {
  const s = state.settings() || {}
  const dir = typeof s.remotionDir === 'string' ? s.remotionDir.trim() : ''
  if (dir === '') refuse('remotion_dir_hianyzik', 'a remotionDir beállítás üres')
  if (!fs.existsSync(path.join(dir, 'package.json'))) refuse('remotion_dir_hianyzik', `nincs package.json itt: ${dir}`)
  return dir
}

const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Reads and shape-checks the catalogue from disk on every call: the file
 * changes in the Remotion repo, which this module does not watch, and a
 * cached copy would validate a plan against a catalogue the render no
 * longer has. `katalogusHash` is the sha256 of the file's text as read, so
 * a reformatted file is a different hash; that is the intended reading,
 * because the hash stands for "the file the plan was checked against".
 */
export function readCatalog(remotionDir) {
  const file = path.join(remotionDir, KATALOGUS_RELATIV)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    refuse('katalogus_hianyzik', `nincs katalógus itt: ${file}`)
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    refuse('katalogus_ervenytelen', 'a katalógus nem JSON')
  }
  const ok = plainObject(parsed) && Array.isArray(parsed.tipusok) && parsed.tipusok.every((t) => typeof t === 'string')
    && plainObject(parsed.propok) && plainObject(parsed.leirasok) && Array.isArray(parsed.kozosPropok)
  if (!ok) refuse('katalogus_ervenytelen', 'a katalógusból hiányzik vagy rossz alakú a tipusok, propok, leirasok vagy kozosPropok mező')
  const propLista = (lista) => Array.isArray(lista) && lista.every((p) => plainObject(p) && typeof p.nev === 'string' && typeof p.kotelezo === 'boolean')
  for (const tipus of parsed.tipusok) {
    if (!Object.hasOwn(parsed.propok, tipus) || !propLista(parsed.propok[tipus])) refuse('katalogus_ervenytelen', `a(z) ${tipus} típus propjai nem olvashatók a katalógusból`)
  }
  if (!propLista(parsed.kozosPropok)) refuse('katalogus_ervenytelen', 'a katalógus közös propjai nem olvashatók')
  // The samples are what makes a type viewable as a picture (spec 3.2). They
  // are OPTIONAL on purpose: this module and the Remotion project are two
  // repositories and one is sometimes a commit behind, and a catalogue
  // without samples must cost the gallery its pictures, not the whole page.
  // What is not optional is the shape: a declared type's sample is a plain
  // object of props or the file is refused, because a string or an array
  // here would reach `remotion still` as the scene's props.
  //
  // The loop walks `tipusok`, not the sample keys, for two reasons that are
  // the same reason twice. A key that is not a declared type is DROPPED
  // rather than refused, because that is how the rest of this module already
  // reads skew between the two repositories: `tablaHianyai` reports a type
  // the newer catalogue has and the table does not as `katalogus_valtozott`,
  // a warning on the plan, and refusing the file here would cost every check
  // and every render over a picture that would not have been drawn anyway.
  // And a dropped key is a key nothing downstream can spell: it is never in
  // a message, so no text out of the file can ride a refusal into the
  // agent's next prompt, and it is never in the returned `mintak`, so the
  // gallery's one-file-per-type still cannot be named by it either. Only a
  // type the catalogue itself declares is ever named here.
  const nyersMintak = Object.hasOwn(parsed, 'mintak') ? parsed.mintak : {}
  if (!plainObject(nyersMintak)) refuse('katalogus_ervenytelen', 'a katalógus mintak mezője nem objektum')
  const mintaParok = []
  for (const tipus of parsed.tipusok) {
    if (!Object.hasOwn(nyersMintak, tipus)) continue
    if (!plainObject(nyersMintak[tipus])) refuse('katalogus_ervenytelen', `a(z) ${tipus} típus mintája nem objektum`)
    mintaParok.push([tipus, nyersMintak[tipus]])
  }
  // `fromEntries` and not an assignment loop: a type literally named
  // `__proto__` would otherwise set the prototype instead of a sample.
  const mintak = Object.fromEntries(mintaParok)
  return { katalogusHash: sha256(text), tipusok: parsed.tipusok, propok: parsed.propok, leirasok: parsed.leirasok, kozosPropok: parsed.kozosPropok, mintak, file }
}

/**
 * L1-L9 on a submitted plan (spec 5.1). Refusals end the check at the first
 * one, with the scene index and the code; warnings accumulate and go on the
 * plan row and into the tool's answer. Asset props are hashed here so the
 * plan hash can carry them (spec 3.2, `terv_hash`).
 *
 * L7 is a warning, not a refusal, though the spec's tool table lists
 * `hossz_tartomanyon_kivul` among videoDraft's refusals: the 5.1 rule table
 * calls L7 an estimate, and refusing on an estimate would be the false
 * result the spec's section 4 forbids. The refusal of that name is N3's,
 * from the measured mp3 lengths, in videoNarrate.
 *
 * `karakterPerMp` is the caller's number: the spec's estimate by default,
 * the measured ratio once sablon.mjs has enough rows.
 */
export function validateDraft({ jelenetek, narracio, katalogus, remotionDir, karakterPerMp: kpm = ALAP_KARAKTER_PER_MP }) {
  const figyelmeztetesek = []
  const assetUjjlenyomatok = []
  const bad = (code, message) => ({ refusal: { code, message }, figyelmeztetesek, assetUjjlenyomatok, becsultHosszMp: 0 })
  if (!Array.isArray(jelenetek) || jelenetek.length === 0) return bad('argumentum_hibas', 'jelenetek: nem üres lista kell')
  if (!Array.isArray(narracio)) return bad('argumentum_hibas', 'narracio: lista kell')
  for (let i = 0; i < jelenetek.length; i += 1) {
    const j = jelenetek[i]
    if (!plainObject(j)) return bad('argumentum_hibas', `jelenet ${i}: objektum kell`)
    const tipus = j.tipus
    if (typeof tipus !== 'string' || !katalogus.tipusok.includes(tipus)) {
      return bad('tipus_ismeretlen', `jelenet ${i}: a tipus nincs a katalógusban; JSON-ból küldhető típusok: ${KULDHETO_TIPUSOK.join(', ')}`)
    }
    const tabla = tablaOf(tipus)
    if (!tabla) return bad('tipus_ismeretlen', `jelenet ${i}: a katalógus ismeri a(z) ${tipus} típust, a kit-tábla nem (katalogus_valtozott: a táblát kell frissíteni)`)
    if (!tabla.kuldheto) return bad('tipus_nem_kuldheto', `jelenet ${i}: a(z) ${tipus} típus JSON-ból nem küldhető, mert a(z) ${tabla.ok} propja React-csomópont; ez a kit korlátja, nem a tervé. Küldhető típusok: ${KULDHETO_TIPUSOK.join(', ')}`)
    const katPropok = katalogus.propok[tipus]
    for (const p of katPropok) {
      if (p.kotelezo && !Object.hasOwn(j, p.nev)) return bad('prop_kotelezo_hianyzik', `jelenet ${i} (${tipus}): hiányzik a kötelező ${p.nev} prop`)
    }
    for (const nev of Object.keys(j)) {
      if (nev === 'tipus') continue
      if (KOZOS_TILTOTT.includes(nev)) return bad('prop_ismeretlen', `jelenet ${i}: a(z) ${nev} propot a modul írja a narráció méréséből a rendernél; a terv nem adhatja meg`)
      if (nev === 'racs') {
        if (typeof j.racs !== 'boolean') return bad('prop_alak_hibas', `jelenet ${i}: racs: true vagy false kell`)
        continue
      }
      if (!katPropok.some((p) => p.nev === nev)) {
        return bad('prop_ismeretlen', `jelenet ${i} (${tipus}): ismeretlen prop; a típus propjai: ${katPropok.map((p) => p.nev).join(', ')}; közös: racs`)
      }
      if (!Object.hasOwn(tabla.propok, nev)) return bad('prop_ismeretlen', `jelenet ${i} (${tipus}): a katalógus ismeri a(z) ${nev} propot, a kit-tábla nem (katalogus_valtozott: a táblát kell frissíteni)`)
      const hiba = ellenorizProp(tipus, nev, j[nev])
      if (hiba) return bad(hiba.code, `jelenet ${i} (${tipus}).${nev}: ${hiba.message}`)
      if (assetProp(tipus, nev)) {
        const ertekek = Array.isArray(j[nev]) ? j[nev] : [j[nev]]
        for (let k = 0; k < ertekek.length; k += 1) {
          const r = assetUtvonal(remotionDir, ertekek[k])
          if (r.code) return bad(r.code, `jelenet ${i} (${tipus}).${nev}${ertekek.length > 1 ? `[${k}]` : ''}: ${r.message}`)
          assetUjjlenyomatok.push({ utvonal: r.utvonal, sha256: r.sha256 })
        }
      }
    }
  }
  const szovegek = new Map()
  for (const n of narracio) {
    if (!plainObject(n) || !Number.isInteger(n.jelenet) || n.jelenet < 0 || n.jelenet >= jelenetek.length || szovegek.has(n.jelenet)) {
      return bad('argumentum_hibas', 'narracio: minden elem { jelenet: létező index, szoveg } alakú, jelenetenként egy')
    }
    if (typeof n.szoveg !== 'string' || n.szoveg.trim() === '') return bad('narracio_hianyzik', `jelenet ${n.jelenet}: üres narráció-szöveg`)
    szovegek.set(n.jelenet, n.szoveg)
  }
  for (let i = 0; i < jelenetek.length; i += 1) if (!szovegek.has(i)) return bad('narracio_hianyzik', `jelenet ${i}: nincs narráció-szöveg`)
  const karakter = [...szovegek.values()].reduce((sum, s) => sum + s.length, 0)
  const becsultHosszMp = karakter / kpm
  if (jelenetek[0].tipus !== 'cimlap') figyelmeztetesek.push('L6:elso_nem_cimlap')
  if (becsultHosszMp < L7_MIN_MP || becsultHosszMp > L7_MAX_MP) figyelmeztetesek.push('L7:hossz_tartomanyon_kivul')
  if (jelenetek.length < L8_MIN_JELENET) figyelmeztetesek.push('L8:tul_keves_tartalom')
  if (jelenetek[jelenetek.length - 1].tipus !== 'allitas') figyelmeztetesek.push('L9:zarlat_nem_allitas')
  if (tablaHianyai(katalogus).length > 0) figyelmeztetesek.push('katalogus_valtozott')
  return { refusal: null, figyelmeztetesek, assetUjjlenyomatok, becsultHosszMp }
}

/**
 * The videoCatalog tool (spec 4.1). Reads the file on every call and
 * computes the template numbers from every row on every call; both are the
 * spec's decision, not an omission, and 4.1 says why a cache here would be
 * the one nobody invalidates.
 */
export function createCatalogTool(state) {
  return {
    name: 'videoCatalog',
    description: 'A Remotion-kit jelenettípusai és propjai a katalógusból, a JSON-ból küldhető tizenkilenc típussal, a sablon-számokkal és a katalógus hash-ével. Minden híváskor a fájlból olvas; a számok minden híváskor az összes sorból számolódnak.',
    parameters: { type: 'object', properties: {} },
    execute() {
      return guard(() => {
        const katalogus = readCatalog(remotionDirOf(state))
        return {
          katalogusHash: katalogus.katalogusHash,
          tipusok: katalogus.tipusok,
          kuldhetoTipusok: KULDHETO_TIPUSOK,
          nemKuldhetoTipusok: NEM_KULDHETO_TIPUSOK,
          propok: katalogus.propok,
          leirasok: katalogus.leirasok,
          kozosPropok: katalogus.kozosPropok,
          tablaHianyok: tablaHianyai(katalogus),
          sablonStat: sablonStat(state.repo, katalogus),
          becsultKarakterPerMasodperc: karakterPerMp(state.repo),
        }
      })
    },
  }
}
