import { ALAP_IDOZONA, KIADAS_ALLAPOTOK } from './db.mjs'

/**
 * The calendar's arithmetic: which slot an approved release lands in next,
 * and which already-scheduled releases are due right now.
 *
 * SPEC 7'S CONTRADICTION, RESOLVED
 * =================================
 * Design spec 7 names it directly: the host's `ExtensionManagedScheduleDeclaration`
 * (`index.mjs`'s `SCHEDULES`) is a STATIC declaration, fixed at import time --
 * a cron string or an interval, written once, read by the host's own
 * scheduler. The slots in `ext_publish_savok` are OPERATOR DATA: rows an
 * operator adds, edits and removes at any time, through a page a later task
 * builds. A static declaration cannot "become" whatever the operator's
 * slots currently say, and this module has no way to mint or edit a host
 * schedule from inside a tool call -- `index.mjs`'s `SCHEDULES` is read once,
 * at extension load, the same as every sibling module's.
 *
 * So the two stay separate, on purpose, each doing only what it can:
 *
 *   - The DECLARED SCHEDULE runs at a FIX CADENCE (`index.mjs`, default
 *     every 15 minutes) and does not change when the operator edits a slot.
 *     It does not decide WHAT to send, or WHEN a release is due -- it only
 *     decides how often someone comes and asks `esedekes()`.
 *   - The SLOT decides WHEN, for one release: `kovetkezoSzabadSav` turns
 *     "every Monday at 09:00" plus "what's already taken" into one concrete
 *     instant, written onto that release's `idopont` column once (a later
 *     task's job). From that point on the slot has done its job; the row
 *     carries its own `idopont` and the slot pattern is never consulted
 *     again for it.
 *
 * `esedekes()` is the seam between the two: given "now", which
 * already-scheduled releases have a due instant at or before it. It does not
 * care whether that instant came from a slot or from an operator's manual
 * override (design spec 7's "felülírt időpontút egyaránt" -- an overridden
 * time counts exactly the same as a slotted one) -- by the time a release
 * reaches `esedekes()`, both have collapsed onto the same one column.
 *
 * THE COLUMN THIS FILE READS, AND WHY IT IS NOT `felulirt_idopont`
 * ================================================================
 * `esedekes` filters on `ext_publish_kiadasok.idopont`: the release's
 * COMPUTED dispatch instant, written when the release is scheduled, from
 * either a slot or the operator's override. `felulirt_idopont` is a
 * different fact -- the operator's manual override as the operator typed it
 * -- and design spec 3 says the calendar DRAWS BOTH and tells them apart.
 * Collapsing the two into one column would make the calendar unable to show
 * "this one was moved by hand", so they stay two columns and this file reads
 * only the computed one.
 *
 * That column's absence is what an earlier round of this file got wrong, and
 * the failure had no symptom at all: `esedekes()` filtered on a column the
 * migration never created, every row read back carried `undefined` there,
 * every run returned `[]`, and the fixed-cadence schedule woke every fifteen
 * minutes forever to publish nothing -- no throw, no error code, no log
 * line. `test/utemezes.test.mjs` therefore drives this function from ROWS
 * READ BACK OUT OF A REAL DATABASE, not only from object literals: a literal
 * can carry a field the schema does not have, and a stored row cannot.
 *
 * THE SLIP THIS BUYS, AND WHO PAYS IT
 * ====================================
 * A release due at 09:00 is not sent at 09:00. It is sent at the first FIXED
 * run at or after 09:00 -- with the default cadence, up to a quarter hour
 * later. This is not a bug the fix cadence introduces by accident; it is the
 * whole reason the docblock above says "does not change when the operator
 * edits a slot" is a feature, not a gap. Every due release pays the same
 * slip, not only the ones with a manually overridden time, which is why
 * `esedekes` uses `<=` rather than `===`: the run that finally notices a due
 * release is never the run whose clock matches the release's instant to the
 * second.
 *
 * THE BOUNDARY THIS FILE DOES NOT CROSS
 * =======================================
 * `esedekes` filters on `ext_publish_kiadasok.allapot`, the STORED workflow
 * column (`KIADAS_ALLAPOTOK`, src/db.mjs) -- never on `kiadasAllapot`'s
 * computed answer (src/allapot.mjs). A draft's branches are all `var`, and
 * `kiadasAllapot` answers `utemezve` for any release with even one `var`
 * branch -- which is this filter's own trigger word. Routing the derived
 * answer into this filter would publish an unapproved draft to four
 * platforms the moment a caller mistook "what did dispatch do" for "is this
 * approved". `kiadasAllapot` cannot even produce the workflow words any more
 * (see its own docblock), which is what makes that particular mistake hard
 * to write by accident; this file does not reopen it by reading the wrong
 * source for the same word.
 *
 * A SLOT IS A WALL CLOCK IN A NAMED ZONE, NOT A UTC TRIPLE
 * =========================================================
 * `nap`/`ora`/`perc` mean the wall clock of ONE CONFIGURED ZONE -- the
 * module's `idozona` setting, `Europe/Budapest` by default (`index.mjs`'s
 * `ui.settingsFields`). "Monday 09:00" means the 09:00 the operator reads off
 * the wall, in July and in December alike, and this file converts that to an
 * instant in that zone.
 *
 * An earlier round computed the triple in UTC and argued in its own comment
 * that this bought "no local timezone, no DST". From the operator's chair
 * that argument is false, in two separate ways:
 *
 *   - DST did not disappear, it MOVED ONTO THE OPERATOR'S WALL and stopped
 *     being named anywhere. `{ nap: 1, ora: 9, perc: 0 }` is Monday 11:00
 *     Budapest in July and Monday 10:00 Budapest in December: the same row,
 *     silently two different posting times half a year apart.
 *   - Some slots cannot be expressed AT ALL. "Monday 00:30 Budapest" is
 *     `{ nap: 0, ora: 22, perc: 30 }` in July and `{ nap: 0, ora: 23, perc:
 *     30 }` in December -- there is no single triple that is right for a
 *     whole year, and the row that is right in July is wrong in December
 *     with nothing to say so.
 *
 * The conversion uses `Intl.DateTimeFormat` with a `timeZone` option and no
 * new dependency: `zonaEltolasMs` reads the zone's UTC offset AT a given
 * instant straight off `timeZoneName: 'longOffset'`, and everything else is
 * arithmetic on top of it. Two consequences worth naming:
 *
 *   - A WEEK IS SEVEN WALL-CLOCK DAYS, NOT 168 HOURS. Rolling a slot forward
 *     by `7 * 24 * 60 * 60 * 1000` would shift its wall clock by an hour
 *     across every DST change, so the roll-forward adds 7 to the DAY FIELD
 *     and re-converts (`elsoSzabadElofordulas`).
 *   - The spring-forward hour DOES NOT EXIST. Budapest's clocks jump 02:00 ->
 *     03:00 on the last Sunday of March, so a "Sunday 02:30" slot simply has
 *     no occurrence that week; `falioraPillanat` answers `null` for it and
 *     the slot rolls to the following week. Snapping it to 03:30 instead
 *     would publish at a time the operator never asked for. The autumn
 *     repeat is the mirror case -- "Sunday 02:30" happens twice -- and there
 *     the conversion lands on the SECOND occurrence, the one after the clocks
 *     go back. Both are pinned by tests rather than left to be discovered.
 *
 * THE TESTS STAY INDEPENDENT OF THE MACHINE'S `TZ`, WHICH IS A DIFFERENT
 * PROPERTY. The zone is the MODULE'S data, read from its own setting; the
 * host's `TZ` is never consulted. Nothing here calls `getFullYear`,
 * `getDay`, `getHours` or any other local-time accessor, and the locale
 * passed to `Intl` is pinned to `'en-US'` rather than the machine's, so
 * `TZ=UTC`, `TZ=Europe/Budapest` and `TZ=Pacific/Kiritimati` all produce the
 * same answers. `test/utemezes.test.mjs` is run under all three.
 */

