import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from './db.mjs'

/**
 * WHAT THE KIT ACCEPTS FROM JSON, PROP BY PROP (spec 4.2.1).
 *
 * The catalogue the Remotion project generates carries names and prose, not
 * value types: `sorok: "string"` passes a catalogue-only check and throws in
 * the middle of a render, and `cimlap.hatter`'s seven values are a sentence.
 * This table adds what the catalogue lacks -- the shape of each value, the
 * enumerations, which props are files under public/, and which types and
 * props are React nodes that no JSON can carry.
 *
 * It is a second copy of the kit's types, on purpose and with its cost
 * stated: it goes stale when the kit changes. That is why THIS TABLE IS THE
 * ALLOWLIST and the catalogue is not. A type or prop the catalogue has and
 * this table does not is refused when a plan uses it, and every plan is
 * warned `katalogus_valtozott` while the gap exists, so a kit change can
 * never admit an unchecked value -- it can only be visibly missing until the
 * table follows. What test/katalogus.test.mjs pins is this table against
 * test/fixtures/katalogus.generated.json -- a byte copy of the catalogue,
 * taken on the date below -- and no test reads the operator's live project.
 * So a REGENERATED kit does not turn this suite red: it turns into the
 * `katalogus_valtozott` warning on every plan and into a refusal for the
 * agent that reaches for the new type, and the fixture and this table are
 * brought forward together afterwards. The test keeps the pair from drifting
 * apart on their own; the operator's kit is guarded by the warning and the
 * refusal, not by a test.
 *
 * The shapes were read off the Remotion project's src/kit/jelenetek.tsx,
 * jelenetek2.tsx, jelenetek3.tsx (the `*Props` types) and src/kit/Diagram.tsx
 * (`Oszlop`, `Resz`) on 2026-09-05, against the catalogue whose copy is
 * test/fixtures/katalogus.generated.json. Every optional number the kit
 * feeds into its `T()` tempo helper is clamped there with Math.max, so a
 * zero or a negative `tempo`, `lepes` or `meret` does not crash a render;
 * the table therefore bounds only `osszehuzas.arany`, which the catalogue
 * itself states as 0..1.
 *
 * THREE TYPES CHANGED SIDES ON 2026-09-05, and it is written down because
 * this table said the opposite for a while. `keszulek-sor.kepernyok`,
 * `osztott.bal`, `osztott.jobb` and `nagyitas.kep` are React nodes in the
 * kit's TypeScript to this day -- the hand-written videos pass finished
 * elements into them -- but the kit now routes all four through its
 * `kepElem()` helper, whose rule is: a STRING is a filename under `public/`,
 * anything else is a finished element. A filename is precisely what JSON can
 * carry, so the three types became orderable, and the catalogue's own prose
 * was corrected to say it ("...fajlnevet adj"). This table had read the
 * TypeScript type and marked them `kuldheto: false`; that verdict outlived
 * the kit change, and while it did, the agent was refused a type the kit
 * accepts and the gallery printed "nem küldhető" three lines above the
 * catalogue's own instruction to send a filename. They are `kep`/`kep[]`
 * here, which is not only a flag: it puts them under the asset rule, so the
 * filename is checked against `public/` and hashed onto the plan's
 * fingerprint like every other file-valued prop.
 *
 * NOTHING AUTOMATED CATCHES THAT CLASS. `tablaHianyai` compares the PRESENCE
 * of types and props and never this verdict, and the catalogue does not
 * state sendability at all, so there is no second source to compare against.
 * A kit change that turns a React-only prop into a filename prop is read by
 * a person and written here.
 */

const S = 'string'
const SL = 'string[]'
const N = 'number'
const NL = 'number[]'
const B = 'boolean'
const K = 'kep'
const KL = 'kep[]'
/** A prop typed as a React node in the kit: no JSON value can carry it. */
const NEM = Object.freeze({ kuldheto: false })
const enumOf = (...ertekek) => Object.freeze({ alak: 'enum', ertekek: Object.freeze(ertekek) })
/** Diagram.tsx `Oszlop`: cimke, ertek, and two optional CSS colour strings. */
const OSZLOP = Object.freeze({ alak: 'objektum[]', mezok: Object.freeze({ cimke: S, ertek: N, szin: 'string?', cimkeSzin: 'string?' }) })
/** Diagram.tsx `Resz`: every field required, szin is a CSS colour string. */
const RESZ = Object.freeze({ alak: 'objektum[]', mezok: Object.freeze({ cimke: S, ertek: N, szin: S }) })

