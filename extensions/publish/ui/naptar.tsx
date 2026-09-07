import { useCallback, useEffect, useState } from 'react'

import type { NaptarAdat, NaptarKiadas, Rpc } from './api'
import { errText, readNaptar, refusalText } from './api'

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
 * THE SLOTS ARE OPERATOR DATA, AND THIS IS THE ONLY PLACE THEY CAN BE
 * CREATED. Design spec 8's "a szabad sávok láthatók" was implemented as seven
 * columns that each printed "Nincs sáv ezen a napon." -- true on every real
 * install, because `repo.ujSav` (src/db.mjs) had no caller in production code
 * anywhere: no rpc, no tool, no settings field. A slot cannot be a settings
 * field (it is a row, and there are several of them), and it must not be
 * seeded by the migration (a migration writes schema, not content), so the
 * page is where it has to come from. `Nap` below therefore carries an add
 * control and a delete control per slot, and `UresNaptar` offers the starter
 * set `ALAP_SAVOK` (src/rpc.mjs) in one click so a fresh install is not a
 * blank the operator has to guess at.
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

/**
 * The four branch words `AG_ALLAPOTOK` (src/db.mjs) spells, and design spec
 * 8's own four labels for them ("kiment / vár / elbukott / nincs fiók").
 *
 * Exported, and `ui/kiadas.tsx` imports it from here rather than keeping the
 * second copy it used to carry: two hand-written tables of the same four
 * words drift, and the drift is invisible -- the detail view would go on
 * printing "elbukott" while the calendar had been taught to say something
 * else about the identical row. `test/ui.test.mjs` holds THIS table against
 * `AG_ALLAPOTOK` itself, so a fifth branch word added to the database fails
 * there instead of falling through to its own raw text on the page.
 */
