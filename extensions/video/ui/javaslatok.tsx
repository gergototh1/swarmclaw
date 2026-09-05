import { useCallback, useEffect, useState } from 'react'

import type { Proposal, Proposals, Rpc, Sapka } from './api'
import { errorText, readProposals } from './api'
import { fajtaLabel, formatDate, sapkaBetelt, sapkaSzoveg, varakozikLabel } from './format'

/**
 * The daily review's output, and the operator's decision on each item.
 *
 * WHICH CAP GOVERNS WHICH BUTTON. `decideProposal` enforces three numbers and
 * this view shows the same three, each where it actually bites:
 *
 *   - the open cap (20) stops the DAILY RUN from producing more, not the
 *     operator from deciding, so it is a sentence at the top and never
 *     disables a button here -- deciding is the thing that clears it;
 *   - the lesson cap (12 per target) and the backlog caps (10 per kind) stop
 *     an ACCEPTANCE, so on a proposal whose cap is full the `Elfogad` button
 *     is replaced by the sentence naming the refusal code the server would
 *     answer with. The page does not ask and get refused; it says why first.
 *
 * Rejection has no cap and always stays available, but it needs a note: the
 * note is the next review's raw material, which is why `decideProposal`
 * refuses an empty one and why the button here is disabled until there is
 * one, with the sentence beside it.
 *
 * Every proposal's `cim`, `szoveg` and decision note is prose written by the
 * reviewing agent about a stranger's video, and every one of them is a React
 * text child. An evidence id becomes a button only when the board knows it as
 * a video id -- the ids in this module are opaque hex with no prefix, so
 * "which of these is a video" is a question only the board can answer, and
 * guessing would open the wrong screen or none.
 */

function Bizonyitek({ bizonyitek, videoIdk, onOpenVideo }: {
  bizonyitek: unknown
  videoIdk: ReadonlySet<string>
  onOpenVideo: (id: string) => void
}) {
  if (!Array.isArray(bizonyitek)) {
    return <p className="vid-muted">Bizonyíték: {bizonyitek === null || bizonyitek === undefined ? 'nincs' : JSON.stringify(bizonyitek)}</p>
  }
  if (bizonyitek.length === 0) return <p className="vid-muted">Bizonyíték: nincs megadva.</p>
  return (
    <p className="vid-bizonyitek">
      Bizonyíték:{' '}
      {bizonyitek.map((entry, i) => {
        const text = typeof entry === 'string' ? entry : JSON.stringify(entry)
        const nyithato = typeof entry === 'string' && videoIdk.has(entry)
        return (
          <span key={`${text}-${i}`}>
            {i > 0 ? ', ' : ''}
            {nyithato
              ? <button type="button" className="vid-linklike" onClick={() => onOpenVideo(entry)}>{text}</button>
              : <span className="vid-mono">{text}</span>}
          </span>
        )
      })}
    </p>
  )
}

/** The cap that governs accepting this proposal, and the code the server would refuse with. */
function elfogadasSapka(p: Proposal, sapkak: Proposals['sapkak']): { sapka: Sapka | null; kod: string } {
  if (p.fajta === 'tanulsag') return { sapka: sapkak.tanulsag[p.cel] ?? null, kod: 'tanulsag_sapka' }
  if (p.fajta === 'szabaly') return { sapka: sapkak.backlog.szabaly, kod: 'backlog_sapka' }
  if (p.fajta === 'sablon') return { sapka: sapkak.backlog.sablon, kod: 'backlog_sapka' }
  return { sapka: null, kod: 'backlog_sapka' }
}