export const KIT_TABLA = Object.freeze({
  cimlap: { kuldheto: true, propok: { sorok: SL, kiemelt: S, hatter: enumOf('csillagok', 'csillagok-remotion', 'racs', 'tiszta', 'kepek', 'kep-teljes', 'kep-sotet'), kepek: KL, grafika: NEM, lepes: N, meret: N } },
  atvezeto: { kuldheto: true, propok: { sorszam: S, nev: S, meret: N } },
  lista: { kuldheto: true, propok: { cim: S, felsorolas: SL, kep: K, makett: enumOf('telefon', 'kartya', 'nincs'), zaroSor: S, lepes: N } },
  'kartya-csere': { kuldheto: false, ok: 'kartyak[].jel', propok: { cim: S, felsorolas: SL, kartyak: NEM } },
  allitas: { kuldheto: true, propok: { mondat: S, kiemelt: SL, masodik: S, meret: N, hatterVideo: K, hatterVideoTeljes: B, hatterPergo: KL, grafika: NEM } },
  szam: { kuldheto: true, propok: { felvezeto: S, szam: N, utoszo: S, meret: N } },
  cta: { kuldheto: false, ok: 'sorok[].ikon', propok: { sorok: NEM } },
  gorbe: { kuldheto: true, propok: { cim: S, ertekek: NL, zaroSzam: N, egyseg: S, teljes: B, tempo: N } },
  oszlop: { kuldheto: true, propok: { cim: S, adatok: OSZLOP, egyseg: S, teljes: B, tempo: N } },
  koriv: { kuldheto: true, propok: { cim: S, szazalek: N, alaSzoveg: S, tempo: N } },
  osszehuzas: { kuldheto: true, propok: { cim: S, rol: S, ra: S, arany: Object.freeze({ alak: 'number', min: 0, max: 1 }), savMeret: N, savSuly: N, tempo: N } },
  'keszulek-sor': { kuldheto: true, propok: { cim: S, kepernyok: KL, teljes: B, tempo: N } },
  idezet: { kuldheto: true, propok: { idezet: S, kitol: S, hol: S, kep: K, egyben: B, tempo: N } },
  racs: { kuldheto: true, propok: { cim: S, elemek: Object.freeze({ alak: 'objektum[]', mezok: Object.freeze({ szoveg: S }), tiltott: Object.freeze(['jel']) }), oszlop: N } },
  'szam-racs': { kuldheto: true, propok: { cim: S, szamok: Object.freeze({ alak: 'objektum[]', mezok: Object.freeze({ ertek: N, cimke: S, utotag: 'string?' }) }) } },
  'kep-allitas': { kuldheto: true, propok: { kep: K, sor: S, doles: N, grafikaMeret: N } },
  lepessor: { kuldheto: true, propok: { cim: S, lepesek: SL } },
  osztott: { kuldheto: true, propok: { cim: S, bal: K, jobb: K, balCimke: S, jobbCimke: S } },
  osszetetel: { kuldheto: true, propok: { cim: S, reszek: RESZ } },
  bizonyitek: { kuldheto: true, propok: { allitas: S, kulcsszo: S, adatok: OSZLOP, egyseg: S } },
  fordulat: { kuldheto: true, propok: { problemak: SL, megoldas: S } },
  magyarazott: { kuldheto: true, propok: { cim: S, reszek: Object.freeze({ alak: 'objektum[]', mezok: Object.freeze({ cimke: S, ertek: N, szin: S, magyarazat: S }) }) } },
  osszegzes: { kuldheto: true, propok: { cim: S, reszek: Object.freeze({ alak: 'objektum[]', mezok: Object.freeze({ ertek: N, cimke: S }) }), osszegCimke: S, utotag: S } },
  nagyitas: { kuldheto: true, propok: { kep: K, felirat: S, x: N, y: N, merteke: N } },
})

/**
 * The table row for a type, or null. `Object.hasOwn` rather than indexing:
 * the name comes from a scene an agent wrote, and `KIT_TABLA['constructor']`
 * would otherwise be a function and read as a known type.
 */
export const tablaOf = (tipus) => (typeof tipus === 'string' && Object.hasOwn(KIT_TABLA, tipus) ? KIT_TABLA[tipus] : null)
const leiroOf = (tabla, nev) => (typeof nev === 'string' && Object.hasOwn(tabla.propok, nev) ? tabla.propok[nev] : null)

export const KULDHETO_TIPUSOK = Object.freeze(Object.keys(KIT_TABLA).filter((t) => KIT_TABLA[t].kuldheto))
export const NEM_KULDHETO_TIPUSOK = Object.freeze(Object.keys(KIT_TABLA).filter((t) => !KIT_TABLA[t].kuldheto))
/** The common props the caller may not send: the module writes both from the narration measurement at render time (spec 4.2). */
export const KOZOS_TILTOTT = Object.freeze(['hang', 'lathatoHossz'])
/** The common props the catalogue lists; `racs` is the caller's, the other two are the module's. */
const KOZOS_ISMERT = Object.freeze(['hang', 'lathatoHossz', 'racs'])

