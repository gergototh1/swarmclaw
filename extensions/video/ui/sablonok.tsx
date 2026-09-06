import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'

import type { Health, PreviewHiba, PreviewStatus, Prop, Rpc, Templates } from './api'
import { errorText, readPreviewCancel, readPreviewStart, readPreviewStatus, readTemplates, readTemplatePreview } from './api'
import { kodSzamok, megtartasSzoveg } from './format'
import type { Szuro, SzuroForras } from './sablon-szuro'
import { URES_SZURO, szurtTipusok } from './sablon-szuro'

/**
 * The kit's twenty-four scene types as a gallery, with the numbers of spec
 * 6.3 under it and the weekly row at the bottom.
 *
 * TWO SENTINELS ARE PASSED THROUGH UNTRANSLATED, and the reason is the same
 * for both. `qaBukas` is the constant `nincs_idokodos_szabaly`: rule set 1
 * has no scene-scoped QA rule, so no QA failure can be attributed to a
 * template, and a 0 in that column would say "this template never failed QA"
 * -- something nothing has measured. `megtartas` is `meretlen` when no
 * retention point falls inside the type's scenes, for the same reason. Both
 * are the module's own words and are shown as those words.
 *
 * A CATALOGUE THAT COULD NOT BE READ IS NOT AN EMPTY CATALOGUE. `templates`
 * answers with every catalogue-derived field null beside a refusal code in
 * that case, and this view shows the code where the grid would be, rather
 * than a grid of no cards that would read as "this kit has no templates".
 * The weekly row is computed from stored rows and does not need the project,
 * so it stays. The other half of that rule is the `látható/összes` line: it
 * is drawn on EVERY state of the grid, so a grid that is empty because the
 * filters are narrow says `0/24` and can never be mistaken for the other.
 *
 * NOTHING HERE STARTS A GENERATION. Rendering the page reads `templates` and
 * `templatePreviewStatus`, both of which only look at what is already on
 * disk, and asks for the picture of a card once it scrolls into view. The
 * twenty-four headless browsers are behind a button the operator presses, for
 * the reason the design spec measured: forty seconds of somebody's machine is
 * not something a page opening may decide.
 */

/** One card's picture as far as this page got with it. An absent entry means "not asked for yet". */
export type KepAllapot =
  | { kind: 'toltes' }
  | { kind: 'kep'; dataUrl: string }
  /** The method's own vocabulary: `nincs_minta`, `nincs_kep`, `tipus_ismeretlen`, `nem_kep`. */
  | { kind: 'nincs'; ok: string }
  /** The project could not be read, or the request never arrived. */
  | { kind: 'hiba'; szoveg: string }

/** `nincs_minta` is missing data in the kit's dictionary, not a failure, and the frame says so without the failure colour. */
function keretSzoveg(ok: string): { szoveg: string; rossz: boolean } {
  if (ok === 'nincs_minta') return { szoveg: 'nincs_minta', rossz: false }
  if (ok === 'nincs_kep') return { szoveg: 'nincs kép', rossz: false }
  return { szoveg: ok, rossz: true }
}

/** A run failure as one line: the code, and the exit code or signal when the run recorded one. */
function hibaSzoveg(hiba: PreviewHiba): string {
  if (typeof hiba.kilepesiKod === 'number') return `${hiba.kod} (kilépési kód: ${hiba.kilepesiKod})`
  if (typeof hiba.jel === 'string' && hiba.jel !== '') return `${hiba.kod} (${hiba.jel})`
  return hiba.kod
}

/**
 * One prop as a line. `mit` is optional in the catalogue, so a prop without a
 * sentence still draws its name.
 *
 * THE TEST IS "IS THIS A SENTENCE", NOT "IS THIS UNDEFINED". `katalogus.mjs`
 * checks a prop's `nev` and `kotelezo` and `api.ts`'s `isProp` checks the
 * same two, so `mit` reaches here as whatever the generated catalogue put
 * there -- a null, a number, an object. Testing for `undefined` would let a
 * `null` draw the line `sorok (kötelező) — null`, which is a statement about
 * the kit that nothing measured.
 *
 * The guard is HERE and not in `isProp` deliberately. `propsOrNull` nulls the
 * WHOLE `propok` field over one entry it cannot read, by the rule that half a
 * prop table is a false statement about the kit; a `mit` that is not a
 * sentence is not that -- it is one optional field the drawing site already
 * knows how to omit. Type-checking it in `isProp` would cost all twenty-four
 * prop lists over a missing sentence, which is a worse answer than this one.
 */
function propSzoveg(prop: Prop): string {
  const kotelezo = prop.kotelezo ? 'kötelező' : 'opcionális'
  const mit: unknown = prop.mit
  return typeof mit === 'string' && mit !== '' ? `${prop.nev} (${kotelezo}) — ${mit}` : `${prop.nev} (${kotelezo})`
}

