import { useCallback, useEffect, useState } from 'react'

import type { NaptarAdat, NaptarKiadas, Rpc } from './api'
import { errText, readNaptar } from './api'

/**
 * The weekly calendar: design spec 8's page.
 *
 * ONE ENTRY PER RELEASE, FOUR PLATFORM FLAGS -- NOT FOUR ENTRIES. `Bejegyzes`
 * below renders exactly one `.pub-bejegyzes` per release, with its branches
 * drawn as flags inside it; `test/ui.test.mjs`'s first calendar test pins the
 * count.
 *
 * THE WORKFLOW STATE IS ALWAYS THE STORED COLUMN, NEVER SOMETHING THIS FILE
 * COMPUTES. `kiadas.allapot` (`ui/api.ts`'s `NaptarKiadas`) is
 * `ext_publish_kiadasok.allapot` -- eight words, `KIADAS_ALLAPOTOK`
 * (src/db.mjs) -- five of which double as the outcome `kiadasAllapot`
 * (src/allapot.mjs) computes and `publishDue` (src/szoveg.mjs) writes back
 * onto this SAME column once a release has actually been dispatched. This
 * file never calls that function and never derives an outcome of its own: it
 * reads `kiadas.allapot` and nothing else decides which sentence
 * `KIADAS_CIMKE` below prints. The distinction constraints.md and
 * `src/allapot.mjs`'s own docblock draw -- "the page reads the stored column
 * for the first and calls the function for the second" -- holds here because
 * `publishDue` is the only writer of the outcome half, and this page is
 * never that writer: a click here (`jovahagy`, `src/rpc.mjs`) only ever moves
 * a release through the WORKFLOW arrow (`lektoralt -> jovahagyva -> utemezve`),
 * never assigns it `kesz`/`reszben`/`hiba`/`nincs_hova` on its own say-so.
 *
 * `nincs_hova` IS NOT `kesz`, AND THIS FILE MUST NOT BLUR THEM (design spec
 * 5, task-6-brief.md's own fourth test). `KIADAS_CIMKE.nincs_hova` therefore
 * carries its own sentence rather than falling back to a generic "nem ment
 * ki" that could be mistaken for `kesz`'s wording -- the fourth calendar test
 * pins that its sentence appears and `KIADAS_CIMKE.kesz`'s does not.
 *
 * DRAG, NOT BUILT: design spec 8 says a release is "áthúzható másik sávba,
 * amíg nem ment ki". `src/rpc.mjs`'s `atutemez` is the write side of that
 * (the operator's manual `felulirt_idopont` override), and it is reachable
 * from the detail view (`ui/kiadas.tsx`) as a typed instant rather than as a
 * native drag gesture here. Two reasons, not one: this project's own test
 * harness (`test/ui.test.mjs`, copied from `extensions/video/test/ui.test.mjs`)
 * has no DOM and cannot drive `dragstart`/`drop` at all, so a drag target
 * built here would be the one control in this module nothing exercises; and
 * `Bejegyzes` below is deliberately a plain `<button>` -- native HTML5 drag
 * sources are not reliably keyboard-operable, and a calendar whose only way
 * to reschedule a release is a mouse gesture would regress every other
 * control on this page, all of which are buttons and forms. The functional
 * requirement (move a release to a different instant while it has not gone
 * out) is met either way.
 */

/** The eight workflow/outcome words `kiadas.allapot` may hold, and the sentence each gets. Copied 1:1 against `KIADAS_ALLAPOTOK` (src/db.mjs) so a word this page does not recognise falls through to its own raw text rather than a guess. */
export const KIADAS_CIMKE: Record<string, string> = {
  vazlat: 'Vázlat — jóváhagyásra vár',
  lektoralt: 'Lektorálva — jóváhagyásra vár',
  jovahagyva: 'Jóváhagyva — ütemezésre vár',
  utemezve: 'Ütemezve',
  kesz: 'Kiment',
  reszben: 'Részben ment ki',
  hiba: 'Hiba — egyik platformra sem ment ki',
  nincs_hova: 'Egyetlen platform sincs összekötve',
}

/** The four branch words `AG_ALLAPOTOK` (src/db.mjs) spells, and design spec 8's own four labels for them ("kiment / vár / elbukott / nincs fiók"). */
const AG_CIMKE: Record<string, string> = {
  var: 'vár',
  kesz: 'kiment',
  hiba: 'elbukott',
  nincs_fiok: 'nincs fiók',
}

export const PLATFORM_CIMKE: Record<string, string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
}

const NAP_NEV = ['Vasárnap', 'Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat']

/**
 * A stored ISO instant, formatted TZ-independently (the machine's own `TZ`
 * must never change what this page draws -- `src/utemezes.mjs`'s file
 * docblock states the same requirement for the arithmetic itself, and
 * `npm test` runs under `TZ=UTC` and `TZ=Pacific/Kiritimati` for exactly this
 * reason). `toISOString` reads the instant's own UTC fields regardless of the
 * runtime's local zone, which is enough for an operator-facing label: the
 * exact wall-clock rendering in the module's configured zone is not this
 * function's job.
 */