export const AG_CIMKE: Record<string, string> = {
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

/**
 * Every code that can land in `ext_publish_agak.hiba_kod`, and the sentence
 * that says what to DO about it.
 *
 * THE MODULE SPENT SIX TASKS MAKING EVERY REFUSAL A CODE AND A SENTENCE
 * (constraints.md: "az elutasítás MEGNEVEZETT: kód és mondat, ami megmondja,
 * mi a teendő") -- and then dropped the sentence on the last metre, on the
 * ONE screen where any of it reaches a human: `ui/kiadas.tsx` printed the
 * bare `hibaKod`. `gyerekeknek_nincs_beallitva` is a settings field the
 * operator has to go and set; as a bare word on a page it is a puzzle. This
 * table is the sibling `AG_CIMKE`/`KIADAS_CIMKE`/`PLATFORM_CIMKE` were always
 * next to.
 *
 * THE CODE STILL SHOWS, BESIDE THE SENTENCE, NEVER INSTEAD OF IT. The code is
 * what the operator can quote, search the logs for and hand to someone else;
 * the sentence is what tells them where to click. Both, or the half that is
 * missing is the half they needed. A code with no entry here falls through to
 * itself alone rather than to a guess -- the same fallback every other table
 * on this page uses.
 *
 * The codes come from two places and the test holds this table against both:
 * `publishDue`'s own four (src/szoveg.mjs) and everything
 * `src/platform/youtube.mjs` raises.
 */
export const HIBA_CIMKE: Record<string, string> = {
  adapter_nincs: 'Ehhez a platformhoz nincs bekötött küldő ebben a modulban. Ma csak a YouTube megy ki; a másik három a platform saját engedélyére vár.',
  video_nem_qa_ok: 'A videó a jóváhagyás óta kikerült a kész (qa_ok) állapotból, ezért nem ment ki. Nézd meg a videót a Videó lapon, és ha újra kész, tedd vissza sorba ezt az ágat.',
  szerzodes_hianyzik: 'A Videó bővítmény nem volt elérhető a kiküldés pillanatában, így a modul nem tudta ellenőrizni a videót. Nézd meg a Bővítmények lapon, hogy fut-e.',
  kikuldes_hiba: 'A küldő olyan hibára futott, amire nincs saját neve. A modul naplója mondja meg, mi történt.',
  kiadas_allapot_ismeretlen: 'A kiadás ágai olyan állapotba kerültek, amit ez a verzió nem tud összegezni. Ez a modul hibája; a napló mondja meg, melyik ág az.',
  fiok_nincs_osszekotve: 'Nincs bekötve Google-fiók a publikáláshoz. A Fiókok lapon kösd be, aztán tedd vissza sorba ezt az ágat.',
  no_credential: 'Nincs bekötve Google-fiók a publikáláshoz. A Fiókok lapon kösd be, aztán tedd vissza sorba ezt az ágat.',
  fiok_hitelesites_hiba: 'A YouTube visszautasította a hozzáférést. Kösd be újra a Google-fiókot a Fiókok lapon.',
  gyerekeknek_nincs_beallitva: 'A YouTube minden feltöltésnél megköveteli a COPPA-nyilatkozatot, és ezt a modul nem dönti el helyetted: állítsd be a bővítmény beállításai közt a "Gyerekeknek készült tartalom" mezőt, aztán tedd vissza sorba ezt az ágat.',
  lathatosag_ervenytelen: 'A "YouTube láthatóság" beállítás nem az engedett három érték egyike. Állítsd át a bővítmény beállításai közt.',
  kvota_elfogyott: 'A mai YouTube-kvóta elfogyott. Holnap tedd vissza sorba ezt az ágat; addig nem megy ki.',
  video_fajl_hianyzik: 'A videóhoz nem tartozik feltölthető fájl. Nézd meg a Videó lapon, hogy elkészült-e a render.',
  video_fajl_olvashatatlan: 'A videó fájlja nem olvasható a lemezről. Nézd meg, megvan-e még, aztán tedd vissza sorba ezt az ágat.',
  tarolt_ertek_olvashatatlan: 'Az ághoz mentett szöveg nem olvasható vissza. Írasd meg újra a Publikálás Író ügynökkel.',
  szoveg_hianyzik: 'Ehhez az ághoz nincs megírt szöveg. Írasd meg a Publikálás Író ügynökkel.',
  feltoltes_elutasitva: 'A YouTube visszautasította a feltöltést. A modul naplója hordozza a választ; javítsd, amit megnevez, aztán tedd vissza sorba ezt az ágat.',
  feltoltes_atviteli_hiba: 'A feltöltés a hálózaton szakadt meg. Tedd vissza sorba ezt az ágat, és a következő futás újra próbálja.',
  feltoltes_idotullepes: 'A feltöltés túllépte az időkeretet. Tedd vissza sorba ezt az ágat, és a következő futás újra próbálja.',
  feltoltes_valasz_ertelmezhetetlen: 'A YouTube olyan választ adott, amit a modul nem tud értelmezni. A napló hordozza; szólj az operátornak.',
  argumentum_hibas: 'A küldő hiányos adatot kapott a kiadástól. Nézd meg a platform szövegét, és írasd meg újra, ami hiányzik.',
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

/**
 * The form state behind the seven "Sáv hozzáadása" buttons: which day's form
 * is open, and what is typed in it. ONE form at a time, held by
 * `NaptarNezet` and rendered inside whichever day column it belongs to --
 * seven independent form states would be seven ways for a half-typed hour to
 * survive somewhere the operator cannot see it.
 *
 * `ora`/`perc` are STRINGS because that is what an `<input>` holds; the
 * conversion to numbers (and the refusal for an empty box, which must not
 * become midnight) happens once, in `szamOrNaN` below, at the moment of the
 * call.
 */
export interface SavUrlap {
  nap: number | null
  ora: string
  perc: string
}

/**
 * An input's text as a number, with an EMPTY box deliberately becoming `NaN`
 * rather than `0`.
 *
 * `Number('')` is `0`, so an operator who cleared the hour box and pressed
 * Mentés would silently declare a midnight slot -- a real publishing time,
 * written as if they had chosen it. `NaN` is not an integer, so
 * `savotFelvesz` (src/rpc.mjs) refuses it by name and the page prints the
 * module's own sentence about the allowed range.
 */
function szamOrNaN(raw: string): number {
  return raw.trim() === '' ? Number.NaN : Number(raw)
}

const ketJegy = (n: number) => String(n).padStart(2, '0')

/**
 * One day column: its declared slots (each with its own delete button), the
 * control that adds another, and the releases that fall on it.
 *
 * THE BUTTON IS IN THE DAY, not in a form somewhere above the week. Before
 * this task's fix round the seven columns each printed "Nincs sáv ezen a
 * napon." with nothing under it and no control anywhere in the module that
 * could create one -- which is what made every approval end in
 * `nincs_szabad_sav` on a real install (`src/rpc.mjs`'s docblock has the
 * whole chain). The sentence stays; the button is now beside it.
 */
function Nap({ index, adat, onOpen, savUrlap, kuldes, onSavUrlapNyit, onSavOra, onSavPerc, onSavFelvesz, onSavTorol }: {
  index: number
  adat: NaptarAdat
  onOpen: (kiadasId: string) => void
  savUrlap: SavUrlap
  kuldes: boolean
  onSavUrlapNyit: (nap: number | null) => void
  onSavOra: (ora: string) => void
  onSavPerc: (perc: string) => void
  onSavFelvesz: () => void
  onSavTorol: (savId: string) => void
}) {
  const savok = adat.savok.filter((s) => s.nap === index)
  const kiadasok = adat.kiadasok.filter((k) => k.idopont !== null && napIndexZonaban(k.idopont, adat.idozona) === index)
  const urlapNyitva = savUrlap.nap === index
  return (
    <div className="pub-nap" data-nap={index}>
      <h3>{NAP_NEV[index]}</h3>
      {savok.length === 0
        ? <p className="pub-savok pub-halvany">Nincs sáv ezen a napon.</p>
        : (
          <ul className="pub-sav-lista">
            {savok.map((s) => (
              <li key={s.id} className="pub-sav" data-sav-id={s.id}>
                <span className="pub-sav-ido">{ketJegy(s.ora)}:{ketJegy(s.perc)}</span>
                <button
                  type="button"
                  className="pub-btn pub-btn-small"
                  disabled={kuldes}
                  onClick={() => onSavTorol(s.id)}
                >
                  Sáv törlése
                </button>
              </li>
            ))}
          </ul>
        )}
      {urlapNyitva
        ? (
          <form className="pub-sav-urlap" onSubmit={(e) => { e.preventDefault(); onSavFelvesz() }}>
            <label>
              Óra
              <input
                type="number"
                min={0}
                max={23}
                value={savUrlap.ora}
                onChange={(e) => onSavOra(e.target.value)}
                aria-label={`Óra — ${NAP_NEV[index]}`}
              />
            </label>
            <label>
              Perc
              <input
                type="number"
                min={0}
                max={59}
                value={savUrlap.perc}
                onChange={(e) => onSavPerc(e.target.value)}
                aria-label={`Perc — ${NAP_NEV[index]}`}
              />
            </label>
            <button type="submit" disabled={kuldes}>Sáv mentése</button>
            <button type="button" className="pub-btn pub-btn-small" onClick={() => onSavUrlapNyit(null)}>Mégsem</button>
          </form>
        )
        : (
          <button
            type="button"
            className="pub-btn pub-btn-small pub-sav-hozzaad"
            disabled={kuldes}
            onClick={() => onSavUrlapNyit(index)}
          >
            Sáv hozzáadása
          </button>
        )}
      {kiadasok.length === 0
        ? <p className="pub-ures">Nincs ide sorolt kiadás.</p>
        : kiadasok.map((k) => <Bejegyzes key={k.kiadasId} kiadas={k} onOpen={onOpen} />)}
    </div>
  )
}

/**
 * The zero-slot install's one click, and the sentence that says why it is
 * offered at all.
 *
 * CLAUDE.md's "okos alapértékek -- sose hagyj üresen" against a screen where
 * the host has no `defaultValue` to give: a slot is a database row, not a
 * settings field. A fresh install would otherwise open on seven empty days,
 * with the operator left to work out that a publishing slot is even the thing
 * standing between an approved release and a scheduled one. `ALAP_SAVOK`
 * (src/rpc.mjs) is that guess made out loud, as an offer rather than as
 * seeded data -- its docblock says why the migration is the wrong place for
 * it -- and every one of the three is editable and deletable the moment it
 * lands.
 */
function UresNaptar({ kuldes, onAlapSavok }: { kuldes: boolean; onAlapSavok: () => void }) {
  return (
    <div className="pub-ures-naptar">
      <p>
        Egyetlen publikálási sáv sincs beállítva. Amíg nincs, a jóváhagyott kiadások nem kapnak
        időpontot, és a 15 perces futásnak sosem lesz mit kitennie.
      </p>
      <button type="button" disabled={kuldes} onClick={onAlapSavok}>
        Alap sávkészlet felvétele (hétfő, szerda, péntek 18:00)
      </button>
      <p className="pub-halvany">
        Ezt utána szabadon szerkesztheted: bármelyik sáv törölhető, és bármelyik naphoz vehető fel másik.
      </p>
    </div>
  )
}

/**
 * A release only ever reaches this calendar because an AGENT opened it, and
 * an empty page never said so.
 *
 * `publishOpen` (src/szoveg.mjs) is a tool on the Publikálás Író agent's list
 * and on nothing else: there is no rpc, no button and no form anywhere in
 * this module that opens a release from a finished video. That is a
 * deliberate division (the writer needs the video's narration in the same
 * call it opens with, which is an agent's read, not a form's), but it left a
 * page that showed seven empty columns and no clue at all about where a
 * release comes from -- the operator's next move was unguessable. This
 * sentence is that move, written down.
 */
function NincsKiadas() {
  return (
    <p className="pub-nincs-kiadas">
      Egyetlen kiadás sincs ezen a héten. Kiadás nem ezen a lapon születik: egy kész (qa_ok) videóból a
      <strong> Publikálás Író</strong> ügynök nyitja meg, ha beszélsz vele — utána a Publikálás Lektor nézi át,
      és a kiadás itt jelenik meg jóváhagyásra.
    </p>
  )
}

/**
 * Which week is on screen, and the two buttons that step off it.
 *
 * The instants come from the module (`src/rpc.mjs`'s `naptar`) and are handed
 * straight back: a week is seven WALL-CLOCK days in the module's configured
 * zone, and a page doing that arithmetic itself would drift by an hour across
 * every DST change. `ui/api.ts`'s `NaptarAdat` docblock says the same thing
 * from the reading side.
 */
function HetValaszto({ adat, kuldes, onHet }: { adat: NaptarAdat; kuldes: boolean; onHet: (hetKezdet: string) => void }) {
  return (
    <div className="pub-het-valaszto">
      <button type="button" className="pub-btn pub-btn-small" disabled={kuldes} onClick={() => onHet(adat.elozoHetKezdet)}>
        Előző hét
      </button>
      <span className="pub-het-cimke">{formatIdopont(adat.hetKezdet)} — {formatIdopont(adat.hetVege)}</span>
      <button type="button" className="pub-btn pub-btn-small" disabled={kuldes} onClick={() => onHet(adat.kovetkezoHetKezdet)}>
        Következő hét
      </button>
    </div>
  )
}

export function NaptarBody({ adat, hiba, uzenet, kuldes, savUrlap, onOpen, onFrissit, onHet, onSavUrlapNyit, onSavOra, onSavPerc, onSavFelvesz, onSavTorol, onAlapSavok }: {
  adat: NaptarAdat | null
  hiba: string | null
  uzenet: string | null
  kuldes: boolean
  savUrlap: SavUrlap
  onOpen: (kiadasId: string) => void
  onFrissit: () => void
  onHet: (hetKezdet: string) => void
  onSavUrlapNyit: (nap: number | null) => void
  onSavOra: (ora: string) => void
  onSavPerc: (perc: string) => void
  onSavFelvesz: () => void
  onSavTorol: (savId: string) => void
  onAlapSavok: () => void
}) {
  const idopontNelkul = adat?.kiadasok.filter((k) => k.idopont === null) ?? []
  return (
    <section className="pub-naptar">
      <div className="pub-naptar-fejlec">
        <h2>Naptár</h2>
        <button type="button" className="pub-btn pub-btn-small" onClick={onFrissit}>Frissítés</button>
      </div>
      {hiba !== null && <p className="pub-hiba" role="alert">{hiba}</p>}
      {uzenet !== null && <p className="pub-uzenet" role="status">{uzenet}</p>}
      {adat === null && hiba === null && <p className="pub-halvany">Betöltés folyamatban.</p>}
      {adat !== null && (
        <>
          {/*
            The zone travels with the answer (`src/rpc.mjs`'s `naptar`) and is
            printed here rather than kept as a page-side constant: a slot's
            18:00 is a WALL CLOCK reading in the module's configured zone
            (src/utemezes.mjs), so a calendar that showed the numbers without
            naming the clock would be stating a time it cannot actually
            promise.
          */}
          <p className="pub-halvany">
            A sávok a(z) {adat.idozona} zóna fali óráján értendők, nyári időszámítással együtt — nem UTC-ben.
            Egy sáv törlése csak az ezután következő ütemezéseket érinti; a már időpontot kapott kiadások a saját
            időpontjukban mennek ki.
          </p>
          <HetValaszto adat={adat} kuldes={kuldes} onHet={onHet} />
          {adat.savok.length === 0 && <UresNaptar kuldes={kuldes} onAlapSavok={onAlapSavok} />}
          {adat.kiadasok.length === 0 && <NincsKiadas />}
          <div className="pub-hetirend">
            {NAP_NEV.map((_, index) => (
              <Nap
                key={index}
                index={index}
                adat={adat}
                onOpen={onOpen}
                savUrlap={savUrlap}
                kuldes={kuldes}
                onSavUrlapNyit={onSavUrlapNyit}
                onSavOra={onSavOra}
                onSavPerc={onSavPerc}
                onSavFelvesz={onSavFelvesz}
                onSavTorol={onSavTorol}
              />
            ))}
            <div className="pub-nap pub-nap-idopontnelkul">
              <h3>Időpont nélkül</h3>
              {idopontNelkul.length === 0
                ? <p className="pub-ures">Nincs időpont nélküli kiadás.</p>
                : idopontNelkul.map((k) => <Bejegyzes key={k.kiadasId} kiadas={k} onOpen={onOpen} />)}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

/** The starter values the slot form opens with -- an evening, because that is what `ALAP_SAVOK` (src/rpc.mjs) offers and a form that opens on `00:00` would invite a midnight slot nobody meant. */
const URLAP_KEZDO: SavUrlap = { nap: null, ora: '18', perc: '00' }

export function NaptarNezet({ rpc, onOpen }: { rpc: Rpc; onOpen: (kiadasId: string) => void }) {
  const [adat, setAdat] = useState<NaptarAdat | null>(null)
  const [hiba, setHiba] = useState<string | null>(null)
  const [uzenet, setUzenet] = useState<string | null>(null)
  const [kuldes, setKuldes] = useState(false)
  const [savUrlap, setSavUrlap] = useState<SavUrlap>(URLAP_KEZDO)
  /**
   * Which week is being shown, as the instant the module itself produced.
   * `null` is "whichever week now falls in" -- the module decides that, so a
   * page loaded at 23:59 on a Saturday and one loaded a minute later do not
   * disagree about it, and the browser's own clock never enters into which
   * week the module's zone says it is.
   */
  const [hetKezdet, setHetKezdet] = useState<string | null>(null)

  const tolt = useCallback(() => {
    rpc('naptar', hetKezdet === null ? {} : { hetKezdet })
      .then((raw) => { setAdat(readNaptar(raw)); setHiba(null) })
      .catch((err: unknown) => setHiba(errText(err)))
  }, [rpc, hetKezdet])

  useEffect(() => { tolt() }, [tolt])

  /**
   * The three slot levers, which differ only in what they send and what they
   * say afterwards. Written once rather than three times: each one resolves
   * with a NAMED refusal instead of throwing (`src/rpc.mjs`'s `lever`), so
   * all three have to tell the same three outcomes apart -- the refusal the
   * module sent, the success, and a request that never reached the module at
   * all -- and three copies of that would be three places for one of the
   * three to go missing.
   */
  const kuld = useCallback((method: string, args: Record<string, unknown>, mit: string, siker: string) => {
    setKuldes(true)
    rpc(method, args)
      .then((raw) => {
        setKuldes(false)
        const refusal = refusalText(raw)
        if (refusal !== null) { setUzenet(refusal); return }
        setUzenet(siker)
        setSavUrlap(URLAP_KEZDO)
        tolt()
      })
      .catch((err: unknown) => { setKuldes(false); setUzenet(`${mit} el sem jutott a modulhoz: ${errText(err)}`) })
  }, [rpc, tolt])

  const onSavUrlapNyit = useCallback((nap: number | null) => { setSavUrlap((elozo) => ({ ...elozo, nap })) }, [])
  const onSavOra = useCallback((ora: string) => { setSavUrlap((elozo) => ({ ...elozo, ora })) }, [])
  const onSavPerc = useCallback((perc: string) => { setSavUrlap((elozo) => ({ ...elozo, perc })) }, [])

  const onSavFelvesz = useCallback(() => {
    kuld('savotFelvesz', { nap: savUrlap.nap, ora: szamOrNaN(savUrlap.ora), perc: szamOrNaN(savUrlap.perc) },
      'A sáv felvételének kérése', 'Sáv felvéve.')
  }, [kuld, savUrlap])

  const onSavTorol = useCallback((savId: string) => {
    kuld('savotTorol', { savId }, 'A sáv törlésének kérése', 'Sáv törölve.')
  }, [kuld])

  const onAlapSavok = useCallback(() => {
    kuld('alapSavokatFelvesz', {}, 'Az alap sávkészlet kérése', 'Alap sávkészlet felvéve: hétfő, szerda és péntek 18:00.')
  }, [kuld])

  return (
    <NaptarBody
      adat={adat}
      hiba={hiba}
      uzenet={uzenet}
      kuldes={kuldes}
      savUrlap={savUrlap}
      onOpen={onOpen}
      onFrissit={tolt}
      onHet={setHetKezdet}
      onSavUrlapNyit={onSavUrlapNyit}
      onSavOra={onSavOra}
      onSavPerc={onSavPerc}
      onSavFelvesz={onSavFelvesz}
      onSavTorol={onSavTorol}
      onAlapSavok={onAlapSavok}
    />
  )
}