const alakOf = (leiro) => (typeof leiro === 'string' ? leiro : leiro.alak)
const assetAlak = (leiro) => leiro !== NEM && (alakOf(leiro) === 'kep' || alakOf(leiro) === 'kep[]')

/**
 * `tipus.prop` for every prop whose value becomes a path in the kit's
 * staticFile() (spec 4.2.2). Derived from the table, so an eleventh asset
 * prop a later catalogue brings is not here until the table names it, and
 * until then the allowlist rule refuses it rather than passing text into a
 * path.
 */
export const ASSET_PROPOK = Object.freeze(Object.entries(KIT_TABLA).flatMap(([tipus, t]) =>
  Object.entries(t.propok).filter(([, leiro]) => assetAlak(leiro)).map(([nev]) => `${tipus}.${nev}`)))

/** True when the table's descriptor for this prop names a file under public/. */
export function assetProp(tipus, nev) {
  const tabla = tablaOf(tipus)
  const leiro = tabla ? leiroOf(tabla, nev) : null
  return leiro !== null && assetAlak(leiro)
}

/**
 * Types and props the catalogue has and this table does not, as `tipus`,
 * `tipus.prop` and `kozos.prop`; empty when the table is current. The names
 * are the catalogue's own, so listing them names what the operator has to
 * add to the table.
 */
export function tablaHianyai(katalogus) {
  const out = []
  for (const tipus of katalogus.tipusok) {
    const tabla = tablaOf(tipus)
    if (!tabla) { out.push(tipus); continue }
    for (const p of katalogus.propok[tipus] || []) if (leiroOf(tabla, p.nev) === null) out.push(`${tipus}.${p.nev}`)
  }
  for (const p of katalogus.kozosPropok || []) if (!KOZOS_ISMERT.includes(p.nev)) out.push(`kozos.${p.nev}`)
  return out
}

const szoveg = (v) => typeof v === 'string' && v.trim() !== ''
const szam = (v) => typeof v === 'number' && Number.isFinite(v)
const hibas = (message) => ({ code: 'prop_alak_hibas', message })

/**
 * The refusal for a value that does not fit a descriptor, or null. Messages
 * name the shape that was needed and, for an object element, its index and
 * the field; they never quote the value or an unknown field name, because
 * both are text an agent typed and a refusal that echoed them would carry
 * that text into the agent's next prompt as this module's words. The field
 * lists in the messages are the table's own.
 */
function alakHiba(leiro, ertek) {
  const alak = alakOf(leiro)
  switch (alak) {
    case 'string':
    case 'kep':
      return szoveg(ertek) ? null : hibas('nem üres szöveg kell')
    case 'string[]':
    case 'kep[]':
      return Array.isArray(ertek) && ertek.length > 0 && ertek.every(szoveg) ? null : hibas('nem üres szövegek nem üres listája kell')
    case 'number': {
      if (!szam(ertek)) return hibas('véges szám kell')
      if (typeof leiro === 'object' && ((leiro.min !== undefined && ertek < leiro.min) || (leiro.max !== undefined && ertek > leiro.max))) {
        return hibas(`szám kell ${leiro.min} és ${leiro.max} között`)
      }
      return null
    }
    case 'number[]':
      return Array.isArray(ertek) && ertek.length > 0 && ertek.every(szam) ? null : hibas('véges számok nem üres listája kell')
    case 'boolean':
      return typeof ertek === 'boolean' ? null : hibas('true vagy false kell')
    case 'enum':
      return typeof ertek === 'string' && leiro.ertekek.includes(ertek) ? null : { code: 'prop_ertek_ismeretlen', message: `pontosan ezek egyike kell: ${leiro.ertekek.join(', ')}` }
    case 'objektum[]': {
      if (!Array.isArray(ertek) || ertek.length === 0) return hibas('objektumok nem üres listája kell')
      const mezoNevek = Object.keys(leiro.mezok)
      for (let i = 0; i < ertek.length; i += 1) {
        const elem = ertek[i]
        if (!elem || typeof elem !== 'object' || Array.isArray(elem)) return hibas(`${i}. elem: objektum kell`)
        for (const [mezo, mezoAlak] of Object.entries(leiro.mezok)) {
          const opcionalis = mezoAlak.endsWith('?')
          if (!Object.hasOwn(elem, mezo) || elem[mezo] === undefined) {
            if (opcionalis) continue
            return hibas(`${i}. elem: hiányzik a(z) ${mezo} mező`)
          }
          const h = alakHiba(mezoAlak.replace(/\?$/, ''), elem[mezo])
          if (h) return hibas(`${i}. elem.${mezo}: ${h.message}`)
        }
        for (const mezo of Object.keys(elem)) {
          if ((leiro.tiltott || []).includes(mezo)) return { code: 'prop_nem_kuldheto', message: `${i}. elem.${mezo}: React-csomópont, JSON-ból nem küldhető; hagyd el, az elem e mező nélkül használható` }
          if (!Object.hasOwn(leiro.mezok, mezo)) return hibas(`${i}. elem: ismeretlen mező; a mezők: ${mezoNevek.join(', ')}`)
        }
      }
      return null
    }
    default:
      return hibas(`a kit-tábla alakja ismeretlen: ${String(alak)}`)
  }
}

