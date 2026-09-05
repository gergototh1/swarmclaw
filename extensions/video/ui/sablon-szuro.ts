import type { Prop } from './api'

/**
 * The gallery's filtering, with no DOM and no React in it.
 *
 * Split out for the reason `idovonal-state.ts` is: the question "which of the
 * twenty-four cards does this filter row leave standing" is arithmetic over
 * five plain fields, and a test that has to render a grid to ask it would be
 * measuring the grid instead. The view keeps the `Szuro` in state, hands it
 * here with what the catalogue said, and draws the answer.
 */

export type Kuldhetoseg = 'mind' | 'kuldheto' | 'nem'
export type Hasznalat = 'mind' | 'hasznalt' | 'nem'
export type Elonezet = 'mind' | 'van' | 'nincs'

export interface Szuro {
  kereses: string
  kuldhetoseg: Kuldhetoseg
  hasznalat: Hasznalat
  elonezet: Elonezet
}

export const URES_SZURO: Szuro = { kereses: '', kuldhetoseg: 'mind', hasznalat: 'mind', elonezet: 'mind' }

/**
 * Accent-insensitive, case-insensitive normalisation.
 *
 * The catalogue's prose is Hungarian and the operator types Hungarian, but
 * the prose in `katalogus.generated.json` is written without accents while a
 * search for "atvezeto" and one for "átvezető" must find the same card. NFD
 * splits a letter from its accent and the range strips the accents.
 */
export const normal = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * What the three toggles are asked about, exactly as `templates` and
 * `templatePreviewStatus` answered.
 *
 * EVERY LIST HERE MAY BE NULL, and null is not an empty list: it is the page
 * saying it does not know. `kuldheto` is null when the `templates` field did
 * not survive its shape check, `hasznalat` is null without a catalogue, and
 * `vanKep` is null before `templatePreviewStatus` has answered. A dimension
 * nobody measured CANNOT NARROW: the filter passes everything on it, and the
 * view disables that control and says why, so the operator is never able to
 * ask a question whose answer would be invented. The alternative -- matching
 * nothing -- would empty the grid over an unrelated missing field, which is
 * the one thing an empty grid must never mean.
 */
export interface SzuroForras {
  /** The catalogue's own type order; the result keeps it. */
  tipusok: string[]
  leirasok: Record<string, string> | null
  propok: Record<string, Prop[]> | null
  /** The types a plan may send as JSON, per the kit table. */
  kuldheto: string[] | null
  /** `sablonStat[tipus].hasznalat`, per type. */
  hasznalat: Record<string, number> | null
  /** The types the preview cache already holds. */
  vanKep: string[] | null
}

/**
 * The haystack one card is searched in: its type name, the catalogue's
 * sentence about it, and the names of its props.
 *
 * The prop `mit` sentences are deliberately NOT in it. They are the longest
 * text on the card and searching them would make a two-letter query match
 * most of the kit, which is a filter that has stopped narrowing. The panel
 * shows them; the search finds the card by what it is called.
 */
function szoveg(forras: SzuroForras, tipus: string): string {
  const leiras = forras.leirasok?.[tipus] ?? ''
  const propnevek = (forras.propok?.[tipus] ?? []).map((p) => p.nev).join(' ')
  return normal(`${tipus} ${leiras} ${propnevek}`)
}

/** The types that pass every filter, in the catalogue's own order. */
export function szurtTipusok(forras: SzuroForras, szuro: Szuro): string[] {
  const kereses = normal(szuro.kereses.trim())
  const kuldheto = forras.kuldheto === null ? null : new Set(forras.kuldheto)
  const vanKep = forras.vanKep === null ? null : new Set(forras.vanKep)
  return forras.tipusok.filter((tipus) => {
    if (kereses !== '' && !szoveg(forras, tipus).includes(kereses)) return false
    if (szuro.kuldhetoseg !== 'mind' && kuldheto !== null) {
      if (kuldheto.has(tipus) !== (szuro.kuldhetoseg === 'kuldheto')) return false
    }
    if (szuro.hasznalat !== 'mind' && forras.hasznalat !== null) {
      const db = forras.hasznalat[tipus] ?? 0
      if (db > 0 !== (szuro.hasznalat === 'hasznalt')) return false
    }
    if (szuro.elonezet !== 'mind' && vanKep !== null) {
      if (vanKep.has(tipus) !== (szuro.elonezet === 'van')) return false
    }
    return true
  })
}