function formatIdopont(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * The slip design spec 7 names out loud: a release due at its `idopont` goes
 * out at the first fixed-cadence run at or after it, up to a quarter hour
 * later -- "A naptár ezt ki is mondja: a kért időpont mellett az, hogy melyik
 * futás fogja kitenni." A calendar that promised the minute and missed it by
 * fifteen would be worse than one that states its own precision; this is
 * that statement, not a bug report.
 */
export function idopontSzoveg(idopont: string | null): string | null {
  if (idopont === null) return null
  return `${formatIdopont(idopont)} körül — a következő 15 perces futás teszi ki, legfeljebb negyed óra csúszással`
}

/**
 * The weekday this release's `idopont` falls on, in the module's configured
 * zone -- `Intl.DateTimeFormat` with a `timeZone` option, the same mechanism
 * `src/utemezes.mjs`'s own conversion uses, so a release near midnight in
 * the operator's zone lands under the day the operator would actually read
 * off a wall calendar rather than under UTC's.
 */
export function napIndexZonaban(idopont: string, zona: string): number | null {
  const d = new Date(idopont)
  if (Number.isNaN(d.getTime())) return null
  const MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: zona, weekday: 'short' }).format(d)
    return wd in MAP ? MAP[wd] : null
  } catch {
    return null
  }
}

/**
 * One release, one entry, four platform flags. Rendered directly to static
 * markup by `test/ui.test.mjs` -- the css classes below are deliberately
 * distinct PREFIXES (`pub-allapot`, `pub-ido`, `pub-jelzo`, none of them
 * starting with the literal string `pub-bejegyzes-`) so a test counting
 * occurrences of `pub-bejegyzes` in the rendered html counts this ONE root
 * element and nothing nested inside it.
 */
export function Bejegyzes({ kiadas, onOpen }: { kiadas: NaptarKiadas; onOpen?: (kiadasId: string) => void }) {
  const cimke = KIADAS_CIMKE[kiadas.allapot] ?? kiadas.allapot
  const idoSzoveg = idopontSzoveg(kiadas.idopont)
  const felulirva = kiadas.felulirtIdopont !== null
  return (
    <button
      type="button"
      className="pub-bejegyzes"
      data-kiadas-id={kiadas.kiadasId}
      data-allapot={kiadas.allapot}
      onClick={() => onOpen?.(kiadas.kiadasId)}
    >
      <span className="pub-allapot">{cimke}</span>
      {idoSzoveg !== null && <span className="pub-ido">{idoSzoveg}</span>}
      {felulirva && <span className="pub-felulirva">az operátor kézzel állította át az időpontot</span>}
      <span className="pub-jelzok">
        {kiadas.agak.map((a) => (
          <span key={a.platform} className={`pub-jelzo pub-jelzo-${a.allapot}`} data-platform={a.platform}>
            {(PLATFORM_CIMKE[a.platform] ?? a.platform)}: {AG_CIMKE[a.allapot] ?? a.allapot}
          </span>
        ))}
      </span>
    </button>
  )
}

function Nap({ index, adat, onOpen }: { index: number; adat: NaptarAdat; onOpen: (kiadasId: string) => void }) {
  const savok = adat.savok.filter((s) => s.nap === index)
  const kiadasok = adat.kiadasok.filter((k) => k.idopont !== null && napIndexZonaban(k.idopont, adat.idozona) === index)
  return (
    <div className="pub-nap" data-nap={index}>
      <h3>{NAP_NEV[index]}</h3>
      <p className="pub-savok">
        {savok.length === 0
          ? 'Nincs sáv ezen a napon.'
          : `Sávok: ${savok.map((s) => `${String(s.ora).padStart(2, '0')}:${String(s.perc).padStart(2, '0')}`).join(', ')}`}
      </p>
      {kiadasok.length === 0
        ? <p className="pub-ures">Nincs ide sorolt kiadás.</p>
        : kiadasok.map((k) => <Bejegyzes key={k.kiadasId} kiadas={k} onOpen={onOpen} />)}
    </div>
  )
}

export function NaptarBody({ adat, hiba, onOpen, onFrissit }: {
  adat: NaptarAdat | null
  hiba: string | null
  onOpen: (kiadasId: string) => void
  onFrissit: () => void
}) {
  const idopontNelkul = adat?.kiadasok.filter((k) => k.idopont === null) ?? []
  return (
    <section className="pub-naptar">
      <div className="pub-naptar-fejlec">
        <h2>Naptár</h2>
        <button type="button" className="pub-btn pub-btn-small" onClick={onFrissit}>Frissítés</button>
      </div>
      {hiba !== null && <p className="pub-hiba" role="alert">{hiba}</p>}
      {adat === null && hiba === null && <p className="pub-halvany">Betöltés folyamatban.</p>}
      {adat !== null && (
        <div className="pub-hetirend">
          {NAP_NEV.map((_, index) => <Nap key={index} index={index} adat={adat} onOpen={onOpen} />)}
          <div className="pub-nap pub-nap-idopontnelkul">
            <h3>Időpont nélkül</h3>
            {idopontNelkul.length === 0
              ? <p className="pub-ures">Nincs időpont nélküli kiadás.</p>
              : idopontNelkul.map((k) => <Bejegyzes key={k.kiadasId} kiadas={k} onOpen={onOpen} />)}
          </div>
        </div>
      )}
    </section>
  )
}

export function NaptarNezet({ rpc, onOpen }: { rpc: Rpc; onOpen: (kiadasId: string) => void }) {
  const [adat, setAdat] = useState<NaptarAdat | null>(null)
  const [hiba, setHiba] = useState<string | null>(null)

  const tolt = useCallback(() => {
    rpc('naptar')
      .then((raw) => { setAdat(readNaptar(raw)); setHiba(null) })
      .catch((err: unknown) => setHiba(errText(err)))
  }, [rpc])

  useEffect(() => { tolt() }, [tolt])

  return <NaptarBody adat={adat} hiba={hiba} onOpen={onOpen} onFrissit={tolt} />
}
