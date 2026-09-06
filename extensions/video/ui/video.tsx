import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { RenderRow, Rpc, Terv, VideoDetail, Visszajelzes } from './api'
import { errorText, readVideo, refusalText } from './api'
import { forrasUrl, formatDate, formatMs, jelenetTipus, mertSzoveg, propokSzoveg, renderStatusLabel, statusLabel } from './format'
import { Idovonal, type Pont } from './idovonal'
import { Lepes } from './lepes'
import type { HostFetch, Megrendeles } from './megrendeles'
import { HOST_FETCH, rendelj } from './megrendeles'
import { safeHref } from './safe-href'

/**
 * Everything stored about one video, and the five things the operator can do
 * to it: ask for its narration, start its render, leave a note, order a fix for
 * the notes already left, and close it.
 *
 * TWO KINDS OF LEVER, AND THE DIFFERENCE IS WHO DOES THE WORK. Narráció
 * kérése and Render indítása need no agent: the sentences were written and
 * passed review before either button appears, and from there the narration is
 * one tts call per scene and the render is a child process -- the same service
 * functions `videoNarrate` and `videoRender` call, run on the spot, answered
 * in the same tick.
 *
 * Terv kérése, Lektorálás kérése and Javítás kérése cannot work that way,
 * because writing a plan, judging one, and reading what the operator wrote
 * about a finished film are judgement and nothing else: there is no service
 * function to call, only a model that has to read prose and choose. So those
 * three do not DO anything -- they ORDER, through `megrendeles.ts`, and what
 * comes back is that an agent turn is on the queue. That turn costs money and
 * runs for minutes, which is why all three say so beside the button while it
 * can still be pressed.
 *
 * WHAT THE DOUBLE-ORDER GUARD ACTUALLY COVERS, SAID EXACTLY. An ordered turn
 * darkens its own lever, and only Frissítés takes it back: WITHIN ONE MOUNT of
 * this view, the operator cannot buy the same turn twice by clicking twice.
 * That is the whole of it. `RendelesAllapot` is component state and nothing
 * else -- no row records that a turn was ordered, and nothing on the page
 * asks -- so leaving the video and opening it again mounts a view whose three
 * ordering levers are live, while a turn ordered from the previous mount may
 * still be running. The operator can buy a second one that way, and there is nothing on
 * this screen that would tell them they had.
 *
 * IT IS ACCEPTED, NOT OVERLOOKED. Closing the hole means the page learning
 * that a turn is out, which means the page watching the turn -- a poller, a
 * stream reader, or a stored order row and a round trip to read it -- and the
 * paragraph below is the reason this view has none of those. What used to
 * stand here was one clause claiming neither lever is one click away from
 * being fired twice, full stop; it was true of the mount and read as a promise
 * about the video, and a reader trusting it would go looking for the state
 * that keeps it.
 *
 * THE PAGE DOES NOT WATCH THE TURN. It does not read the answer stream, does
 * not poll and does not abort -- an abort would cut the turn it just paid for.
 * The proof a turn worked is a plan or a verdict appearing on the next detail
 * load, which is what Frissítés is for, and not anything the agent said on the
 * way there.
 *
 * WHAT IS ON THIS SCREEN AND WHERE IT CAME FROM. The source box holds a
 * stranger's text verbatim and is labelled as such above the box, in the
 * spec's own words; it is a `<pre>` with the text as a React child, so
 * nothing in it is parsed, and it is selectable so the operator can copy it.
 * The scene props are an agent's JSON, printed by `JSON.stringify`. The
 * findings are the reviewing agent's prose. The file paths are text, never
 * links: `safeHref` would refuse a `file:` url anyway, and a path the
 * operator can select and copy is what they actually want. The single link
 * on the page is the source url, and it goes through `safeHref`.
 *
 * A LOAD THAT FAILED IS NOT AN EMPTY VIDEO. A refused `video` call shows its
 * message and draws no panels; a video that loaded once and then failed to
 * reload keeps what was on screen under the message, so the operator can
 * still read it and knows it is stale.
 */

function TervPanel({ terv, cim }: { terv: Terv; cim: string }) {
  const mondat = new Map(terv.narracio.map((n) => [n.jelenet, n.szoveg]))
  const mert = new Map(terv.narraciok.map((n) => [n.jelenet, n.hosszMs]))
  return (
    <section className="vid-terv">
      <h3>{cim} — v{terv.verzio} · {terv.szerzoAgentId} · {formatDate(terv.createdAt)}</h3>
      <p className="vid-mono vid-muted">terv-hash: {terv.tervHash} · katalógus-hash: {terv.katalogusHash}</p>
      {terv.jelenetek.map((jelenet, i) => (
        <div key={i} className="vid-scene" data-jelenet={i}>
          <h4>{i}. jelenet — {jelenetTipus(jelenet)}</h4>
          <pre className="vid-props">{propokSzoveg(jelenet)}</pre>
          <p className="vid-narracio">{mondat.get(i) ?? '(ehhez a jelenethez nincs narráció-mondat)'}</p>
          <p className="vid-muted">
            {/*
              A narration row exists only once `videoNarrate` has run; before
              that the length is not 0, it is unmeasured, and the sentence
              says so.
            */}
            Mért hossz: {mert.has(i) ? formatMs(mert.get(i)) : 'még nincs narráció-fájl, így nincs mért hossz'}
          </p>
        </div>
      ))}
      {terv.verdiktek.length === 0
        ? <p className="vid-muted">Ehhez a tervverzióhoz még nincs lektori ítélet.</p>
        : terv.verdiktek.map((v) => (
          <div key={v.id} className="vid-verdikt">
            <p>
              <strong>{v.verdikt}</strong> · {v.lektorAgentId} · {formatDate(v.at)}
              {v.tervHash !== terv.tervHash && <span className="vid-warn"> · más terv-hashre mondták ki, mint ami most tárolva van</span>}
            </p>
            {v.talalatok.map((t, i) => (
              <p key={i} className="vid-finding" data-jelenet={t.jelenet}>
                {t.jelenet}. jelenet · <span className="vid-mono">{t.kod}</span> · {t.szoveg}
              </p>
            ))}
          </div>
        ))}
    </section>
  )
}