function NyitottJavaslat({ p, sapkak, dont, dolgozik, videoIdk, onOpenVideo }: {
  p: Proposal
  sapkak: Proposals['sapkak']
  dont: (id: string, dontes: 'elfogad' | 'elutasit', megjegyzes: string) => void
  dolgozik: boolean
  videoIdk: ReadonlySet<string>
  onOpenVideo: (id: string) => void
}) {
  const [megjegyzes, setMegjegyzes] = useState('')
  const { sapka, kod } = elfogadasSapka(p, sapkak)
  const betelt = sapka !== null && sapkaBetelt(sapka.db, sapka.sapka)
  return (
    <div className="vid-proposal" data-id={p.id}>
      <h4>{p.cim}</h4>
      <p className="vid-muted">{fajtaLabel(p.fajta)} · cél: {p.cel} · {formatDate(p.createdAt)}</p>
      <p className="vid-proposal-text">{p.szoveg}</p>
      <Bizonyitek bizonyitek={p.bizonyitek} videoIdk={videoIdk} onOpenVideo={onOpenVideo} />
      <label>
        Megjegyzés
        <textarea className="vid-input" rows={2} value={megjegyzes} onChange={(e) => setMegjegyzes(e.target.value)} />
      </label>
      <div className="vid-proposal-actions">
        {betelt && sapka !== null
          ? <p className="vid-warn vid-sapka-mondat">{kod}: {sapkaSzoveg(sapka.db, sapka.sapka)} — betelt, előbb dönteni kell egy másikról vagy visszavonni egyet.</p>
          : <button type="button" className="vid-btn vid-accept" disabled={dolgozik} onClick={() => dont(p.id, 'elfogad', megjegyzes)}>Elfogad</button>}
        <button type="button" className="vid-btn vid-reject" disabled={dolgozik || megjegyzes.trim() === ''} onClick={() => dont(p.id, 'elutasit', megjegyzes)}>Elutasít</button>
        {megjegyzes.trim() === '' && <span className="vid-muted">az elutasításhoz megjegyzés kell</span>}
      </div>
    </div>
  )
}

/** The view for one loaded `proposals` response. Split out so the test can render a state without an effect. */
export function JavaslatokBody({ data, videoIdk, onOpenVideo, dont, visszavon, dolgozik, uzenet }: {
  data: Proposals
  videoIdk: ReadonlySet<string>
  onOpenVideo: (id: string) => void
  dont: (id: string, dontes: 'elfogad' | 'elutasit', megjegyzes: string) => void
  visszavon: (id: string) => void
  dolgozik: boolean
  uzenet: string | null
}) {
  const { sapkak } = data
  const nyitottBetelt = sapkaBetelt(sapkak.nyitottJavaslat.db, sapkak.nyitottJavaslat.sapka)
  const celok = Object.keys(sapkak.tanulsag).sort()
  const fajtak = [...new Set(data.nyitott.map((p) => p.fajta))].sort()

  return (
    <div className="vid-javaslatok">
      <p className="vid-sapkak">
        <span>Nyitott {sapkaSzoveg(sapkak.nyitottJavaslat.db, sapkak.nyitottJavaslat.sapka)}</span>
        <span>Tanulságok {celok.map((cel) => `${cel} ${sapkaSzoveg(sapkak.tanulsag[cel].db, sapkak.tanulsag[cel].sapka)}`).join(', ')}</span>
        <span>Backlog szabaly {sapkaSzoveg(sapkak.backlog.szabaly.db, sapkak.backlog.szabaly.sapka)}, sablon {sapkaSzoveg(sapkak.backlog.sablon.db, sapkak.backlog.sablon.sapka)}</span>
      </p>
      {nyitottBetelt && (
        <p className="vid-warn vid-sapka-mondat">{sapkak.nyitottJavaslat.sapka} nyitott javaslat, előbb dönteni kell — a napi futás addig nem termel újat.</p>
      )}
      {data.katalogusHiba && (
        <p className="vid-warn">
          {/* A `sablon` proposal names a catalogue type; without a readable catalogue nothing can say whether the kit already has it. */}
          A katalógus nem olvasható ({data.katalogusHiba}), ezért a sablon-javaslatokról nem látszik, hogy a kit közben megkapta-e őket.
        </p>
      )}
      {uzenet && <p className="vid-notice" role="status">{uzenet}</p>}

      <h3>Nyitott javaslatok</h3>
      {data.nyitott.length === 0
        ? <p className="vid-muted">Nincs nyitott javaslat.</p>
        : fajtak.map((fajta) => (
          <section key={fajta}>
            <h4>{fajtaLabel(fajta)}</h4>
            {data.nyitott.filter((p) => p.fajta === fajta).map((p) => (
              <NyitottJavaslat key={p.id} p={p} sapkak={sapkak} dont={dont} dolgozik={dolgozik} videoIdk={videoIdk} onOpenVideo={onOpenVideo} />
            ))}
          </section>
        ))}

      <h3>Backlog</h3>
      {data.backlog.length === 0
        ? <p className="vid-muted">A backlog üres.</p>
        : (
          <ul className="vid-backlog">
            {data.backlog.map((p) => (
              <li key={p.id} data-id={p.id}>{p.cim} — {fajtaLabel(p.fajta)}: {varakozikLabel(p.fajta)}</li>
            ))}
          </ul>
        )}

      <h3>Aktív tanulságok</h3>
      {celok.map((cel) => {
        const c = data.tanulsagok[cel]
        if (c === undefined) return null
        return (
          <section key={cel}>
            <h4>{cel} ({sapkaSzoveg(c.db, c.sapka)})</h4>
            {c.tetelek.length === 0
              ? <p className="vid-muted">Ezen a célon nincs aktív tanulság.</p>
              : c.tetelek.map((t) => (
                <div key={t.id} className="vid-lesson" data-id={t.id}>
                  <p>{t.szoveg}</p>
                  <p className="vid-muted">{formatDate(t.createdAt)}</p>
                  <button type="button" className="vid-btn vid-btn-small" disabled={dolgozik} onClick={() => visszavon(t.id)}>Visszavon</button>
                </div>
              ))}
          </section>
        )
      })}

      <h3>Elutasítva (az elmúlt 30 nap)</h3>
      {data.elutasitott.length === 0
        ? <p className="vid-muted">Ebben az ablakban nincs elutasított javaslat.</p>
        : (
          <ul className="vid-rejected">
            {data.elutasitott.map((p) => (
              <li key={p.id} data-id={p.id}>
                {p.cim} — {formatDate(p.decidedAt)} — {p.dontesMegjegyzes ?? '(nincs megjegyzés a soron)'}
              </li>
            ))}
          </ul>
        )}

      <h3>Kódolva</h3>
      {data.kodolva.length === 0
        ? <p className="vid-muted">Egyetlen elfogadott javaslat sem került még be kódként vagy sablonként.</p>
        : (
          <ul className="vid-kodolva">
            {data.kodolva.map((p) => <li key={p.id} data-id={p.id}>{p.cim} — {fajtaLabel(p.fajta)}</li>)}
          </ul>
        )}
    </div>
  )
}