/**
 * How many missing occurrences in a row (the spring-forward gap, see the
 * docblock above) `elsoSzabadElofordulas` steps over before it gives up on a
 * slot. One gap per year is what a real IANA zone produces, so anything past
 * a handful means the zone never renders that wall clock at all, and a loud
 * refusal beats a silent `null` that the caller would read as "no slots".
 */
const MAX_HIANYZO_ELOFORDULAS = 4

/** `Intl`'s `longOffset` rendering: `GMT+02:00`, `GMT-05:30`, or a bare `GMT` for a zone sitting exactly on it. */
const GMT_ELTOLAS = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/

/**
 * One `Intl.DateTimeFormat` for one zone, and the module's named refusals when
 * the zone is missing or is not a zone.
 *
 * TWO DIFFERENT FACTS, TWO DIFFERENT SENTENCES: "you did not pass one" points
 * the caller at `idozonaOf` and the setting, because the fix is to go and read
 * it; "that is not a zone I know" points the operator at the settings field,
 * because the fix is to correct what is stored there.
 *
 * Both are the module's own text. `Intl.DateTimeFormat` throws a bare
 * `RangeError: Invalid time zone specified: ...` for an unknown zone, which is
 * an unnamed refusal AND echoes the caller's value back -- exactly what a
 * refusal in this module may not do. It is caught here so it never reaches an
 * operator.
 */
