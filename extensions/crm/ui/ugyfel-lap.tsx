import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Event = { id: string; kind: string; occurred_at: string; title: string; excerpt: string }
type SummaryView = { summary: { text: string; covers_event_at: string }; stale: boolean; newerEvents: number }
type Commitment = { id: string; text: string; direction: string; task_id: string | null; status: string }
type Contact = { id: string; name: string; role: string }
type Lap = {
  account: { id: string; name: string; status: string }
  contacts: Contact[]
  events: Event[]
  summary: SummaryView | null
  commitments: Commitment[]
}

export function UgyfelLap({ rpc, accountId, onBack }: { rpc: Rpc; accountId: string; onBack: () => void }) {
  const [lap, setLap] = useState<Lap | null>(null)
  const [hiba, setHiba] = useState('')
  const [jegyzet, setJegyzet] = useState('')

  const tolt = () => {
    rpc('account', { accountId })
      .then((x) => { setLap(x as Lap); setHiba('') })
      .catch((e: Error) => setHiba(e.message))
  }
  useEffect(tolt, [accountId, rpc])

  const jegyzetel = () => {
    if (!jegyzet.trim()) return
    rpc('addNote', { accountId, text: jegyzet })
      .then(() => { setJegyzet(''); tolt() })
      .catch((e: Error) => setHiba(e.message))
  }

  // Ha még semmi nincs betöltve, a hiba a teljes felület: nincs mit megmutatni
  // mögötte. Ha viszont a lap már állt egyszer, egy későbbi hiba (pl. a
  // jegyzetelés hálózati hibája) csak egy sávot kap felül -- az adat, ami már
  // betöltődött, érvényes marad, és nem szabad eldobni.
  if (hiba && !lap) return <p className="crm-hiba" role="alert">{hiba} <button onClick={onBack}>Vissza</button></p>
  if (!lap) return <p>Betöltés…</p>

  return (
    <section>
      <button onClick={onBack}>← Vissza</button>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}
      <h2>{lap.account.name}</h2>

      <h3>Összefoglaló</h3>
      {lap.summary
        ? (
          <div>
            {/* A frissesség tény, nem becslés: a szerver a legfrissebb lefedett
                esemény idejét bélyegezte az összefoglalóra, és ez egy COUNT. */}
            {lap.summary.stale && (
              <p className="crm-elavult">
                Elavult — {lap.summary.newerEvents} új esemény azóta
              </p>
            )}
            <p>{lap.summary.summary.text}</p>
          </div>
        )
        : <p className="crm-halvany">Még nincs összefoglaló.</p>}

      <h3>Nyitott ígéretek</h3>
      {/* A repo `openOnly`-ja (src/db.mjs listCommitments) is így definiálja a
          nyitottat: status = 'open' ÉS nincs task_id. Ma a kettő egybeesik --
          minden ígéret 'open'-ként jön létre --, de csak azért, mert semmi
          nem állít mást. A `task_id`-ra szűrés önmagában akkor is a régi
          eredményt adná, ha egy ígéret státusza már 'done' vagy 'cancelled'
          lenne. */}
      {lap.commitments.filter((c) => c.status === 'open' && !c.task_id).length === 0
        ? <p className="crm-halvany">Nincs nyitott ígéret.</p>
        : (
          <ul>
            {lap.commitments.filter((c) => c.status === 'open' && !c.task_id).map((c) => (
              <li key={c.id}>
                <span className="crm-cimke">{c.direction === 'ours' ? 'Én ígértem' : 'Nekem ígérték'}</span>
                {c.text}
              </li>
            ))}
          </ul>
        )}

      <h3>Kapcsolatok</h3>
      <ul>{lap.contacts.map((c) => <li key={c.id}>{c.name}{c.role && ` — ${c.role}`}</li>)}</ul>

      <h3>Idővonal</h3>
      <div className="crm-sor">
        <input value={jegyzet} onChange={(e) => setJegyzet(e.target.value)}
               placeholder="Jegyzet…" aria-label="Új jegyzet" />
        <button onClick={jegyzetel}>Rögzít</button>
      </div>
      <ul className="crm-idovonal">
        {lap.events.map((e) => (
          <li key={e.id}>
            <time dateTime={e.occurred_at}>{e.occurred_at.slice(0, 16).replace('T', ' ')}</time>
            <span className="crm-cimke">{e.kind}</span>
            {e.title && <strong>{e.title}</strong>} {e.excerpt}
          </li>
        ))}
      </ul>
    </section>
  )
}