export function Javaslatok({ rpc, videoIdk, onOpenVideo }: { rpc: Rpc; videoIdk: ReadonlySet<string>; onOpenVideo: (id: string) => void }) {
  const [data, setData] = useState<Proposals | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uzenet, setUzenet] = useState<string | null>(null)
  const [dolgozik, setDolgozik] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let stale = false
    rpc('proposals')
      .then((raw) => { if (!stale) { setData(readProposals(raw)); setError(null) } })
      .catch((err: unknown) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [rpc, reload])

  const dont = useCallback((id: string, dontes: 'elfogad' | 'elutasit', megjegyzes: string) => {
    setDolgozik(true)
    rpc('decideProposal', { id, dontes, megjegyzes })
      .then(() => { setUzenet(dontes === 'elfogad' ? 'Elfogadva.' : 'Elutasítva.'); setReload((n) => n + 1) })
      .catch((err: unknown) => setUzenet(`A döntés nem mentődött el: ${errorText(err)}`))
      .finally(() => setDolgozik(false))
  }, [rpc])

  const visszavon = useCallback((id: string) => {
    setDolgozik(true)
    rpc('retireLesson', { id })
      .then(() => { setUzenet('A tanulság visszavonva.'); setReload((n) => n + 1) })
      .catch((err: unknown) => setUzenet(`A visszavonás nem sikerült: ${errorText(err)}`))
      .finally(() => setDolgozik(false))
  }, [rpc])

  if (error && data === null) {
    return <p className="vid-error" role="alert">A javaslatokat nem sikerült betölteni: {error}</p>
  }
  if (data === null) return <p className="vid-muted">Betöltés…</p>

  return (
    <>
      {error && <p className="vid-error" role="alert">A frissítés nem sikerült, a lenti állapot a korábbi betöltésé: {error}</p>}
      <JavaslatokBody data={data} videoIdk={videoIdk} onOpenVideo={onOpenVideo} dont={dont} visszavon={visszavon} dolgozik={dolgozik} uzenet={uzenet} />
    </>
  )
}