function zonaFormatter(zona) {
  if (typeof zona !== 'string' || zona.trim() === '') {
    throw new TypeError(`kovetkezoSzabadSav: az idozona kötelező, és csak IANA-zónanév lehet -- a modul beállításából olvasd ki (idozonaOf), az adja az alapértéket is: ${ALAP_IDOZONA}`)
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zona, timeZoneName: 'longOffset' })
  } catch {
    throw new TypeError(`kovetkezoSzabadSav: az idozona nem ismert IANA-zónanév (a modul alapértéke: ${ALAP_IDOZONA})`)
  }
}

/** The zone's UTC offset in milliseconds AT one instant -- positive east of Greenwich, and already DST-aware because the offset is read at that instant, not looked up once for the zone. */
function zonaEltolasMs(fmt, pillanat) {
  const resz = fmt.formatToParts(pillanat).find((p) => p.type === 'timeZoneName')
  const m = resz ? GMT_ELTOLAS.exec(resz.value) : null
  if (!m) {
    throw new TypeError(`kovetkezoSzabadSav: az idozona eltolása nem olvasható ki (a modul alapértéke: ${ALAP_IDOZONA})`)
  }
  if (!m[1]) return 0
  const ms = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60 * 1000
  return m[1] === '-' ? -ms : ms
}

/**
 * The zone's WALL CLOCK for one instant, carried in a `Date` whose UTC
 * accessors read as that wall clock.
 *
 * The returned `Date` IS NOT AN INSTANT and must never be treated as one --
 * it is shifted on purpose so that `getUTCDay()`, `getUTCFullYear()`,
 * `getUTCMonth()` and `getUTCDate()` answer with the zone's own calendar
 * fields. Reading them off `Intl`'s formatted output instead would drag in
 * the `hour12`/`hourCycle` midnight quirk and locale-dependent parsing for
 * fields plain UTC arithmetic already gives exactly.
 */
function zonaiFaliora(fmt, pillanat) {
  return new Date(pillanat.getTime() + zonaEltolasMs(fmt, pillanat))
}

/**
 * The instant at which the zone's wall clock reads exactly
 * `ev-hoIndex-honapNap ora:perc`, or `null` when that wall clock does not
 * exist in that zone (the spring-forward gap).
 *
 * `honapNap` may overflow its month (`Date.UTC` normalises it), which is what
 * lets the weekly roll-forward be "+7 days" rather than "+168 hours".
 *
 * Two passes, because the offset must be read at the ANSWER's instant, not
 * the question's: the first guess uses the offset at the wall clock read as
 * if it were UTC, the second re-reads the offset where that guess landed. If
 * the two agree the guess round-trips and is the answer; if they disagree the
 * wall clock sits on a transition, and one of the two candidates round-trips
 * (the autumn repeat, and any slot on the far side of the jump) or neither
 * does (the spring gap, `null`).
 */
