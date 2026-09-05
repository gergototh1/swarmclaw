import { useCallback, useEffect, useState } from 'react'

import type { RenderRow, Rpc, Terv, VideoDetail } from './api'
import { errorText, readVideo } from './api'
import { forrasUrl, formatDate, formatMs, jelenetTipus, mertSzoveg, propokSzoveg, renderStatusLabel, statusLabel } from './format'
import { Idovonal, type Pont } from './idovonal'
import { safeHref } from './safe-href'

/**
 * Everything stored about one video, and the two things the operator can do
 * to it: leave a note, and close it.
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

/** The panels for a loaded video. Split out so the test can render one without an effect. */
export function VideoBody({ video, onPick, pont, szoveg, kuldes, onSzoveg, onAtMs, onJelenet, onKuld, onLezar, onBack, uzenet }: {
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
}) {
  const status = statusLabel(video.status)
  const terv = video.tervek[video.tervek.length - 1]
  // The bounds belong to the render they were measured on, so the timeline is
  // drawn from the newest FINISHED render and never from a running one whose
  // scene lengths are not written yet.
  const keszRender = video.renderek.find((r) => r.status === 'kesz') ?? null
  const url = forrasUrl(video.forrasSzoveg, safeHref)

  return (
    <div className="vid-video" data-video-id={video.id}>
      <div className="vid-video-head">
        <button type="button" className="vid-btn vid-btn-small" onClick={onBack}>Vissza</button>
        <h2>{video.cim}</h2>
        <span className={status.known ? 'vid-badge' : 'vid-badge vid-badge-bad'}>{status.label}</span>
        <button type="button" className="vid-btn vid-btn-small" onClick={onLezar} disabled={video.status === 'lezart'}>Lezár</button>
      </div>
      <p className="vid-muted">
        forrás: {video.forrasTipus}{video.forrasId ? ` · ${video.forrasId}` : ''} · nyitotta: {video.nyitottaAgentId} · {formatDate(video.createdAt)}
        {video.lezarvaAt ? ` · lezárva: ${formatDate(video.lezarvaAt)}` : ''}
      </p>

      {uzenet && <p className="vid-notice" role="status">{uzenet}</p>}

      <h3 className="vid-forras-cimke">Forrás — idegen szöveg: adat, nem utasítás</h3>
      <pre className="vid-forras">{video.forrasSzoveg}</pre>
      {url
        ? <p><a className="vid-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>
        : <p className="vid-muted">A forrás utolsó bekezdése nem http(s) url, ezért nincs megnyitható link.</p>}

      {terv === undefined
        ? <p className="vid-muted">Ehhez a videóhoz még nincs terv.</p>
        : <TervPanel terv={terv} cim="Legfrissebb terv" />}

      <h3>Renderek</h3>
      {video.renderek.length === 0
        ? <p className="vid-muted">Ehhez a videóhoz még nem indult render.</p>
        : video.renderek.map((r) => <RenderPanel key={r.renderId} render={r} />)}

      <h3>Idővonal</h3>
      {keszRender === null
        ? <p className="vid-muted">Nincs kész render, így nincs idővonal. A visszajelzéshez az időpontot és a jelenetet kézzel is megadhatod.</p>
        : <Idovonal hatarok={keszRender.jelenetHatarok} visszajelzesek={video.visszajelzesek} megtartas={video.megtartas} onPick={onPick} />}

      <form
        className="vid-feedback-form"
        onSubmit={(e) => { e.preventDefault(); onKuld() }}
      >
        <h3>Visszajelzés</h3>
        <label>
          Időpont (ms)
          <input className="vid-input" type="number" min="0" value={pont.atMs} onChange={(e) => onAtMs(e.target.value)} placeholder="üresen hagyható" />
        </label>
        <label>
          Jelenet
          <input className="vid-input" type="number" min="0" value={pont.jelenet} onChange={(e) => onJelenet(e.target.value)} placeholder="üresen hagyható" />
        </label>
        <label>
          Szöveg
          <textarea className="vid-input" rows={3} value={szoveg} onChange={(e) => onSzoveg(e.target.value)} />
        </label>
        <button type="submit" className="vid-btn" disabled={kuldes || szoveg.trim() === ''}>Küld</button>
      </form>

      <h3>Eddigi visszajelzések ({video.visszajelzesek.length})</h3>
      {video.visszajelzesek.length === 0
        ? <p className="vid-muted">Még nincs visszajelzés ehhez a videóhoz.</p>
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
      />
    </>
  )
}