/**
 * null when the value fits the table's shape for that prop; otherwise the
 * refusal. The type and the prop must be in the table: a caller that has
 * not checked that first gets a plain Error, because asking the table about
 * a prop it does not have is a bug at the call site, not a value to refuse.
 */
export function ellenorizProp(tipus, nev, ertek) {
  const tabla = tablaOf(tipus)
  const leiro = tabla ? leiroOf(tabla, nev) : null
  if (leiro === null) throw new Error('ellenorizProp: the type or the prop is not in KIT_TABLA')
  if (leiro === NEM) return { code: 'prop_nem_kuldheto', message: 'React-csomópont, JSON-ból nem küldhető; a jelenet e prop nélkül használható' }
  return alakHiba(leiro, ertek)
}

/** A public/-relative path: letters, digits, dot, underscore, dash, forward slashes between segments; no leading slash. */
const ASSET_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

/**
 * The one place text becomes a path (spec 4.2.2).
 *
 * The value is stored exactly as given, so the only accepted form is one that
 * is already normalised: public/-relative, forward slashes, ASCII names, no
 * `.` or `..` segment, no leading slash, no backslash, colon, space or
 * control character. Every one of the Remotion project's public/ files fits
 * that form today; a name that does not is refused, not rewritten.
 *
 * Existence is checked segment by segment against a directory listing, not
 * by opening the path: a case-insensitive filesystem would find `Kep.png`
 * for `kep.png` and a Linux host would not, and this module promises the
 * same verdict on both. The realpath check catches a symlink inside public/
 * that points outside it. The sha256 of the file goes onto the plan's
 * fingerprint, so a picture swapped after the verdict is a different plan.
 *
 * Messages name the prop's position, never the path: the path is text an
 * agent wrote.
 */
export function assetUtvonal(remotionDir, ertek) {
  if (typeof ertek !== 'string' || !ASSET_RE.test(ertek) || ertek.split('/').some((s) => s === '.' || s === '..')) {
    return { code: 'asset_utvonal_ervenytelen', message: 'public/-relatív útvonal kell: / elválasztóval, latin betű, szám, pont, kötőjel és aláhúzás; nem lehet üres, abszolút, ./ vagy ../ kezdetű' }
  }
  const publicDir = path.resolve(remotionDir, 'public')
  let realPublic
  try {
    realPublic = fs.realpathSync(publicDir)
  } catch {
    return { code: 'asset_hianyzik', message: 'a Remotion-projektben nincs public/ könyvtár' }
  }
  let current = publicDir
  for (const segment of ertek.split('/')) {
    let entries
    try {
      entries = fs.readdirSync(current)
    } catch {
      return { code: 'asset_hianyzik', message: 'nincs ilyen fájl a public/ alatt (pontosan ezzel a névvel, kis- és nagybetűre is)' }
    }
    if (!entries.includes(segment)) return { code: 'asset_hianyzik', message: 'nincs ilyen fájl a public/ alatt (pontosan ezzel a névvel, kis- és nagybetűre is)' }
    current = path.join(current, segment)
  }
  let real
  try {
    real = fs.realpathSync(current)
  } catch {
    return { code: 'asset_hianyzik', message: 'a public/ alatti bejegyzés nem oldható fel fájlra' }
  }
  if (!real.startsWith(realPublic + path.sep)) return { code: 'asset_utvonal_ervenytelen', message: 'a public/ könyvtáron kívülre mutat' }
  if (!fs.statSync(real).isFile()) return { code: 'asset_hianyzik', message: 'nem reguláris fájl a public/ alatt' }
  return { utvonal: ertek, sha256: sha256(fs.readFileSync(real)) }
}