function falioraPillanat(fmt, ev, hoIndex, honapNap, ora, perc) {
  const nyers = Date.UTC(ev, hoIndex, honapNap, ora, perc, 0, 0)
  const elso = zonaEltolasMs(fmt, new Date(nyers))
  const jelolt = new Date(nyers - elso)
  const masodik = zonaEltolasMs(fmt, jelolt)
  if (masodik === elso) return jelolt
  const jelolt2 = new Date(nyers - masodik)
  if (zonaEltolasMs(fmt, jelolt2) === masodik) return jelolt2
  return null
}

/**
 * One slot's first occurrence STRICTLY AFTER `most` that no release has
 * already been given.
 *
 * "Strictly after" and not "at or after": an occurrence equal to `most` is a
 * slot the clock is standing on right this instant, not a future one to hand
 * out -- `kovetkezoSzabadSav` must never return a time that is not still
 * ahead of the caller's own clock, and treating an exact match as "free"
 * would be the one case that slips through.
 *
 * The loop is bounded by the data rather than by a week count: at most
 * `foglaltPillanatok.size` occurrences can be taken, at most one can be in
 * the past (they only increase), and at most `MAX_HIANYZO_ELOFORDULAS` can be
 * missing before the zone itself is the problem.
 */
function elsoSzabadElofordulas(fmt, sav, most, foglaltPillanatok) {
  const fali = zonaiFaliora(fmt, most)
  const napkulonbseg = (sav.nap - fali.getUTCDay() + 7) % 7
  const ev = fali.getUTCFullYear()
  const hoIndex = fali.getUTCMonth()
  let honapNap = fali.getUTCDate() + napkulonbseg
  let hianyzo = 0
  let foglalt = 0
  while (hianyzo <= MAX_HIANYZO_ELOFORDULAS && foglalt <= foglaltPillanatok.size) {
    const jelolt = falioraPillanat(fmt, ev, hoIndex, honapNap, sav.ora, sav.perc)
    honapNap += 7
    if (jelolt === null) { hianyzo += 1; continue }
    if (jelolt.getTime() <= most.getTime()) continue
    if (foglaltPillanatok.has(jelolt.toISOString())) { foglalt += 1; continue }
    return jelolt
  }
  throw new TypeError(`kovetkezoSzabadSav: a beállított időzónában ennek a sávnak nincs kiszámolható kiküldési pillanata (a modul alapértéke: ${ALAP_IDOZONA})`)
}

/**
 * The instant one week of the calendar starts at: the SUNDAY 00:00 on the
 * zone's wall clock at or before `pillanat`, shifted by `hetEltolas` whole
 * weeks -- and, like every other conversion in this file, seven WALL-CLOCK
 * days rather than 168 hours, so a week containing a DST change is still a
 * week.
 *
 * WHY THE CALENDAR NEEDS THIS AT ALL. `src/rpc.mjs`'s `naptar` used to send
 * EVERY release that had ever existed and `ui/naptar.tsx` bucketed them into
 * seven weekday columns with no window, so the Monday column accumulated
 * every Monday release forever: a "weekly calendar" that was in fact a
 * lifetime one, growing without bound, with one branch query per release on
 * every page load. The window is decided HERE, on the server, in the module's
 * own zone, because that is where the zone is known -- a page doing this
 * arithmetic would need the zone rules `zonaFormatter` wraps, and the day
 * columns would drift from the slots by an hour twice a year.
 *
 * Sunday-first, because `ext_publish_savok.nap` is (`repo.ujSav`: "0 =
 * vasárnap") and `ui/naptar.tsx`'s seven columns are. One reading of "which
 * day is column 0" in the whole module.
 *
 * A ZONE WHOSE MIDNIGHT DOES NOT EXIST is the one case that needs a rule
 * rather than a formula -- a handful of real zones move their clocks at
 * 00:00, so that Sunday has no 00:00 at all. The window then opens at the
 * first hour of that day that DOES exist, which is the same choice
 * `elsoSzabadElofordulas` makes for a slot in the gap (never invent a wall
 * clock the zone does not render), and is bounded so an unrenderable zone
 * refuses loudly instead of looping.
 *
 * @param {Date} pillanat
 * @param {string} zona
 * @param {number} hetEltolas whole weeks, negative for earlier
 * @returns {string} ISO instant
 */
