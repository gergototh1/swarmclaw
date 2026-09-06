import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { RenderRow, Rpc, Terv, VideoDetail } from './api'
import { errorText, readVideo, refusalText } from './api'
import { forrasUrl, formatDate, formatMs, jelenetTipus, mertSzoveg, propokSzoveg, renderStatusLabel, statusLabel } from './format'
import { Idovonal, type Pont } from './idovonal'
import { safeHref } from './safe-href'

/**
 * Everything stored about one video, and the four things the operator can do
 * to it: ask for its narration, start its render, leave a note, and close it.
 *
 * THE TWO LEVERS ARE HERE BECAUSE NOTHING ABOUT THEM NEEDS AN AGENT. The
 * sentences were written and passed review before either button appears; from
 * there the narration is one tts call per scene and the render is a child
 * process, and both are the same service functions the `videoNarrate` and
 * `videoRender` tools call. Writing the plan and reviewing it are the two
 * steps that do need judgement, and neither has a button on this page.
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
 */
function narracioTiltasOka(terv: Terv | undefined, futoRender: RenderRow | null, lezart: boolean, dolgozik: boolean): string | null {
  if (terv === undefined) return 'Terv nélkül nincs mit narrálni.'
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
  if (lezart) return 'A videó le van zárva, a modul nem dolgozik rajta tovább.'
  if (dolgozik) return 'A narráció kérése elment, a válaszra várok: jelenetenként egy tts-hívás, ez percekig is eltarthat.'
  return null
}

function renderTiltasOka(terv: Terv | undefined, futoRender: RenderRow | null, lezart: boolean, dolgozik: boolean): string | null {
  if (terv === undefined) return 'Terv nélkül nincs mit renderelni.'
  // The honest signal this page has, and no more. `videoRender` checks a
  // narration row PER SCENE, against the current sentence hash, the current
  // tts voice and the file on disk; an empty list is the one half of that the
  // detail response can answer on its own, and the other half stays where it
  // is measured rather than being guessed at here.
  if (terv.narraciok.length === 0) return 'Ehhez a tervhez még nincs narráció-fájl; előbb a Narráció kérése kell.'
  if (futoRender !== null) return `Ezen a videón már fut egy render (${futoRender.renderId}); a modul egyszerre egyet enged.`
  if (lezart) return 'A videó le van zárva, a modul nem dolgozik rajta tovább.'
  if (dolgozik) return 'A render indítása elment, a válaszra várok.'
  return null
}

/** A lever and, when it is dark, the sentence saying why. */
function Lepes({ cimke, ok, onKattint }: { cimke: string; ok: string | null; onKattint: () => void }) {
  return (
    <div className="vid-lepes">
      <button type="button" className="vid-btn" disabled={ok !== null} onClick={onKattint}>{cimke}</button>
      {ok !== null && <span className="vid-muted vid-lepes-ok">{ok}</span>}
    </div>
  )
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
export function VideoBody({ video, onPick, pont, szoveg, kuldes, onSzoveg, onAtMs, onJelenet, onKuld, onLezar, onBack, uzenet, narralas, renderInditas, onNarral, onRenderel }: {
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
  uzenet: string | null
  /** A `narral` call is out. It runs one tts call per scene, so this state can last minutes and the button says so while it does. */
  narralas: boolean
  renderInditas: boolean
  /** Both take the plan id rather than reading it back out of the video: which plan is the latest is decided here, once, where the panel is drawn. */
  onNarral: (tervId: string) => void
  onRenderel: (tervId: string) => void
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
  const url = forrasUrl(video.forrasSzoveg, safeHref)

  return (
    <div className="vid-video" data-video-id={video.id}>
      <div className="vid-video-head">
        <button type="button" className="vid-btn vid-btn-small" onClick={onBack}>Vissza</button>
        <h2>{video.cim}</h2>
        <span className={status.known ? 'vid-badge' : 'vid-badge vid-badge-bad'}>{status.label}</span>
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
          <Szekcio cim="Terv" ures={terv === undefined}>
            {terv === undefined
              ? <p className="vid-sec-ures">Ehhez a videóhoz még nincs terv.</p>
              : <TervPanel terv={terv} cim="Legfrissebb terv" />}
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
        </div>
      </div>
    </div>
  )
}

export function VideoView({ rpc, id, onBack }: { rpc: Rpc; id: string; onBack: () => void }) {
  const [video, setVideo] = useState<VideoDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uzenet, setUzenet] = useState<string | null>(null)
  const [atMs, setAtMs] = useState('')
  const [jelenet, setJelenet] = useState('')
  const [szoveg, setSzoveg] = useState('')
  const [kuldes, setKuldes] = useState(false)
  const [narralas, setNarralas] = useState(false)
  const [renderInditas, setRenderInditas] = useState(false)
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
        const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
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
        narralas={narralas}
        renderInditas={renderInditas}
        onNarral={onNarral}
        onRenderel={onRenderel}
      />
    </>
  )
}
