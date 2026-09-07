import { rangsor } from './attention.mjs'

/**
 * A négy küszöb, a tárral és a beállításokkal összekötve.
 *
 * `attention.mjs` marad tiszta és import-mentes -- a rangsor a rendszer
 * hangja, és egy táblázatos, adatbázis nélküli teszt olcsón fogja meg, ha
 * rosszul sorrendez. Ez a fájl a varrat: itt találkozik a repó, a CRM-1
 * beállításai és az óra. A repót ide importálni pont azt törné el, amit a
 * pure modul dokumentációja kimond.
 */

/** A négy küszöb alapértéke. A CRM-1 settingsFields-e ugyanezeket hirdeti. */
export const ALAP_KUSZOBOK = Object.freeze({
  nemaNapok: 9, valaszNapok: 3, igeretNapok: 2, idegenIgeretNapok: 7,
})

/**
 * A beállított küszöbök, alapértékkel kitöltve.
 *
 * Egy kiürített mező NEM nulla: az operátor törölte, nem azt kérte, hogy
 * mindenre azonnal szóljunk. A `Number` üres stringre `0`-t ad, ezért kell a
 * kifejezett `Number.isFinite` és a pozitivitás-ellenőrzés -- egy
 * `Number(x) ?? alapertek` a `0`-t érvényes küszöbnek nézné.
 */
export function kuszobokOf(settings) {
  const s = settings ? settings() : {}
  const olvas = (kulcs) => {
    const n = Number(s[kulcs])
    return Number.isFinite(n) && n > 0 ? n : ALAP_KUSZOBOK[kulcs]
  }
  return {
    nemaNapok: olvas('nemaNapok'),
    valaszNapok: olvas('valaszNapok'),
    igeretNapok: olvas('igeretNapok'),
    idegenIgeretNapok: olvas('idegenIgeretNapok'),
  }
}

const kivon = (most, napok) => new Date(Date.parse(most) - napok * 86400000).toISOString()

export function createAttention(state) {
  const repo = () => {
    if (!state.repo) throw new Error('crm_nincs_tar')
    return state.repo
  }

  return {
    /**
     * A rangsorolt figyelem-lista. Négy lekérdezés és egy rendezés --
     * egyetlen modellhívás nélkül.
     *
     * Az `osszes` a limitálás előtti sorszám: enélkül az operátor vagy az
     * ügynök öt sort látva nem tudná megkülönböztetni, hogy az az egész
     * lista, vagy csak a teteje egy száznak.
     */
    list({ limit = 50, most = new Date().toISOString() } = {}) {
      const r = repo()
      const k = kuszobokOf(state.settings)
      const sorok = rangsor({
        silent: r.silentDeals(kivon(most, k.nemaNapok)),
        unanswered: r.unansweredThreads(kivon(most, k.valaszNapok)),
        oursOverdue: r.openCommitmentsOlderThan(kivon(most, k.igeretNapok), 'ours'),
        theirsOverdue: r.openCommitmentsOlderThan(kivon(most, k.idegenIgeretNapok), 'theirs'),
      }, most)
      return { sorok: sorok.slice(0, limit), kuszobok: k, osszes: sorok.length }
    },
  }
}