function RenderPanel({ render }: { render: RenderRow }) {
  const qa = render.qa
  return (
    <section className="vid-render">
      <h4>
        {renderStatusLabel(render.status)} · {render.renderId} · indult: {formatDate(render.startedAt)}
        {render.finishedAt ? ` · véget ért: ${formatDate(render.finishedAt)}` : ''}
      </h4>
      <p className="vid-muted">
        {render.hostUjraindult
          ? 'futó render, eltelt idő ismeretlen a host újraindulása óta'
          : `eltelt: ${formatMs(render.elteltMs)}`}
      </p>
      {render.hiba && <p className="vid-bad">Hiba: <span className="vid-mono">{render.hiba.kod}</span> {render.hiba.szoveg ?? ''}</p>}
      <p>Fájl: <span className="vid-path">{render.outPath ?? '(nincs kimeneti út a soron)'}</span></p>
      <p>Log: <span className="vid-path">{render.logPath ?? '(nincs log-út a soron)'}</span></p>
      <p className="vid-mono vid-muted">sha256: {render.fileSha256 ?? '(nincs ujjlenyomat: a fájl nem készült el, vagy nem lett megmérve)'}</p>
      {render.torolveAt && <p className="vid-warn">A fájlok törölve: {formatDate(render.torolveAt)}</p>}
      {qa === null ? (
        <p className="vid-muted">
          {/*
            No QA row and a failed QA are different facts. `qaFor` keys on the
            file's sha256 and the rule set, so a re-render or a rule-set bump
            silently invalidates an old pass -- and the absence that follows
            must not read as one.
          */}
          Ehhez a fájlhoz nincs érvényes QA-sor (nem futott le, vagy a fájl ujjlenyomata azóta megváltozott).
        </p>
      ) : (
        <div className="vid-qa">
          <p className={qa.ok ? '' : 'vid-bad'}>QA: {qa.ok ? 'átment' : 'bukott'}</p>
          <table className="vid-qa-meresek">
            <tbody>
              {Object.entries(qa.meresek).map(([nev, ertek]) => (
                <tr key={nev}><th scope="row" className="vid-mono">{nev}</th><td className="vid-mono">{mertSzoveg(ertek)}</td></tr>
              ))}
            </tbody>
          </table>
          {qa.bukasok.length > 0 && (
            <table className="vid-qa-bukasok">
              <thead><tr><th scope="col">kód</th><th scope="col">név</th><th scope="col">mért</th><th scope="col">küszöb</th></tr></thead>
              <tbody>
                {qa.bukasok.map((b, i) => (
                  <tr key={`${b.kod}-${i}`}>
                    <td className="vid-mono">{b.kod}</td>
                    <td className="vid-mono">{b.nev}</td>
                    <td className="vid-mono">{mertSzoveg(b.mert)}</td>
                    <td className="vid-mono">{mertSzoveg(b.kuszob)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * One titled block of the detail view.
 *
 * WHY THIS EXISTS. Every section used to be a bare `<h3>` followed by whatever
 * it had, all at one level in one div, so a heading with nothing under it took
 * the same weight and the same vertical space as a heading with a render list
 * under it. Five "there is nothing here yet" sentences in a row then read as
 * five findings rather than as five absences.
 *
 * An empty section keeps its heading -- the operator has to be able to see
 * WHICH thing is missing, and the plan section had no heading at all when
 * empty, so its sentence floated with nothing naming it -- but it recedes:
 * dashed border, tighter padding, and the sentence in the small register.
 * Presence advances, absence steps back.
 */
function Szekcio({ cim, jelzo, jelzoRossz, szam, ures, uresSzoveg, children }: {
  cim: string
  jelzo?: string
  jelzoRossz?: boolean
  szam?: number
  ures?: boolean
  uresSzoveg?: string
  children?: ReactNode
}) {
  return (
    <section className={`vid-sec${ures ? ' vid-sec-is-ures' : ''}`}>
      <header className="vid-sec-head">
        <h3>{cim}</h3>
        {jelzo !== undefined && (
          <span className={jelzoRossz ? 'vid-sec-jelzo vid-sec-jelzo-rossz' : 'vid-sec-jelzo'}>{jelzo}</span>
        )}
        {szam !== undefined && <span className="vid-sec-szam">{szam}</span>}
      </header>
      {ures && uresSzoveg !== undefined
        ? <p className="vid-sec-ures">{uresSzoveg}</p>
        : children}
    </section>
  )
}

/**
 * The two agent names, written out again here because this bundle cannot
 * import the file that declares them.
 *
 * `src/agents.mjs` holds `AGENTS`, and its `displayName` fields are exactly
 * these two strings -- but it imports `kit-tabla.mjs`, which imports `node:fs`
 * and `db.mjs`, so reaching them would make esbuild pull the module's whole
 * server side, filesystem calls included, into a browser page for two strings.
 * They are duplicated in ONE place instead, and test/ui.test.mjs -- which runs
 * in node and can import both -- pins them against `AGENTS`, so a rename over
 * there fails the suite here rather than leaving the page ordering a turn from
 * an agent the host does not have.
 *
 * The lookup is by name and not by id because the host mints the id on
 * reconcile: it is different in every install and nothing in this bundle could
 * hold one.
 */
export const GYARTO_NEV = 'Videó Gyártó'
export const LEKTOR_NEV = 'Videó Lektor'

/** What a press costs, said while the button can still be pressed. */
const FORDULO_ARA = 'Ez ügynök-fordulót indít: pénzbe kerül és percekig tarthat.'

/**
 * How far an ordered turn has got, as far as this page can honestly tell.
 *
 * `kuldes` is the three host calls being out and nothing having been ordered
 * yet; `fut` is the instruction having landed on the agent's queue. There is
 * no third value for "finished", and there must not be: the page does not read
 * the turn's stream and does not poll, so the only thing that can end `fut` is
 * the operator pressing Frissítés and reading the reloaded detail.
 */
export type RendelesAllapot = 'kuldes' | 'fut' | null

/**
 * The named refusal a `rendelj` answer carries, or null when a turn really was
 * ordered.
 *
 * The same shape as `refusalText`, and for the same reason: an answer is read
 * for a refusal BEFORE anything on screen claims an act happened. What differs
 * is where the facts come from -- these five are the host's, not the module's
 * -- and that each names the screen the operator fixes it on. A missing agent
 * sends them to Reconcile on the extension's card; a disabled one to the
 * Agents screen; an unreadable list to neither, because the question could not
 * be put at all. One shared sentence would send them to the wrong place, which
 * is worse than saying nothing.
 */
export function megrendelesHiba(valasz: Megrendeles): string | null {
  switch (valasz.kind) {
    case 'elment':
      return null
    case 'ugynokok_olvashatatlanok':
      return `a host ügynök-listája nem volt olvasható (${valasz.reason}), így meg sem tudom keresni, melyik ügynök kapná a munkát`
    case 'nincs_ilyen_ugynok':
      return `a hoston nincs „${valasz.agentNev}” nevű ügynök; az Extensions listában a video extension kártyáján a Reconcile hozza létre`
    case 'ugynok_letiltva':
      return `a(z) „${valasz.agentNev}” ügynök megvan, de le van tiltva, és a host letiltott ügynökre nem nyit beszélgetést; az Agents képernyőn kell újra engedélyezni`
    case 'session_nem_nyilt':
      return `a beszélgetés nem nyílt meg (${valasz.reason})`
    case 'uzenet_elutasitva':
      return `a beszélgetés megnyílt, de az utasítást a host visszautasította (${valasz.reason})`
  }
}

/**
 * Why an ordering lever is dark, in one sentence, or null when it is live.
 *
 * THE SAME ORDER RULE THE TWO MECHANICAL LEVERS FOLLOW. Closure is tested
 * first because the module refuses it first: `videoDraft` weighs
 * `video_lezart` before it looks at a single scene, and `videoVerdict` before
 * it looks at the plan's version. A reason is only worth printing if acting on
 * it makes the button live.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE. Neither asks about verdicts. A plan
 * that already passed may still be reviewed again -- `passingVerdikt` reads
 * the LATEST verdict on the hash, so a second look can reverse the first --
 * and a video that already has a plan may have another written, which is what
 * a plan version IS. Darkening either on "there is one already" would take
 * away exactly the revision the reviewer's findings asked for.
 *
 * The one thing the page can see for itself and the module cannot is that this
 * operator has ALREADY ordered a turn and has not looked since. That is what
 * `allapot` says, and it is the reason these two are dark far more often than
 * the mechanical levers: pressing twice buys two turns.
 */
function tervKeresTiltasOka(lezart: boolean, allapot: RendelesAllapot): string | null {
  if (lezart) return 'A videó le van zárva, a modul nem dolgozik rajta tovább.'
  if (allapot === 'kuldes') return 'A megrendelés elment a hosthoz, a válaszra várok.'
  if (allapot === 'fut') return `A(z) ${GYARTO_NEV} fordulója fut; percekig is eltarthat. A Frissítés gomb mutatja meg, megjelent-e a terv.`
  return null
}

function lektorKeresTiltasOka(terv: Terv | undefined, lezart: boolean, allapot: RendelesAllapot): string | null {
  if (lezart) return 'A videó le van zárva, a modul nem dolgozik rajta tovább.'
  if (terv === undefined) return 'Terv nélkül nincs mit lektorálni.'
  if (allapot === 'kuldes') return 'A megrendelés elment a hosthoz, a válaszra várok.'
  if (allapot === 'fut') return `A(z) ${LEKTOR_NEV} fordulója fut; percekig is eltarthat. A Frissítés gomb mutatja meg, megszületett-e az ítélet.`
  return null
}

/**
 * The Terv section's header line while an ordered turn is out, or undefined.
 *
 * Built from lists and filtered, the way `metaSor` is, because the header has
 * to name WHICH lever it is talking about: both live in this one section, and
 * a bare "a turn is running" over two buttons is a sentence the operator
 * cannot act on.
 *
 * `kuldes` AND `fut` ARE TWO FACTS AND GET TWO CLAUSES. This line used to say
 * "ügynök-forduló megrendelve" for both, which was false of exactly one of
 * them and false at the worst moment: in `kuldes` the three host calls are
 * still out, nothing has been ordered yet, and the lever standing beside this
 * header says so in its own words ("A megrendelés elment a hosthoz, a válaszra
 * várok."). A header claiming a turn was ordered while the button under it
 * says the host has not answered is the one place on this page where the two
 * states the whole ordering flow is built on were drawn as one.
 *
 * So: not-yet-answered orders in one clause, running turns in another, and
 * both when both are true -- the plan can be out at the host while the review
 * is already running.
 */
function forduloJelzo(tervRendeles: RendelesAllapot, lektorRendeles: RendelesAllapot): string | undefined {
  const nevek = (allapot: RendelesAllapot) => [tervRendeles === allapot ? 'terv' : '', lektorRendeles === allapot ? 'lektorálás' : ''].filter((r) => r !== '')
  const kuldes = nevek('kuldes')
  const fut = nevek('fut')
  const reszek = [
    kuldes.length === 0 ? '' : `megrendelés kiküldve, a host válaszára várok: ${kuldes.join(', ')}`,
    fut.length === 0 ? '' : `ügynök-forduló fut: ${fut.join(', ')}`,
  ].filter((r) => r !== '')
  return reszek.length === 0 ? undefined : reszek.join(' · ')
}

/**
 * Why the two mechanical levers are dark, in one sentence each, or null when
 * they are live.
 *
 * A DARK CONTROL ON THIS PAGE EXPLAINS ITSELF. That is the rule the preview
 * button on the Sablonok view is built on, and these two are disabled exactly
 * when one of these functions returns a sentence -- never on a condition that
 * has no sentence, and never with the sentence hidden in a `title=`, which is
 * a tooltip nobody hovers on a button they cannot press.
 *
 * WHAT THE PAGE MAY AND MAY NOT CLAIM. Both levers are re-checked by the
 * module when they are pressed, on facts this page does not have: the render
 * side also weighs the asset fingerprints, the tts voice per scene, the
 * platform, the tools and the browser, and it holds ONE render for the whole
 * module rather than one per video. So these sentences are not a promise that
 * a live button will succeed; they are the states the page can see for
 * itself, said out loud rather than left as a grey rectangle. Every other
 * refusal arrives from the module named, and the notice line prints it.
 *
 * The running render is read off THIS video's rows, which is all the detail
 * response carries, and the sentences say "ezen a videón" for that reason:
 * claiming the module-wide lock from a per-video list would be a fact this
 * page has not measured.
 *
 * THE ORDER OF THE TESTS IS THE MODULE'S OWN ORDER, and that is not a detail.
 * Both functions may be true of several states at once -- a closed video whose
 * plan was never reviewed is both -- and the sentence the operator reads is
 * whichever test comes first. `narralTerv` refuses `video_lezart` BEFORE it
 * looks at the verdict (src/narracio.mjs), and `renderOps.start` does the same
 * (src/render.mjs), so closure is what these two say first as well. It used to
 * come last, and on exactly that video the page asked for a review that would
 * have changed nothing: naming a subordinate reason sends the operator away to
 * do work the binding one makes pointless. A reason is only worth printing if
 * acting on it makes the button live.
 */
function narracioTiltasOka(terv: Terv | undefined, futoRender: RenderRow | null, lezart: boolean, dolgozik: boolean): string | null {
  if (lezart) return 'A videó le van zárva, a modul nem dolgozik rajta tovább.'
  if (terv === undefined) return 'Terv nélkül nincs mit narrálni.'
  // WHY AN ALREADY-NARRATED PLAN STILL OFFERS THE BUTTON. The obvious extra
  // test -- dark once `terv.narraciok` is non-empty, "there is already a
  // narration" -- is deliberately not here. `narraciok` is keyed on
  // `tervHash`, and the detail response carries the rows of the plan as it
  // stands, so an emptiness test would darken the lever exactly after a plan
  // revision, which is the moment narration is most needed and the one moment
  // the rows say nothing about. And a press that turns out to be unnecessary
  // costs nothing: `narralTerv` answers `valtozatlan: true` without a single
  // tts call when every sentence already has its current file, and the notice
  // line prints that answer as its own sentence. A dark button that is wrong
  // is worse than a live one that answers "semmi dolgom volt".
  // `passingVerdikt` answers from the LATEST verdict on (plan, hash), so a
  // pass a reviewer has since reversed is not one (db.mjs). The page reads it
  // the same way, and then tells the three failures apart: never reviewed,
  // reviewed and failed, and passed on a hash the plan no longer has are
  // three different things to do next.
  const ehhezAHashhez = terv.verdiktek.filter((v) => v.tervHash === terv.tervHash)
  const utolso = ehhezAHashhez.length === 0 ? null : ehhezAHashhez[ehhezAHashhez.length - 1]
  if (utolso === null || utolso.verdikt !== 'atmegy') {
    if (utolso !== null) return `A lektor ítélete a jelenlegi terv-hashre: ${utolso.verdikt}; narrálni csak átmegy után lehet.`
    if (terv.verdiktek.some((v) => v.verdikt === 'atmegy')) return 'Van átmegy ítélet erre a tervre, de nem a jelenlegi terv-hashre; a lektornak újra kell néznie.'
    return 'Ehhez a tervverzióhoz még nincs lektori ítélet; narrálni csak átmegy után lehet.'
  }
  if (futoRender !== null) return `Ezen a videón most fut egy render (${futoRender.renderId}); a narráció megvárja a végét.`
  if (dolgozik) return 'A narráció kérése elment, a válaszra várok: jelenetenként egy tts-hívás, ez percekig is eltarthat.'
  return null
}

function renderTiltasOka(terv: Terv | undefined, futoRender: RenderRow | null, lezart: boolean, dolgozik: boolean): string | null {
  // Closure first, for the reason the comment above gives: `renderOps.start`
  // refuses `video_lezart` before it weighs anything else about the plan.
  if (lezart) return 'A videó le van zárva, a modul nem dolgozik rajta tovább.'
  if (terv === undefined) return 'Terv nélkül nincs mit renderelni.'
  // NO VERDICT TEST HERE, AND THAT IS DELIBERATE. `renderOps.start` does
  // require a passing verdict on the current hash, exactly as `narralTerv`
  // does, so the asymmetry with the function above is real. It is here
  // because the narration lever already stands in front of this one: a plan
  // with narration rows is a plan that passed when they were written, so the
  // only way to reach a live Render indítása without a pass is a reviewer
  // reversing a verdict after the narration was made. Repeating the three
  // verdict sentences here would put a second, longer explanation of the
  // review state under a section that is about renders, for a state that is
  // rare and that the module names on the spot: the refusal comes back as
  // `verdikt_hianyzik` or `verdikt_elavult` and the notice line prints it.
  // The honest signal this page has, and no more. `videoRender` checks a
  // narration row PER SCENE, against the current sentence hash, the current
  // tts voice and the file on disk; an empty list is the one half of that the
  // detail response can answer on its own, and the other half stays where it
  // is measured rather than being guessed at here.
  if (terv.narraciok.length === 0) return 'Ehhez a tervhez még nincs narráció-fájl; előbb a Narráció kérése kell.'
  if (futoRender !== null) return `Ezen a videón már fut egy render (${futoRender.renderId}); a modul egyszerre egyet enged.`
  if (dolgozik) return 'A render indítása elment, a válaszra várok.'
  return null
}

/**
 * The operator's fix requests, split by whether a render has answered them.
 *
 * `forras === 'operator'` is the half that matters, and it is `repo.openFeedback`'s
 * own filter said again on this side: an imported row came out of the
 * operator's analytics export and is an OBSERVATION, not a request -- nobody
 * asked for it to be fixed, and no render could honestly close it. The full
 * Visszajelzés list below still draws both, because that list is the record of
 * everything said about this video; these two are the working view of the one
 * thing that has a lifecycle.
 */
const nyitottKeresek = (video: VideoDetail): Visszajelzes[] =>
  video.visszajelzesek.filter((f) => f.forras === 'operator' && f.kezelteRenderId === null)

const lezartKeresek = (video: VideoDetail): Visszajelzes[] =>
  video.visszajelzesek.filter((f) => f.kezelteRenderId !== null)

/**
 * Why Javítás kérése is dark, in one sentence, or null when it is live.
 *
 * THE ORDER IS THE MODULE'S, AND THE FIRST TEST IS THE MODULE'S FIRST TEST.
 * `videoRevise` weighs `video_lezart` before it looks at the parent version,
 * at the verdict chain or at a single request id (src/terv.mjs) -- the same
 * place `videoDraft`, `videoVerdict`, `narralTerv` and `renderOps.start` put
 * it -- so closure is what this lever says first as well. On a closed video
 * with no finished render, naming the render would send the operator to make
 * one the module would then refuse to revise: a reason is only worth printing
 * if acting on it makes the button live.
 *
 * THE NEXT TWO ARE NOT MODULE REFUSALS, AND THEY ARE STILL IN THIS ORDER FOR
 * THE SAME RULE. `videoRevise` has nothing to say about a video that has never
 * rendered; what it has is `javitas_hianyzik`, which is the third test here.
 * The missing render comes first anyway, because writing another request on a
 * video nobody has watched yet would not make this button live, while making
 * the render might.
 *
 * "NINCS NYITOTT KÉRÉS" IS NOT A FAULT, it is the ordinary resting state: the
 * lever is dark because there is nothing to order yet. So the sentence says
 * what to do -- write one -- rather than reporting that something broke.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE. A render running on this video, which
 * `videoRevise` does refuse (`refuseIfRendering`). Neither ordering lever
 * beside it tests it either, though `videoDraft` and `videoVerdict` refuse it
 * just the same: an ordering lever names the facts that make the ORDER
 * pointless, and every other refusal arrives from the module by name, through
 * the turn, where the notice line prints it. Repeating the module's whole
 * refusal list on the page would be a second copy of it to keep in step.
 *
 * `kuldes` AND `fut` GET TWO SENTENCES, exactly as the other two ordering
 * levers do: the three host calls being out and a turn being on an agent's
 * queue are different facts, and only the second one has cost money.
 */
function javitasTiltasOka(video: VideoDetail, nyitott: Visszajelzes[], allapot: RendelesAllapot): string | null {
  if (video.status === 'lezart') return 'A videó le van zárva, a modul nem dolgozik rajta tovább.'
  if (video.renderek.every((r) => r.status !== 'kesz')) return 'Nincs kész render, amire javítást lehetne kérni.'
  if (nyitott.length === 0) return 'Előbb írj legalább egy kérést a fenti űrlappal — globálisan, vagy egy jelenetre.'
  if (allapot === 'kuldes') return 'A megrendelés elment a hosthoz, a válaszra várok.'
  if (allapot === 'fut') return `A(z) ${GYARTO_NEV} javító fordulója fut; percekig is eltarthat. A Frissítés gomb mutatja meg, megszületett-e az új verzió.`
  return null
}

/**
 * The header's second line, with the empty parts left out.
 *
 * Built from a list rather than concatenated, because a video opened by nobody
 * -- `nyitottaAgentId` is empty for a manually created one -- rendered as
 * "nyitotta: ·", a label with no value and a separator with nothing on one
 * side of it.
 */
export function metaSor(video: VideoDetail): string {
  const reszek = [
    `forrás: ${video.forrasTipus}`,
    video.forrasId ? video.forrasId : '',
    video.nyitottaAgentId ? `nyitotta: ${video.nyitottaAgentId}` : '',
    formatDate(video.createdAt),
    video.lezarvaAt ? `lezárva: ${formatDate(video.lezarvaAt)}` : '',
  ]
  return reszek.filter((r) => r !== '').join(' · ')
}

/** The panels for a loaded video. Split out so the test can render one without an effect. */
export function VideoBody({ video, onPick, pont, szoveg, kuldes, onSzoveg, onAtMs, onJelenet, onKuld, onLezar, onBack, onFrissit, uzenet, narralas, renderInditas, tervRendeles, lektorRendeles, javitasRendeles, onNarral, onRenderel, onTervKeres, onLektorKeres, onJavitasKeres }: {
  video: VideoDetail
  pont: { atMs: string; jelenet: string }
  szoveg: string
  kuldes: boolean
  onPick: (pont: Pont) => void
  onSzoveg: (value: string) => void
  onAtMs: (value: string) => void
  onJelenet: (value: string) => void
  onKuld: () => void
  onLezar: () => void
  onBack: () => void
  /** Re-reads the detail and takes back both `fut` states: the operator having looked is the only thing that can end one. */
  onFrissit: () => void
  uzenet: string | null
  /** A `narral` call is out. It runs one tts call per scene, so this state can last minutes and the button says so while it does. */
  narralas: boolean
  renderInditas: boolean
  /** How far each ordered agent turn has got. Separate, because one running turn is no reason to darken the other lever. */
  tervRendeles: RendelesAllapot
  lektorRendeles: RendelesAllapot
  /** The fix order is a third, separate one: it is ordered from the feedback column and has nothing to do with the plan section's two. */
  javitasRendeles: RendelesAllapot
  /** All three take the plan id rather than reading it back out of the video: which plan is the latest is decided here, once, where the panel is drawn. */
  onNarral: (tervId: string) => void
  onRenderel: (tervId: string) => void
  onTervKeres: () => void
  onLektorKeres: (tervId: string) => void
  /** Takes no id: the turn reads the open requests itself with `videoFixes`, so the page names only the video. */
  onJavitasKeres: () => void
}) {
  const status = statusLabel(video.status)
  const terv = video.tervek[video.tervek.length - 1]
  // The bounds belong to the render they were measured on, so the timeline is
  // drawn from the newest FINISHED render and never from a running one whose
  // scene lengths are not written yet.
  const keszRender = video.renderek.find((r) => r.status === 'kesz') ?? null
  const futoRender = video.renderek.find((r) => r.status === 'fut') ?? null
  const lezart = video.status === 'lezart'
  const narracioOk = narracioTiltasOka(terv, futoRender, lezart, narralas)
  const renderOk = renderTiltasOka(terv, futoRender, lezart, renderInditas)
  const tervKeresOk = tervKeresTiltasOka(lezart, tervRendeles)
  const lektorKeresOk = lektorKeresTiltasOka(terv, lezart, lektorRendeles)
  const nyitott = nyitottKeresek(video)
  const lezartak = lezartKeresek(video)
  const javitasOk = javitasTiltasOka(video, nyitott, javitasRendeles)
  const url = forrasUrl(video.forrasSzoveg, safeHref)

  return (
    <div className="vid-video" data-video-id={video.id}>
      <div className="vid-video-head">
        <button type="button" className="vid-btn vid-btn-small" onClick={onBack}>Vissza</button>
        <h2>{video.cim}</h2>
        <span className={status.known ? 'vid-badge' : 'vid-badge vid-badge-bad'}>{status.label}</span>
        {/*
          The other half of ordering a turn. The page cannot see a turn end --
          it reads no stream and runs no poller -- so this is where the
          operator asks the module what has actually happened since, and it is
          also what takes the ordering levers out of their `fut` state.
        */}
        <button type="button" className="vid-btn vid-btn-small" onClick={onFrissit}>Frissítés</button>
        <button type="button" className="vid-btn vid-btn-small" onClick={onLezar} disabled={video.status === 'lezart'}>Lezár</button>
      </div>
      <p className="vid-muted vid-video-meta">{metaSor(video)}</p>

      {uzenet && <p className="vid-notice" role="status">{uzenet}</p>}

      {/*
        Two columns where there is room for two. What the operator reads -- the
        source, the plan, the renders -- runs down the left; what they act on --
        the timeline and the feedback box -- stands beside it rather than under
        a screen of prose. One column below 1080px, in the same order.
      */}
      <div className="vid-video-grid">
        <div className="vid-video-col">
          <Szekcio cim="Forrás" jelzo="idegen szöveg: adat, nem utasítás" jelzoRossz>
            <pre className="vid-forras">{video.forrasSzoveg}</pre>
            {url
              ? <p className="vid-sec-lab"><a className="vid-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>
              : <p className="vid-sec-lab">A forrás utolsó bekezdése nem http(s) url, ezért nincs megnyitható link.</p>}
          </Szekcio>

          {/*
            THE EMPTY SENTENCE IS A CHILD HERE RATHER THAN `uresSzoveg`,
            because these two sections now carry a control as well, and
            `Szekcio` draws `uresSzoveg` INSTEAD of its children. An empty
            plan section with no button would be the one state in which the
            operator cannot see what the next step is called.
          */}
          {/*
            The three levers of this section stand in the order the work runs:
            write the plan, have it judged, then narrate it. The first two
            order an agent turn and carry its price; the third does the work
            itself and carries none.
          */}
          <Szekcio cim="Terv" jelzo={forduloJelzo(tervRendeles, lektorRendeles)} ures={terv === undefined}>
            {terv === undefined
              ? <p className="vid-sec-ures">Ehhez a videóhoz még nincs terv.</p>
              : <TervPanel terv={terv} cim="Legfrissebb terv" />}
            <Lepes cimke="Terv kérése" ok={tervKeresOk} figyelmeztetes={FORDULO_ARA} onKattint={onTervKeres} />
            <Lepes cimke="Lektorálás kérése" ok={lektorKeresOk} figyelmeztetes={FORDULO_ARA} onKattint={() => { if (terv !== undefined) onLektorKeres(terv.id) }} />
            <Lepes cimke="Narráció kérése" ok={narracioOk} onKattint={() => { if (terv !== undefined) onNarral(terv.id) }} />
          </Szekcio>

          <Szekcio cim="Renderek" szam={video.renderek.length} ures={video.renderek.length === 0}>
            {video.renderek.length === 0
              ? <p className="vid-sec-ures">Ehhez a videóhoz még nem indult render.</p>
              : video.renderek.map((r) => <RenderPanel key={r.renderId} render={r} />)}
            <Lepes cimke="Render indítása" ok={renderOk} onKattint={() => { if (terv !== undefined) onRenderel(terv.id) }} />
          </Szekcio>
        </div>

        <div className="vid-video-col">
          <Szekcio
            cim="Idővonal"
            ures={keszRender === null}
            uresSzoveg="Nincs kész render, így nincs idővonal."
          >
            {keszRender !== null && (
              <Idovonal hatarok={keszRender.jelenetHatarok} visszajelzesek={video.visszajelzesek} megtartas={video.megtartas} onPick={onPick} />
            )}
          </Szekcio>

          {/*
            The form and the list are one section, because they are one
            subject. They used to sit apart with the timeline between them, so
            the count of what had been said was a screen away from the box for
            saying more.
          */}
          <Szekcio cim="Visszajelzés" szam={video.visszajelzesek.length}>
            <form className="vid-feedback-form" onSubmit={(e) => { e.preventDefault(); onKuld() }}>
              <div className="vid-feedback-pont">
                <label>
                  Időpont (ms)
                  <input className="vid-input" type="number" min="0" value={pont.atMs} onChange={(e) => onAtMs(e.target.value)} placeholder="üresen hagyható" />
                </label>
                <label>
                  Jelenet
                  <input className="vid-input" type="number" min="0" value={pont.jelenet} onChange={(e) => onJelenet(e.target.value)} placeholder="üresen hagyható" />
                </label>
              </div>
              {/*
                The hint sits on the fields it is about. As a paragraph under
                the timeline it was one more line of grey prose in a column of
                them, and the operator read it nowhere near the inputs.
              */}
              <p className="vid-sec-lab">
                {keszRender === null
                  ? 'Idővonal híján az időpontot és a jelenetet kézzel add meg; mindkettő üresen hagyható.'
                  : 'Kattints az idővonalra a kitöltésükhöz, vagy hagyd üresen mindkettőt.'}
              </p>
              <label>
                Szöveg
                <textarea className="vid-input" rows={3} value={szoveg} onChange={(e) => onSzoveg(e.target.value)} />
              </label>
              <button type="submit" className="vid-btn" disabled={kuldes || szoveg.trim() === ''}>Küld</button>
            </form>

            {video.visszajelzesek.length === 0
              ? <p className="vid-sec-ures">Még nincs visszajelzés ehhez a videóhoz.</p>
              : (
                <ul className="vid-feedback-list">
                  {video.visszajelzesek.map((v) => (
                    <li key={v.id}>
                      <span className="vid-mono">{v.atMs === null ? 'nincs időpont' : formatMs(v.atMs)}</span>
                      {' · '}
                      <span className="vid-mono">{v.jelenet === null ? 'nincs jelenet' : `${v.jelenet}. jelenet`}</span>
                      {' · '}
                      <span className="vid-mono">{v.forras}</span>
                      {' · '}
                      {v.szoveg}
                    </li>
                  ))}
                </ul>
              )}
          </Szekcio>

          {/*
            THE LIFECYCLE, DRAWN AS TWO LISTS RATHER THAN ONE FLAG. The section
            above is the record: everything anyone ever said about this video,
            the imported analytics observations included. These two are the only
            rows that have a lifecycle -- the operator's own requests -- and
            they are apart because the operator does something different with
            each. What is open is what the next fix has to answer, and it stands
            with the lever that orders it. What is closed is evidence, and it
            names the render that closed it: a file the operator can go and
            watch, which "kezelve" as a tick would not be.

            An operator row therefore appears twice on this screen, once in the
            record and once in the list it belongs to. That is deliberate: the
            record answers "what has been said", these answer "what is still
            owed", and folding them together would cost one of the two answers.
          */}
          <Szekcio cim="Nyitott javítás-kérések" szam={nyitott.length} ures={nyitott.length === 0}>
            {/*
              The empty sentence is a CHILD and not `uresSzoveg`, because
              `Szekcio` draws `uresSzoveg` INSTEAD of its children -- and this
              section carries the lever. An empty section with no button would
              be the one state in which the operator cannot see what the next
              step is called.
            */}
            {nyitott.length === 0
              ? <p className="vid-sec-ures">Nincs nyitott kérés ehhez a videóhoz.</p>
              : (
                <ul className="vid-feedback-list">
                  {nyitott.map((v) => (
                    <li key={v.id}>
                      <span className="vid-mono">{v.jelenet === null ? 'globális' : `${v.jelenet}. jelenet`}</span>
                      {' · '}
                      <span className="vid-mono">{v.atMs === null ? 'nincs időpont' : formatMs(v.atMs)}</span>
                      {' · '}
                      {v.szoveg}
                    </li>
                  ))}
                </ul>
              )}
            <Lepes cimke="Javítás kérése" ok={javitasOk} figyelmeztetes={FORDULO_ARA} onKattint={onJavitasKeres} />
          </Szekcio>

          <Szekcio cim="Lezárt javítás-kérések" szam={lezartak.length} ures={lezartak.length === 0}
            uresSzoveg="Egyetlen kérést sem zárt le még render.">
            <ul className="vid-feedback-list vid-lezart-keresek">
              {lezartak.map((v) => (
                <li key={v.id}>
                  <span className="vid-mono">{v.jelenet === null ? 'globális' : `${v.jelenet}. jelenet`}</span>
                  {' · '}
                  <span className="vid-mono">{v.atMs === null ? 'nincs időpont' : formatMs(v.atMs)}</span>
                  {' · '}
                  <span className="vid-mono">{`lezárta: ${v.kezelteRenderId}`}</span>
                  {' · '}
                  {v.szoveg}
                </li>
              ))}
            </ul>
          </Szekcio>
        </div>
      </div>
    </div>
  )
}

/**
 * `hostFetch` defaults to `HOST_FETCH`, which is `megrendeles.ts`'s own
 * module-scope wrapper around the global -- imported rather than written
 * again here, and it is now the module's ONE default. It has to be at module
 * scope somewhere because it is a `useCallback` dependency below and a new
 * function every render would rebuild both ordering handlers every render;
 * and it has to be wrapped rather than passed bare because an unbound `fetch`
 * is an illegal invocation in a browser -- the same wrapping `main.tsx` does
 * for `loadManagedStatus`. This prop is where the default is APPLIED: nothing
 * calls `rendelj` without a fetch any more, which is why `rendelj` no longer
 * carries a defaulted parameter of its own for a caller that never omits it.
 */
export function VideoView({ rpc, id, onBack, hostFetch = HOST_FETCH }: { rpc: Rpc; id: string; onBack: () => void; hostFetch?: HostFetch }) {
  const [video, setVideo] = useState<VideoDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uzenet, setUzenet] = useState<string | null>(null)
  const [atMs, setAtMs] = useState('')
  const [jelenet, setJelenet] = useState('')
  const [szoveg, setSzoveg] = useState('')
  const [kuldes, setKuldes] = useState(false)
  const [narralas, setNarralas] = useState(false)
  const [renderInditas, setRenderInditas] = useState(false)
  const [tervRendeles, setTervRendeles] = useState<RendelesAllapot>(null)
  const [lektorRendeles, setLektorRendeles] = useState<RendelesAllapot>(null)
  const [javitasRendeles, setJavitasRendeles] = useState<RendelesAllapot>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let stale = false
    rpc('video', { id })
      .then((raw) => { if (!stale) { setVideo(readVideo(raw)); setError(null) } })
      .catch((err: unknown) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [rpc, id, reload])

  const onKuld = useCallback(() => {
    setKuldes(true)
    // Blank means "no opinion" all the way down: rpc.mjs treats an absent,
    // null or empty `atMs`/`jelenet` as no opinion and refuses anything else
    // it cannot honour by name, so the raw strings go as they are typed
    // rather than being coerced to 0 here.
    rpc('feedback', { videoId: id, atMs: atMs === '' ? null : atMs, jelenet: jelenet === '' ? null : jelenet, szoveg })
      .then((raw) => {
        const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        setUzenet(r.uj === false ? 'Ez a visszajelzés már szerepelt szó szerint ugyanezen a ponton, új sor nem keletkezett.' : 'A visszajelzés elmentve.')
        setSzoveg('')
        setReload((n) => n + 1)
      })
      .catch((err: unknown) => setUzenet(`A visszajelzés nem mentődött el: ${errorText(err)}`))
      .finally(() => setKuldes(false))
  }, [rpc, id, atMs, jelenet, szoveg])

  const onLezar = useCallback(() => {
    if (!window.confirm('Lezárom ezt a videót. A sorok és a fájlok maradnak, de a modul nem dolgozik rajta tovább. Folytassam?')) return
    rpc('lezar', { videoId: id })
      .then(() => { setUzenet('A videó lezárva.'); setReload((n) => n + 1) })
      .catch((err: unknown) => setUzenet(`A lezárás nem sikerült: ${errorText(err)}`))
  }, [rpc, id])

  /**
   * The two mechanical levers, both read the same way.
   *
   * THREE OUTCOMES, THREE SENTENCES. A resolved answer carrying `hiba` is the
   * module refusing by name and is printed as that name; a resolved answer
   * without one is the act having happened; a rejected promise is the request
   * never having reached the module, which is neither of the other two. The
   * word "sikertelen" appears in none of them, because it would fold the
   * three into one.
   *
   * On anything that happened the detail is reloaded rather than patched from
   * the answer: what the operator then reads -- the measured scene lengths,
   * the new render row and its status -- comes from the module's own rows,
   * and this page never draws a state it inferred from a response.
   */
  const onNarral = useCallback((tervId: string) => {
    setNarralas(true)
    rpc('narral', { tervId })
      .then((raw) => {
        const hiba = refusalText(raw)
        if (hiba !== null) { setUzenet(`A narráció nem készült el — ${hiba}`); return }
        // `valtozatlan` is the module's own word for "every sentence already
        // had its file", and it is not the same event as a set that was just
        // synthesized. Reporting both as "kész" would hide a tts call that
        // never had to happen -- and, on the other side, one that did.
        //
        // The cast is not a shortcut past a check: `refusalText` returns null
        // only after its own `isRecord` has passed, so by this line `raw` has
        // already been proved an object. The guard that used to stand here
        // fell back to `{}` on a branch nothing could reach, which read as if
        // a non-object answer were still possible after the line above.
        const r = raw as Record<string, unknown>
        setUzenet(r.valtozatlan === true
          ? 'A narráció változatlan: minden mondathoz megvolt már a hangfájl.'
          : 'A narráció elkészült; a mért hosszak a jelenetek alatt frissültek.')
        setReload((n) => n + 1)
      })
      .catch((err: unknown) => setUzenet(`A narráció kérése el sem jutott a modulhoz: ${errorText(err)}`))
      .finally(() => setNarralas(false))
  }, [rpc])

  const onRenderel = useCallback((tervId: string) => {
    setRenderInditas(true)
    rpc('renderel', { tervId })
      .then((raw) => {
        const hiba = refusalText(raw)
        if (hiba !== null) { setUzenet(`A render nem indult el — ${hiba}`); return }
        // Started, not finished: the row below says which, and keeps saying
        // it as the render runs.
        setUzenet('A render elindult; az állapotát a Renderek szekció mutatja.')
        setReload((n) => n + 1)
      })
      .catch((err: unknown) => setUzenet(`A render indítása el sem jutott a modulhoz: ${errorText(err)}`))
      .finally(() => setRenderInditas(false))
  }, [rpc])

  /**
   * The two levers the page cannot pull itself, and what they may claim.
   *
   * `rendelj` never rejects -- every one of its three calls carries its own
   * try/catch and its own named answer -- so there is no `.catch` here, and
   * adding one would stand on a branch nothing can reach. What is read instead
   * is `kind`, exactly the way the mechanical levers read `refusalText`: a
   * refusal is printed by name, and only a genuine `elment` may say a turn was
   * ordered.
   *
   * AND "ORDERED" IS ALL IT SAYS. Not written, not reviewed, not finished. The
   * turn is on an agent's queue; whether it produces a plan is between the
   * agent and the module, and the page finds out the same way anyone else
   * would -- by loading the detail again. So the sentence names the agent, says
   * it will take minutes, and points at Frissítés.
   *
   * The instruction names the tool and the id and forbids the rest. These
   * agents can open videos, propose lessons and start renders; a turn the
   * operator paid for to get one plan must not wander into the rest of the
   * queue, and the narrowest instruction that can do the job is the one that
   * costs the least.
   */
  const onTervKeres = useCallback(() => {
    setTervRendeles('kuldes')
    void rendelj({
      agentNev: GYARTO_NEV,
      sessionNev: `Videó terv: ${id}`,
      uzenet: `Írj tervet a ${id} videóhoz a videoDraft toollal. Ne csinálj mást.`,
    }, hostFetch).then((valasz) => {
      const hiba = megrendelesHiba(valasz)
      if (hiba !== null) {
        setUzenet(`A terv kérése nem ment el — ${hiba}`)
        setTervRendeles(null)
        return
      }
      setUzenet(`A terv kérése elment: a(z) ${GYARTO_NEV} fordulója fut. A lap nem olvassa a választ; a Frissítés gomb mutatja meg, megjelent-e a terv.`)
      setTervRendeles('fut')
    })
  }, [id, hostFetch])

  const onLektorKeres = useCallback((tervId: string) => {
    setLektorRendeles('kuldes')
    void rendelj({
      agentNev: LEKTOR_NEV,
      sessionNev: `Videó lektorálás: ${id}`,
      uzenet: `Lektoráld a ${tervId} tervet a videoVerdict toollal. Ne csinálj mást.`,
    }, hostFetch).then((valasz) => {
      const hiba = megrendelesHiba(valasz)
      if (hiba !== null) {
        setUzenet(`A lektorálás kérése nem ment el — ${hiba}`)
        setLektorRendeles(null)
        return
      }
      setUzenet(`A lektorálás kérése elment: a(z) ${LEKTOR_NEV} fordulója fut. A lap nem olvassa a választ; a Frissítés gomb mutatja meg, megszületett-e az ítélet.`)
      setLektorRendeles('fut')
    })
  }, [id, hostFetch])

  /**
   * The third order, and the one the operator's own words set off.
   *
   * IT NAMES BOTH TOOLS AND NOTHING ELSE, and it does not repeat what the tool
   * descriptions already say. `videoRevise` declares its own scope rule --
   * every scene not named is taken over from the parent version unchanged, and
   * a narration line written onto an untouched scene is refused by name -- so
   * the module enforces the narrowness rather than this sentence asking for it.
   * What the message must NOT say is "only touch the scenes the requests are
   * about": a global request is about no scene at all, while `videoRevise`
   * refuses a submission with no rewritten scene, so that instruction would
   * send the turn at a refusal.
   *
   * NO REQUEST IDS IN THE MESSAGE. The turn reads them itself with
   * `videoFixes`, off the module's own rows, at the moment it runs -- which is
   * later than now, and by then the page's copy could be stale.
   *
   * The daily producer run deliberately does not do this work (`GYARTAS_PROMPT`
   * says so in as many words): a fix costs an agent turn just like a new plan,
   * and the daily cap is on OPENING videos, not on fixing them. So this button
   * is the only thing that orders one.
   */
  const onJavitasKeres = useCallback(() => {
    setJavitasRendeles('kuldes')
    void rendelj({
      agentNev: GYARTO_NEV,
      sessionNev: `Videó javítás: ${id}`,
      uzenet: `Az operátor javítást kért a ${id} videóra. Olvasd el a videoFixes-szel a nyitott kéréseket, és add be a javítást a videoRevise-zal: nevezd meg, mely jeleneteket írod át és mely kéréseket dolgozod be. Ne csinálj mást.`,
    }, hostFetch).then((valasz) => {
      const hiba = megrendelesHiba(valasz)
      if (hiba !== null) {
        setUzenet(`A javítás kérése nem ment el — ${hiba}`)
        setJavitasRendeles(null)
        return
      }
      setUzenet(`A javítás kérése elment: a(z) ${GYARTO_NEV} fordulója fut. A lap nem olvassa a választ; a Frissítés gomb mutatja meg, megszületett-e az új verzió.`)
      setJavitasRendeles('fut')
    })
  }, [id, hostFetch])

  /**
   * The operator looking again, which is the only thing that ends a `fut`.
   *
   * There is no poller behind this on purpose. A page that asked the module
   * every few seconds whether the plan had arrived would be running a request
   * loop for every open video for the whole length of a turn, to learn
   * something one press already answers -- and it would still not know when the
   * turn ended, only that a plan had or had not appeared yet.
   *
   * The message is cleared with it: it was about the order, and the reload is
   * the operator saying they have read it. Leaving "a forduló fut" on screen
   * beside a lever that is live again would be the page contradicting itself.
   */
  const onFrissit = useCallback(() => {
    setTervRendeles(null)
    setLektorRendeles(null)
    setJavitasRendeles(null)
    setUzenet(null)
    setReload((n) => n + 1)
  }, [])

  const onPick = useCallback((pont: Pont) => {
    setAtMs(String(pont.atMs))
    setJelenet(pont.jelenet === null ? '' : String(pont.jelenet))
  }, [])

  if (error && video === null) {
    return (
      <div className="vid-video">
        <button type="button" className="vid-btn vid-btn-small" onClick={onBack}>Vissza</button>
        <p className="vid-error" role="alert">Ezt a videót nem sikerült betölteni: {error}</p>
      </div>
    )
  }
  if (video === null) return <p className="vid-muted">Betöltés…</p>

  return (
    <>
      {error && <p className="vid-error" role="alert">A frissítés nem sikerült, a lenti állapot a korábbi betöltésé: {error}</p>}
      <VideoBody
        video={video}
        pont={{ atMs, jelenet }}
        szoveg={szoveg}
        kuldes={kuldes}
        uzenet={uzenet}
        onPick={onPick}
        onSzoveg={setSzoveg}
        onAtMs={setAtMs}
        onJelenet={setJelenet}
        onKuld={onKuld}
        onLezar={onLezar}
        onBack={onBack}
        onFrissit={onFrissit}
        narralas={narralas}
        renderInditas={renderInditas}
        tervRendeles={tervRendeles}
        lektorRendeles={lektorRendeles}
        javitasRendeles={javitasRendeles}
        onNarral={onNarral}
        onRenderel={onRenderel}
        onTervKeres={onTervKeres}
        onLektorKeres={onLektorKeres}
        onJavitasKeres={onJavitasKeres}
      />
    </>
  )
}