export function hetKezdete(pillanat, zona, hetEltolas = 0) {
  if (!(pillanat instanceof Date) || Number.isNaN(pillanat.getTime())) throw new TypeError('hetKezdete: a pillanat csak érvényes Date lehet')
  if (!Number.isInteger(hetEltolas)) throw new TypeError('hetKezdete: a hetEltolas csak egész szám lehet')
  const fmt = zonaFormatter(zona)
  const fali = zonaiFaliora(fmt, pillanat)
  const ev = fali.getUTCFullYear()
  const hoIndex = fali.getUTCMonth()
  const honapNap = fali.getUTCDate() - fali.getUTCDay() + hetEltolas * 7
  for (let ora = 0; ora <= MAX_HIANYZO_ELOFORDULAS; ora += 1) {
    const jelolt = falioraPillanat(fmt, ev, hoIndex, honapNap, ora, 0)
    if (jelolt !== null) return jelolt.toISOString()
  }
  throw new TypeError(`hetKezdete: a beállított időzónában ennek a hétnek nincs kiszámolható kezdete (a modul alapértéke: ${ALAP_IDOZONA})`)
}

function ervenytelenSav(sav) {
  return typeof sav !== 'object' || sav === null || typeof sav.id !== 'string'
    || !Number.isInteger(sav.nap) || sav.nap < 0 || sav.nap > 6
    || !Number.isInteger(sav.ora) || sav.ora < 0 || sav.ora > 23
    || !Number.isInteger(sav.perc) || sav.perc < 0 || sav.perc > 59
}

function ervenytelenFoglalas(foglalas) {
  return typeof foglalas !== 'object' || foglalas === null
    || typeof foglalas.savId !== 'string' || foglalas.savId === ''
    || typeof foglalas.idopont !== 'string' || Number.isNaN(Date.parse(foglalas.idopont))
}