/** The 9:16 frame: a picture, or a marked empty frame that says which of the four reasons it is. */
function Keret({ tipus, kep }: { tipus: string; kep: KepAllapot | undefined }) {
  if (kep !== undefined && kep.kind === 'kep') {
    return <img className="vid-sablon-kep" src={kep.dataUrl} alt={`${tipus} előnézeti képe`} loading="lazy" />
  }
  if (kep !== undefined && kep.kind === 'toltes') return <span className="vid-sablon-ures vid-muted">töltés…</span>
  if (kep !== undefined && kep.kind === 'hiba') return <span className="vid-sablon-ures vid-bad">{kep.szoveg}</span>
  if (kep !== undefined) {
    const { szoveg, rossz } = keretSzoveg(kep.ok)
    return <span className={`vid-sablon-ures ${rossz ? 'vid-bad' : 'vid-muted'}`}>{szoveg}</span>
  }
  return <span className="vid-sablon-ures vid-muted">nincs kép</span>
}

/**
 * The progress line of a run.
 *
 * THE RUN DOES NOT REPORT WHICH TYPE IT IS ON, and this does not pretend
 * otherwise. `kesz` and `hibak` say what is behind it and `osszes` what it
 * set out to do; the name is read off the status's own `hianyzo`, which is
 * recomputed from the directory on every call, so the first still-missing
 * type this run has not finished is the one in flight. When that cannot be
 * told -- no catalogue, or the lists disagree -- the line is the two numbers
 * and no name, rather than a name that might belong to the next type.
 *
 * THE TWO HALVES MUST BE THE SAME KIT. `hianyzo` is recomputed from the
 * catalogue on disk on every poll, while the run carries the hash it started
 * against. If the operator points the setting at another project mid-run the
 * two describe different kits, and `hianyzo` would then name a type this run
 * never set out to draw -- wrongly, and for the WHOLE remaining run rather
 * than for one poll. Both hashes are in hand, so they are compared, and a
 * mismatch falls back to the numbers, which are the run's own and stay true.
 */
function haladas(allapot: PreviewStatus): string {
  const fut = allapot.fut
  if (fut === null) return ''
  const kesz = new Set(fut.kesz)
  const hibas = new Set(Object.keys(fut.hibak))
  const mennyi = kesz.size + hibas.size
  const ugyanazAKatalogus = allapot.katalogusHash !== null && allapot.katalogusHash === fut.katalogusHash
  const aktualis = !ugyanazAKatalogus
    ? undefined
    : (allapot.hianyzo ?? []).find((t) => !kesz.has(t) && !hibas.has(t))
  const szamok = `${mennyi}/${fut.osszes}`
  if (fut.megszakitva) return `${szamok} — megszakítás alatt`
  return aktualis === undefined ? szamok : `${szamok} — ${aktualis}`
}

/**
 * The three-position toggles, drawn the same way and disabled together with
 * the fact they ask about.
 *
 * A DARK CONTROL SAYS WHY, the same as the generate button does.
 * `sablon-szuro.ts` states the rule -- a dimension nobody measured cannot
 * narrow, "the view disables that control and says why" -- and a select that
 * is simply grey leaves the operator to guess whether the kit has no
 * such types or the page never learned. `miert` is drawn beside the control
 * and repeated as its tooltip, so it is there for a pointer and for a reader.
 */
function Valaszto<T extends string>({ cimke, ertek, allasok, tiltva, miert, onValt }: {
  cimke: string
  ertek: T
  allasok: Array<[T, string]>
  tiltva: boolean
  /** Which fact is missing, in the page's own words. Drawn only while `tiltva`. */
  miert: string
  onValt: (ertek: T) => void
}) {
  return (
    <label className="vid-szuro-mezo">
      {cimke}
      <select
        className="vid-input"
        value={ertek}
        disabled={tiltva}
        title={tiltva ? miert : undefined}
        onChange={(e) => onValt(e.target.value as T)}
      >
        {allasok.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {tiltva && <span className="vid-muted vid-szuro-ok">{miert}</span>}
    </label>
  )
}

/**
 * Why the generate button is dark, or null while it is live.
 *
 * ONE FUNCTION FOR BOTH, so the button and its sentence cannot drift: `tiltva`
 * below is `tiltasOka(...) !== null` and nothing else, which is what keeps the
 * rule "a control this page disables says why" from being true of three of the
 * reasons and false of the fourth.
 */
function tiltasOka({ hiba, renderBlokkolt, hibaKodok, dolgozik, hianyzoDb }: {
  hiba: string | null
  renderBlokkolt: boolean
  hibaKodok: string[]
  dolgozik: boolean
  hianyzoDb: number | null
}): { szoveg: string; rossz: boolean } | null {
  if (hiba !== null) return { szoveg: 'A generálás katalógus nélkül nem indulhat.', rossz: false }
  if (renderBlokkolt) {
    const kodok = hibaKodok.length === 0 ? '' : ` Hibás ellenőrzések: ${hibaKodok.join(', ')}.`
    return { szoveg: `A render most blokkolt, így az előnézetek nem generálhatók.${kodok}`, rossz: true }
  }
  if (dolgozik) return { szoveg: 'Az indítás elment, a válaszra várok.', rossz: false }
  if (hianyzoDb === 0) return { szoveg: 'Minden mintával rendelkező típusnak van képe.', rossz: false }
  if (hianyzoDb === null) return { szoveg: 'Az előnézetek állapota nem ismert, így a generálás nem indítható innen.', rossz: false }
  return null
}

export function SablonokBody({
  data, health, allapot, allapotHiba, szuro, onSzuro, kepek, futasHibak, nyitott, onNyit,
  racsRef, onGeneral, onMegszakit, dolgozik, uzenet, onUzenetZar,
}: {
  data: Templates
  health: Health | null
  allapot: PreviewStatus | null
  allapotHiba: string | null
  szuro: Szuro
  onSzuro: (szuro: Szuro) => void
  kepek: Record<string, KepAllapot>
  /** What the last run this page saw recorded per type. Kept after the run ends: a failure the operator did not read is a failure they cannot act on. */
  futasHibak: Record<string, PreviewHiba>
  nyitott: string | null
  onNyit: (tipus: string | null) => void
  /** The grid element, so the shell's `IntersectionObserver` can find the cards. Absent in a server render, where there is no observer. */
  racsRef?: Ref<HTMLDivElement>
  onGeneral: () => void
  onMegszakit: () => void
  dolgozik: boolean
  uzenet: string | null
  /** Clears `uzenet`. The bar's notice carries the same button, for the same reason: a line nothing retracts stays on screen for the rest of the session. */
  onUzenetZar: () => void
}) {
  const stat = data.sablonStat
  const tipusok = data.tipusok ?? null
  const kuldheto = data.kuldhetoTipusok ?? null
  const kozosPropok = data.kozosPropok ?? null
  const nemKuldheto = new Set(data.nemKuldhetoTipusok ?? [])
  const hasznalatok = stat === null
    ? null
    : Object.fromEntries(Object.entries(stat).map(([tipus, s]) => [tipus, s.hasznalat]))
  const forras: SzuroForras = {
    tipusok: tipusok ?? [],
    leirasok: data.leirasok ?? null,
    propok: data.propok ?? null,
    kuldheto,
    hasznalat: hasznalatok,
    vanKep: allapot === null ? null : allapot.meglevo,
  }
  const lathato = szurtTipusok(forras, szuro)
  const nyitottPropok = nyitott === null ? null : (data.propok?.[nyitott] ?? null)
  const nyitottStat = nyitott === null || stat === null ? null : (stat[nyitott] ?? null)

  // THE FACT READ IS `blokkolt`, NOT A CODE THIS FILE NAMES. The design spec
  // named `npx_hianyzik` alone; this is a deliberate strengthening, because
  // `health.mjs` declares `chrome_hianyzik` and `platform_nem_mac` render
  // blockers too and `elonezet.mjs` guards neither. Reading the code the spec
  // named would leave the button live on a fresh install while the status bar
  // two rows up prints `Most blokkolt: render`, and pressing it would spend
  // forty seconds of somebody's machine on twenty-four runs that each fail --
  // the argument this file's own docblock makes for npx, one code over.
  // Reading the measured list instead means the bar and the button cannot
  // disagree, and a blocker declared later needs no edit here.
  //
  // A health that has not answered is NOT a blocker: it says nothing about
  // whether the render can start, and the server refuses on its own if not.
  const renderBlokkolt = health !== null && health.blokkolt.includes('render')
  const hianyzoDb = allapot === null ? null : (allapot.hianyzo?.length ?? null)
  const fut = allapot === null ? null : allapot.fut
  const ok = tiltasOka({ hiba: data.hiba, renderBlokkolt, hibaKodok: health?.hibak ?? [], dolgozik, hianyzoDb })
  // Disabled exactly when there is a sentence to say so, and never otherwise.
  const tiltva = ok !== null

  return (
    <div className="vid-sablonok">
      {data.hiba !== null && (
        <p className="vid-bad" role="alert">A katalógus nem olvasható: <span className="vid-mono">{data.hiba}</span></p>
      )}
      {data.hiba === null && (
        <p className="vid-muted vid-mono">katalógus-hash: {data.katalogusHash ?? '(nincs)'}</p>
      )}
      {/*
        THE SKEW THE AGENT ALREADY SEES, drawn for the one person who can
        close it. `tablaHianyok` is what `videoCatalog` hands the producer and
        what turns into `katalogus_valtozott` on every plan while the gap is
        open: types and props the generated catalogue declares and the
        module's kit table does not, which a plan may therefore not use. It
        travelled to this page from the first version of the gallery and
        nothing drew it, which is exactly how a table falls a kit behind
        without anybody noticing.

        The names are the catalogue's own, so they are shown as names; the
        `role` is `status` and not `alert`, because a table one commit behind
        is an ordinary state of two repositories, not a fault of this page.
      */}
      {data.tablaHianyok !== null && data.tablaHianyok.length > 0 && (
        <p className="vid-warn" role="status">
          A katalógus olyan típust vagy propot ad, amit a modul kit-táblája még nem ismer, ezért terv nem használhatja
          (katalogus_valtozott): <span className="vid-mono">{data.tablaHianyok.join(', ')}</span>
        </p>
      )}

      <div className="vid-sablon-generalas">
        {fut === null || allapot === null ? (
          <button type="button" className="vid-btn" disabled={tiltva} onClick={onGeneral}>
            Előnézetek generálása ({hianyzoDb === null ? '?' : hianyzoDb} hiányzik)
          </button>
        ) : (
          <>
            <span className="vid-mono" role="status">{haladas(allapot)}</span>
            <button type="button" className="vid-btn vid-btn-small" onClick={onMegszakit}>Megszakít</button>
          </>
        )}
        {fut === null && ok !== null && <span className={ok.rossz ? 'vid-bad' : 'vid-muted'}>{ok.szoveg}</span>}
      </div>
      {/*
        WHY THE MISSING COUNT CAN STAND AT ZERO WITH EMPTY CARDS ON SCREEN.
        A type the catalogue declares without a sample is in neither
        `meglevo` nor `hianyzo`: no picture is ever generated for it, the
        button will never count it, and its card says `nincs_minta` in the
        frame. Without this line the operator reads "minden mintával
        rendelkező típusnak van képe" beside a grid with holes in it and has
        only the wording of the sentence to go on. The list is the module's
        own answer (`elonezet.mjs`'s `vanMinta`), so it and the frames cannot
        disagree.
      */}
      {allapot !== null && allapot.mintaNelkul !== null && allapot.mintaNelkul.length > 0 && (
        <p className="vid-muted">
          {allapot.mintaNelkul.length} típushoz a katalógus nem ad mintát, ezekhez kép sem készül:{' '}
          <span className="vid-mono">{allapot.mintaNelkul.join(', ')}</span>
        </p>
      )}
      {allapotHiba !== null && (
        <p className="vid-bad" role="alert">Az előnézetek állapotát nem tudtam lekérdezni: {allapotHiba}</p>
      )}
      {uzenet !== null && (
        <p className="vid-notice" role="status">
          {uzenet}
          <button type="button" className="vid-btn vid-btn-small" onClick={onUzenetZar}>Elrejt</button>
        </p>
      )}

      <div className="vid-szuro-sor">
        <label className="vid-szuro-mezo">
          keresés
          <input
            className="vid-input"
            type="search"
            value={szuro.kereses}
            placeholder="típus, leírás, propnév"
            onChange={(e) => onSzuro({ ...szuro, kereses: e.target.value })}
          />
        </label>
        <Valaszto
          cimke="küldhetőség"
          ertek={szuro.kuldhetoseg}
          tiltva={kuldheto === null}
          miert="a kit-tábla nem olvasható, így erre nem lehet szűrni"
          allasok={[['mind', 'mind'], ['kuldheto', 'csak küldhető'], ['nem', 'csak nem küldhető']]}
          onValt={(kuldhetoseg) => onSzuro({ ...szuro, kuldhetoseg })}
        />
        <Valaszto
          cimke="használat"
          ertek={szuro.hasznalat}
          tiltva={hasznalatok === null}
          miert="katalógus nélkül nincs használati szám, így erre nem lehet szűrni"
          allasok={[['mind', 'mind'], ['hasznalt', 'használt'], ['nem', 'nem használt']]}
          onValt={(hasznalat) => onSzuro({ ...szuro, hasznalat })}
        />
        <Valaszto
          cimke="előnézet"
          ertek={szuro.elonezet}
          tiltva={forras.vanKep === null}
          miert="az előnézetek állapota még nem ismert, így erre nem lehet szűrni"
          allasok={[['mind', 'mind'], ['van', 'van kép'], ['nincs', 'nincs kép']]}
          onValt={(elonezet) => onSzuro({ ...szuro, elonezet })}
        />
        <button type="button" className="vid-btn vid-btn-small" onClick={() => onSzuro(URES_SZURO)}>Szűrők törlése</button>
      </div>

      {/*
        Drawn in every state of the grid, including the one where the type
        list could not be read (`0/?`). This line and the refusal code above
        it are what keep "no card matches" and "no catalogue" apart.

        THE DENOMINATOR IS `?` AND NOT 0 when there is no type list, by the
        rule this module keeps everywhere else (`meretlen`, `nincs mérve`, the
        `?` on a card's use count): 0 is a number, and nobody counted. The kit
        may well have its twenty-four types behind a `templates` field that
        failed its shape check, and `0/0` would say it has none.
      */}
      <p className="vid-sablon-szamlalo vid-muted">
        {lathato.length}/{tipusok === null ? '?' : tipusok.length} típus látszik
      </p>

      {tipusok === null ? (
        <p className="vid-muted">
          {data.hiba === null
            ? 'A típuslistát nem sikerült olvasni, így a rács üres — ez nem azt jelenti, hogy a kit nem tud jeleneteket.'
            : 'Katalógus nélkül nincs rács. A heti sor alább ettől függetlenül megvan.'}
        </p>
      ) : (
        <>
          <div className="vid-sablon-racs" ref={racsRef}>
            {lathato.map((tipus) => {
              const s = stat === null ? null : (stat[tipus] ?? null)
              const hiba = futasHibak[tipus]
              return (
                <button
                  key={tipus}
                  type="button"
                  data-tipus={tipus}
                  className={`vid-sablon-kartya${nyitott === tipus ? ' vid-sablon-kartya-nyitva' : ''}`}
                  aria-expanded={nyitott === tipus}
                  onClick={() => onNyit(nyitott === tipus ? null : tipus)}
                >
                  <span className="vid-sablon-keret">
                    <Keret tipus={tipus} kep={kepek[tipus]} />
                  </span>
                  <span className="vid-sablon-nev vid-mono">{tipus}</span>
                  {nemKuldheto.has(tipus) && <span className="vid-sablon-jel vid-warn">nem küldhető</span>}
                  <span className="vid-sablon-leiras">{data.leirasok?.[tipus] ?? '(a katalógus nem ír le mondatot erről a típusról)'}</span>
                  <span className="vid-sablon-szam vid-muted">használat: {s === null ? '?' : s.hasznalat}</span>
                  {hiba !== undefined && <span className="vid-sablon-jel vid-bad vid-mono">{hibaSzoveg(hiba)}</span>}
                </button>
              )
            })}
          </div>
          {lathato.length === 0 && tipusok.length > 0 && (
            <p className="vid-muted">Egy típus sem felel meg a szűrőknek. A katalógus {tipusok.length} típust ad; a szűrők szűkek.</p>
          )}
          {tipusok.length === 0 && (
            <p className="vid-warn">A katalógus olvasható, de egyetlen típust sem sorol fel.</p>
          )}
        </>
      )}

      {nyitott !== null && (
        <section className="vid-sablon-panel">
          <h3 className="vid-mono">{nyitott}</h3>
          <button type="button" className="vid-btn vid-btn-small" onClick={() => onNyit(null)}>Bezár</button>
          <p>{data.leirasok?.[nyitott] ?? '(a katalógus nem ír le mondatot erről a típusról)'}</p>
          <p className="vid-muted">
            {nemKuldheto.has(nyitott)
              ? 'JSON-ból nem küldhető: valamelyik propja React-csomópont, a kép a küldhető alakot mutatja.'
              : 'JSON-ból küldhető.'}
          </p>
          <h4>Propok</h4>
          {nyitottPropok === null ? (
            <p className="vid-muted">A propok listája nem olvasható.</p>
          ) : nyitottPropok.length === 0 ? (
            <p className="vid-muted">Ennek a típusnak nincs saját propja.</p>
          ) : (
            <ul className="vid-sablon-propok">
              {nyitottPropok.map((p) => <li key={p.nev}>{propSzoveg(p)}</li>)}
            </ul>
          )}
          <h4>Közös propok</h4>
          {kozosPropok === null ? (
            <p className="vid-muted">A közös propok listája nem olvasható.</p>
          ) : (
            <ul className="vid-sablon-propok">
              {kozosPropok.map((p) => <li key={p.nev}>{propSzoveg(p)}</li>)}
            </ul>
          )}
          <h4>Számok</h4>
          {nyitottStat === null ? (
            <p className="vid-muted">Erre a típusra nincs statisztika.</p>
          ) : (
            <ul className="vid-sablon-szamok">
              <li>használat: {nyitottStat.hasznalat}</li>
              <li>lektori találat: {kodSzamok(nyitottStat.lektoriTalalat)}</li>
              <li className="vid-mono">QA-bukás: {nyitottStat.qaBukas}</li>
              <li>visszajelzés: {nyitottStat.visszajelzes}</li>
              <li className="vid-mono">megtartás: {megtartasSzoveg(nyitottStat.megtartas)}</li>
            </ul>
          )}
        </section>
      )}

      <h3>Típusonkénti számok</h3>
      {stat === null ? (
        <p className="vid-muted">Katalógus nélkül nincs típusonkénti táblázat. A heti sor alább ettől függetlenül megvan.</p>
      ) : (
        <table className="vid-tabla">
          <thead>
            <tr>
              <th scope="col">típus</th>
              <th scope="col">használat</th>
              <th scope="col">lektori találat</th>
              <th scope="col">QA-bukás</th>
              <th scope="col">visszajelzés</th>
              <th scope="col">megtartás</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(stat).sort().map((tipus) => {
              const s = stat[tipus]
              return (
                <tr key={tipus}>
                  <th scope="row" className="vid-mono">{tipus}</th>
                  <td>{s.hasznalat}</td>
                  <td>{kodSzamok(s.lektoriTalalat)}</td>
                  <td className="vid-mono">{s.qaBukas}</td>
                  <td>{s.visszajelzes}</td>
                  <td className="vid-mono">{megtartasSzoveg(s.megtartas)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h3>Heti sor</h3>
      {data.hetiSor.length === 0 ? (
        <p className="vid-muted">Egyetlen hétre sincs adat: nem futott render, nem született QA-sor és nincs lektori ítélet.</p>
      ) : (
        <table className="vid-tabla">
          <thead>
            <tr>
              <th scope="col">hét</th>
              <th scope="col">renderek</th>
              <th scope="col">QA-bukások</th>
              <th scope="col">lektori találatok kódonként</th>
            </tr>
          </thead>
          <tbody>
            {data.hetiSor.map((h) => (
              <tr key={h.het}>
                <th scope="row" className="vid-mono">{h.het}</th>
                <td>{h.renderek}</td>
                <td>{h.qaBukas}</td>
                <td>{kodSzamok(h.lektoriTalalat)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * Whether the grid is drawing a catalogue that is no longer the one on disk.
 *
 * THE GRID WAS A SNAPSHOT AND THE BUTTON WAS NOT. `templates` is fetched once
 * on mount; `templatePreviewStatus` is fetched again on every poll, and it
 * carries the catalogue hash it just read. So an operator who edits the kit
 * mid-session had the old type list in the grid beside a button counting the
 * new one, and nothing on the page said which was current -- a reload fixed
 * it, but only for someone who already suspected.
 *
 * A pure function rather than a comparison inline in the effect, for the
 * reason `sablon-szuro.ts` is a separate file: the question is arithmetic on
 * two strings, and a test that had to run an effect to ask it would be
 * measuring React.
 *
 * TWO NULLS ARE NOT A CHANGE. Either side may be null -- the project could
 * not be read, or that half has not answered yet -- and null is the page
 * saying it does not know. A refetch fired on "unknown" would be a request
 * loop over a project that is simply missing.
 */
export function katalogusElavult(rajzolt: string | null, mert: string | null): boolean {
  if (rajzolt === null || mert === null) return false
  return rajzolt !== mert
}

/**
 * The pictures that actually arrived, without the loading and refused
 * entries: what survives the end of a run, so those cards ask again.
 *
 * A plain function so it can be the `setKepek` updater itself, with no
 * closure and no side effect in it.
 */
export function csakKepek(kepek: Record<string, KepAllapot>): Record<string, KepAllapot> {
  const megmarad: Record<string, KepAllapot> = {}
  for (const [tipus, kep] of Object.entries(kepek)) if (kep.kind === 'kep') megmarad[tipus] = kep
  return megmarad
}

/** What one `templatePreview` answer means for the card, honouring both `hiba` and `ok`. */
function kepAllapotbol(valasz: { dataUrl: string | null; ok: string | null; hiba: string | null }): KepAllapot {
  if (valasz.dataUrl !== null) return { kind: 'kep', dataUrl: valasz.dataUrl }
  if (valasz.hiba !== null) return { kind: 'hiba', szoveg: valasz.hiba }
  return { kind: 'nincs', ok: valasz.ok ?? 'nincs_kep' }
}

/**
 * The half that owns state: the two loads, the poll, the filter, the open
 * card, and the one `IntersectionObserver` that asks for a picture when a
 * card scrolls into view.
 *
 * THE OBSERVER LIVES HERE AND NOT IN THE BODY, deliberately. The body is
 * what the tests render, and they render it on the server where no effect
 * runs and no `IntersectionObserver` exists; a body that reached for one
 * would stop being renderable there and take those tests with it. So the
 * body draws cards that carry `data-tipus`, hands out the grid's ref, and
 * this half attaches one observer over the whole grid.
 *
 * The observer is re-attached when the visible set changes, and again when a
 * run finishes -- a newly observed element fires its callback at once, which
 * is how the cards that were empty during the run get their picture without
 * the operator scrolling. Pictures already loaded are kept across that;
 * only the cards that had none are asked again.
 */
export function Sablonok({ rpc, health }: { rpc: Rpc; health: Health | null }) {
  const [data, setData] = useState<Templates | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [allapot, setAllapot] = useState<PreviewStatus | null>(null)
  const [allapotHiba, setAllapotHiba] = useState<string | null>(null)
  const [szuro, setSzuro] = useState<Szuro>(URES_SZURO)
  const [nyitott, setNyitott] = useState<string | null>(null)
  const [kepek, setKepek] = useState<Record<string, KepAllapot>>({})
  const [futasHibak, setFutasHibak] = useState<Record<string, PreviewHiba>>({})
  const [dolgozik, setDolgozik] = useState(false)
  const [uzenet, setUzenet] = useState<string | null>(null)
  // Bumped when a run ends, so the observer re-attaches and the cards that
  // stayed empty during it ask again.
  const [generacio, setGeneracio] = useState(0)

  const racsRef = useRef<HTMLDivElement | null>(null)
  const kertRef = useRef<Set<string>>(new Set())
  const futottRef = useRef(false)
  // `kepek` for the one reader that runs outside render: the pruning below,
  // which cannot take `kepek` as a dependency without rebuilding the
  // two-second poll on every picture that arrives.
  const kepekRef = useRef<Record<string, KepAllapot>>({})
  useEffect(() => { kepekRef.current = kepek }, [kepek])

  // Bumped when the catalogue on disk turns out to be a different one, so the
  // grid is re-fetched instead of standing as a snapshot of the page load.
  const [katalogusFordulo, setKatalogusFordulo] = useState(0)
  // The grid's own copy of the catalogue hash, readable from the status
  // callback without putting `data` in its dependency list.
  const dataRef = useRef<Templates | null>(null)

  useEffect(() => {
    let stale = false
    rpc('templates')
      .then((raw) => {
        if (stale) return
        const olvasott = readTemplates(raw)
        dataRef.current = olvasott
        setData(olvasott)
        setError(null)
      })
      .catch((err: unknown) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [rpc, katalogusFordulo])

  // `templatePreviewStatus` reads the catalogue on every poll and `templates`
  // read it once, so the status is where a mid-session kit edit shows up
  // first. When the two hashes disagree the grid is drawing a kit that is no
  // longer there; one refetch, and nothing more -- a `templates` that fails
  // leaves `data` as it was, so the hash it carries does not change and this
  // does not retry in a loop.
  //
  // The comparison lives in the status callback below rather than in an effect
  // over `[data, allapot]`. Setting state synchronously inside an effect is
  // what makes a render cascade, and there is nothing to synchronise here: the
  // fact arrives from outside, in a response, which is exactly where the state
  // belongs. `data` is mirrored into a ref because that callback is memoised on
  // `rpc` alone and must not be rebuilt every time the grid reloads -- the
  // two-second interval closes over it.

  const allapotot = useCallback(() => {
    rpc('templatePreviewStatus')
      .then((raw) => {
        const olvasott = readPreviewStatus(raw)
        setAllapot(olvasott)
        setAllapotHiba(null)
        if (katalogusElavult(dataRef.current?.katalogusHash ?? null, olvasott.katalogusHash ?? null)) {
          setKatalogusFordulo((n) => n + 1)
        }
        const fut = olvasott.fut
        if (fut !== null) setFutasHibak((prev) => ({ ...prev, ...fut.hibak }))
        // A run that has ended is the moment the empty cards become
        // fillable, and the only moment this page learns of it.
        const futMost = fut !== null
        if (futottRef.current && !futMost) {
          // The updater is the pure function and NOTHING ELSE. React 19
          // StrictMode double-invokes updaters, so the ref that records what
          // has been asked for is written after the call, from the mirror,
          // rather than from inside it. Idempotent either way -- but a state
          // updater is not a place from which anything outside it is written.
          setKepek(csakKepek)
          kertRef.current = new Set(Object.keys(csakKepek(kepekRef.current)))
          setGeneracio((n) => n + 1)
        }
        futottRef.current = futMost
      })
      .catch((err: unknown) => setAllapotHiba(errorText(err)))
  }, [rpc])

  useEffect(() => { allapotot() }, [allapotot])

  // Two seconds while a run is on, and nothing at all when it is not: this
  // page must not poll a machine that is doing nothing for it.
  useEffect(() => {
    if (allapot === null || allapot.fut === null) return
    const timer = setInterval(allapotot, 2000)
    return () => clearInterval(timer)
  }, [allapot, allapotot])

  const kerKepet = useCallback((tipus: string) => {
    if (kertRef.current.has(tipus)) return
    kertRef.current.add(tipus)
    setKepek((prev) => ({ ...prev, [tipus]: { kind: 'toltes' } }))
    rpc('templatePreview', { tipus })
      .then((raw) => { setKepek((prev) => ({ ...prev, [tipus]: kepAllapotbol(readTemplatePreview(raw)) })) })
      .catch((err: unknown) => { setKepek((prev) => ({ ...prev, [tipus]: { kind: 'hiba', szoveg: errorText(err) } })) })
  }, [rpc])

  // The visible set, recomputed here only to key the observer effect: the
  // body draws from the same pure function, and the observer has to re-attach
  // exactly when the cards in the DOM change and not on every keystroke that
  // leaves them alone.
  const lathatoKulcs = useMemo(() => {
    if (data === null || data.tipusok === null) return ''
    const hasznalatok = data.sablonStat === null
      ? null
      : Object.fromEntries(Object.entries(data.sablonStat).map(([tipus, s]) => [tipus, s.hasznalat]))
    return szurtTipusok({
      tipusok: data.tipusok,
      leirasok: data.leirasok,
      propok: data.propok,
      kuldheto: data.kuldhetoTipusok,
      hasznalat: hasznalatok,
      vanKep: allapot === null ? null : allapot.meglevo,
    }, szuro).join(',')
  }, [data, szuro, allapot])

  useEffect(() => {
    const racs = racsRef.current
    if (racs === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const tipus = (entry.target as HTMLElement).dataset.tipus
        observer.unobserve(entry.target)
        if (typeof tipus === 'string' && tipus !== '') kerKepet(tipus)
      }
      // 200px ahead, so a card is asked for just before it is looked at
      // rather than just after.
    }, { rootMargin: '200px' })
    for (const el of Array.from(racs.querySelectorAll('[data-tipus]'))) observer.observe(el)
    return () => observer.disconnect()
  }, [kerKepet, lathatoKulcs, generacio])

  const general = useCallback(() => {
    setDolgozik(true)
    setUzenet(null)
    rpc('templatePreviewStart')
      .then((raw) => {
        const valasz = readPreviewStart(raw)
        if (valasz.hiba !== null) setUzenet(`A generálás nem indult: ${valasz.hiba}`)
        else if (valasz.ok === 'mar_fut') setUzenet('Már fut egy generálás; ez a kérés nem állt sorba.')
        else if (!valasz.indult) setUzenet('A generálás nem indult el, és a válasz nem mondta meg, miért.')
      })
      .catch((err: unknown) => setUzenet(`A generálás indítása nem sikerült: ${errorText(err)}`))
      .finally(() => { setDolgozik(false); allapotot() })
  }, [rpc, allapotot])

  const megszakit = useCallback(() => {
    rpc('templatePreviewCancel')
      // The contract has exactly one field and it is the answer to the only
      // question this button asks. `megszakitva: false` means the run had
      // already ended before the click arrived -- nothing was stopped -- and
      // saying "elküldtem" over it would report an act that did not happen.
      .then((raw) => {
        setUzenet(readPreviewCancel(raw).megszakitva
          ? 'A megszakítást elküldtem; a már elkészült képek megmaradnak.'
          : 'Nem futott generálás, így nem volt mit megszakítani.')
      })
      .catch((err: unknown) => setUzenet(`A megszakítás nem sikerült: ${errorText(err)}`))
      .finally(allapotot)
  }, [rpc, allapotot])

  if (error && data === null) return <p className="vid-error" role="alert">A sablon-nézetet nem sikerült betölteni: {error}</p>
  if (data === null) return <p className="vid-muted">Betöltés…</p>
  return (
    <>
      {error && <p className="vid-error" role="alert">A frissítés nem sikerült, a lenti állapot a korábbi betöltésé: {error}</p>}
      <SablonokBody
        data={data}
        health={health}
        allapot={allapot}
        allapotHiba={allapotHiba}
        szuro={szuro}
        onSzuro={setSzuro}
        kepek={kepek}
        futasHibak={futasHibak}
        nyitott={nyitott}
        onNyit={setNyitott}
        racsRef={racsRef}
        onGeneral={general}
        onMegszakit={megszakit}
        dolgozik={dolgozik}
        uzenet={uzenet}
        onUzenetZar={() => setUzenet(null)}
      />
    </>
  )
}