/**
 * The next free occurrence, across every declared slot, strictly after
 * `most` -- or `null` when there are no slots at all.
 *
 * "Free" is decided per OCCURRENCE, not per (slot, occurrence): `foglaltak`
 * is the list of instants already handed to a release (`{ savId, idopont }`,
 * `idopont` an ISO instant), and only the instant is keyed on. Two slots
 * pointing at the same weekly minute therefore do NOT double the capacity of
 * that minute -- one release goes out in a given minute however many slots
 * name it. Keying on the pair instead would let a duplicated slot row send
 * two releases to four platforms simultaneously, silently, with the operator
 * having done nothing but add the same time twice. `savId` is still required
 * on every entry, and still stored on the release, because the calendar draws
 * WHICH slot a release sits in; it is simply not what decides "free".
 *
 * A slot whose next occurrence is already taken does not drop out of the
 * running -- it rolls forward a week at a time until it finds one that is
 * not, exactly the way the slot recurs in reality. The WINNER is the single
 * earliest free occurrence over every slot, not the first slot in the array
 * to have one free: a slot later in `savok` with an earlier free time wins
 * over one earlier in the array with a later one. A genuine TIE -- two slots
 * whose free occurrences are the same instant -- goes to the one EARLIER IN
 * `savok`, which `savok()` (src/db.mjs) orders by `nap, ora, perc`.
 *
 * `zona` is the IANA zone the slot's `nap`/`ora`/`perc` is read in -- see the
 * file docblock for why a slot is a wall clock and not a UTC triple -- and it
 * is REQUIRED, with no default.
 *
 * A default here would read as a kindness and behave as a trap. `ALAP_IDOZONA`
 * is the module's CONSTANT, not the operator's SETTING, and the two stop being
 * the same string the moment the operator edits the field. A caller that
 * forgot the argument would then compute Budapest slots while the settings
 * page said Lisbon, with nothing anywhere reporting the disagreement -- the
 * same silent wrongness as a due filter reading a column that does not exist,
 * one layer up. Required makes that unwritable: there is no way to reach this
 * function without having gone and read the setting.
 *
 * The default belongs at the ONE place that reads the setting, which is
 * `idozonaOf` below, and at the settings field's own `defaultValue`
 * (`index.mjs`) -- so an operator who never opens the field still gets
 * `ALAP_IDOZONA`, and the arithmetic still never guesses.
 *
 * Pure: no clock read, no database read, no `TZ` read. `most` is always the
 * caller's own `new Date()` (or a fixture's), so this is testable without one.
 *
 * @param {Array<{ id: string, nap: number, ora: number, perc: number }>} savok
 * @param {Array<{ savId: string, idopont: string }>} foglaltak
 * @param {Date} most
 * @param {string} zona
 * @returns {{ savId: string, idopont: string } | null}
 */
export function kovetkezoSzabadSav(savok, foglaltak, most, zona) {
  if (!Array.isArray(savok)) throw new TypeError('kovetkezoSzabadSav: a savok csak sáv-sorok tömbje lehet')
  if (!Array.isArray(foglaltak)) throw new TypeError('kovetkezoSzabadSav: a foglaltak csak foglalt sáv-előfordulások tömbje lehet')
  if (!(most instanceof Date) || Number.isNaN(most.getTime())) throw new TypeError('kovetkezoSzabadSav: a most csak érvényes Date lehet')
  if (savok.some(ervenytelenSav)) {
    throw new TypeError(`kovetkezoSzabadSav: minden sáv id, nap (0-6), ora (0-23) és perc (0-59) mezőt kell hordozzon, a beállított időzóna fali óráján (alapból ${ALAP_IDOZONA})`)
  }
  // Every entry is checked before the first one is used, the same discipline
  // `esedekes` applies below. Without it a malformed `idopont` reached
  // `new Date(...).toISOString()` and surfaced V8's own `RangeError: Invalid
  // time value` to the operator, and a missing `savId` was worse than that:
  // it built a key that matched nothing, so a taken slot looked free.
  if (foglaltak.some(ervenytelenFoglalas)) {
    throw new TypeError('kovetkezoSzabadSav: a foglaltak minden eleme savId és ISO idopont mezőt kell hordozzon')
  }
  const fmt = zonaFormatter(zona)
  if (savok.length === 0) return null

  const foglaltPillanatok = new Set(foglaltak.map((f) => new Date(f.idopont).toISOString()))

  let legjobb = null
  for (const sav of savok) {
    const jelolt = elsoSzabadElofordulas(fmt, sav, most, foglaltPillanatok)
    if (legjobb === null || jelolt.getTime() < legjobb.jelolt.getTime()) {
      legjobb = { savId: sav.id, jelolt }
    }
  }
  return { savId: legjobb.savId, idopont: legjobb.jelolt.toISOString() }
}

/** True when a release row carries a dispatch instant this module can compare against a clock. */
function vanHasznalhatoIdopont(kiadas) {
  return typeof kiadas.idopont === 'string' && !Number.isNaN(Date.parse(kiadas.idopont))
}

function ellenorzottKiadasok(kiadasok, fuggveny) {
  if (!Array.isArray(kiadasok)) throw new TypeError(`${fuggveny}: a kiadasok csak kiadás-sorok tömbje lehet`)
  for (const k of kiadasok) {
    if (typeof k !== 'object' || k === null || typeof k.allapot !== 'string') {
      throw new TypeError(`${fuggveny}: a kiadasok minden eleme kiadás-sor kell legyen, string allapot mezővel`)
    }
  }
}

/**
 * The scheduled releases whose due instant has come, as of `most`.
 *
 * Two conditions, both required: `allapot === KIADAS_ALLAPOTOK.UTEMEZVE` --
 * the STORED workflow column, see the docblock above for why this is never
 * `kiadasAllapot`'s computed answer -- and `idopont <= most` (`<=`, not `<`:
 * a release due at exactly `most` is due, not "due next run").
 *
 * THE `idopont` CHECK IS NOT ABOUT DRAFTS. A caller may well hand the whole
 * `kiadasok()` table over, drafts included, but the `allapot` test above has
 * already dropped every draft before `idopont` is looked at, so a draft
 * without an instant was never this check's business. Its ONE live effect is
 * a `utemezve` row whose instant nobody ever wrote -- a THIRD fact, neither
 * "due" nor "due later" -- and folding that into "not due" is exactly the
 * silence this module exists to refuse. It is therefore split out by name:
 * `idopontNelkuliUtemezettek()` below returns those rows, the dispatch tool
 * reports them, and `esedekes()` and `idopontNelkuliUtemezettek()` together
 * partition the scheduled rows with nothing falling between them.
 *
 * @param {Array<{ id: string, allapot: string, idopont?: string | null }>} kiadasok
 * @param {Date} most
 * @returns {Array<{ id: string, allapot: string, idopont?: string | null }>}
 */
export function esedekes(kiadasok, most) {
  ellenorzottKiadasok(kiadasok, 'esedekes')
  if (!(most instanceof Date) || Number.isNaN(most.getTime())) throw new TypeError('esedekes: a most csak érvényes Date lehet')
  const mostMs = most.getTime()
  return kiadasok.filter((k) => k.allapot === KIADAS_ALLAPOTOK.UTEMEZVE
    && vanHasznalhatoIdopont(k) && Date.parse(k.idopont) <= mostMs)
}

/**
 * The scheduled releases that carry NO usable dispatch instant -- the third
 * fact `esedekes()` refuses to swallow.
 *
 * A release reaches `utemezve` and gets its `idopont` written in the same
 * step, so a row in this list is a broken invariant, not a normal state: it
 * will never be due, and without this function nothing would ever say so. It
 * is a separate return rather than a throw because one broken row must not
 * stop the other releases from going out -- the dispatch run reports it and
 * carries on (`index.mjs`'s `KIKULDES_PROMPT` asks the agent for exactly
 * that).
 *
 * @param {Array<{ id: string, allapot: string, idopont?: string | null }>} kiadasok
 * @returns {Array<{ id: string, allapot: string, idopont?: string | null }>}
 */
export function idopontNelkuliUtemezettek(kiadasok) {
  ellenorzottKiadasok(kiadasok, 'idopontNelkuliUtemezettek')
  return kiadasok.filter((k) => k.allapot === KIADAS_ALLAPOTOK.UTEMEZVE && !vanHasznalhatoIdopont(k))
}

/**
 * The zone the slots are read in, from the module's own settings object.
 *
 * The fallback fires twice, and the second time is the one that matters: a
 * never-configured install has no `idozona` key at all, and an operator who
 * CLEARS the field stores `''` rather than `undefined`, at which point the
 * host's own `defaultValue` never fires again. This reader is the only thing
 * that can turn a blanked setting back into a working zone -- the same reason
 * `extensions/video/index.mjs` gives for its own settings fallbacks.
 *
 * @param {undefined | null | { idozona?: unknown }} beallitasok
 * @returns {string}
 */
export function idozonaOf(beallitasok) {
  const ertek = beallitasok && typeof beallitasok === 'object' ? beallitasok.idozona : undefined
  if (typeof ertek !== 'string' || ertek.trim() === '') return ALAP_IDOZONA
  return ertek.trim()
}
