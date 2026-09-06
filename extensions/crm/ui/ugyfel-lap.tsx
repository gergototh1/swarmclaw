import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Event = { id: string; kind: string; occurred_at: string; title: string; excerpt: string }
type SummaryView = { summary: { text: string; covers_event_at: string }; stale: boolean; newerEvents: number }
type Commitment = { id: string; text: string; direction: string; task_id: string | null; status: string }
type Contact = { id: string; name: string; role: string }
type Deal = { id: string; title: string; stage: string; value_huf: number; closed_at: string | null }
type Lap = {
  account: { id: string; name: string; status: string }
  contacts: Contact[]
  deals: Deal[]
  events: Event[]
  summary: SummaryView | null
  commitments: Commitment[]
}

/**
 * A lapozott idővonal következő állapota: a már látott események, kiegészítve
 * egy újonnan behúzott lappal.
 *
 * A repo (`src/db.mjs` `listEvents`) szigorú `occurred_at < ?` határral lapoz,
 * ezért egy már látott esemény nem térhet vissza egy későbbi lapon -- az itteni
 * id szerinti szűrés csak védekező jellegű, nem egy ismert hiba ellen szól.
 * A határ valódi kockázata a fordítottja: ha egy esemény `occurred_at`-ja
 * pontosan egybeesik a határoló (legrégebbi látott) eseményével, de az nem
 * fért rá az előző lapra, akkor egyetlen későbbi lekérés sem kéri le --
 * `< before` nem engedi át --, így az az esemény véglegesen kimarad a
 * nézetből. Ennek orvoslásához a lapozásnak a `occurred_at`-nál finomabb
 * (pl. id szerinti másodlagos) rendezésre és határra lenne szüksége, ami
 * `src/db.mjs`-t érintené -- ezen a fájlon kívül esik.
 */
export function lapozottIdovonal(meglevo: Event[], ujOldal: Event[]): Event[] {
  if (ujOldal.length === 0) return meglevo
  const ismertIdk = new Set(meglevo.map((e) => e.id))
  return [...meglevo, ...ujOldal.filter((e) => !ismertIdk.has(e.id))]
}

export function UgyfelLap({ rpc, accountId, onBack }: { rpc: Rpc; accountId: string; onBack: () => void }) {
  const [lap, setLap] = useState<Lap | null>(null)
  const [hiba, setHiba] = useState('')
  const [jegyzet, setJegyzet] = useState('')
  const [ujKapcsolat, setUjKapcsolat] = useState('')
  const [ujSzerep, setUjSzerep] = useState('')
  const [cimek, setCimek] = useState<Record<string, string>>({})
  const [ujUgy, setUjUgy] = useState('')
  const [ujErtek, setUjErtek] = useState('')
  const [ujFajta, setUjFajta] = useState('lead')
  const [nincsTobbEsemeny, setNincsTobbEsemeny] = useState(false)
  const [teljesSzovegek, setTeljesSzovegek] = useState<Record<string, string>>({})

  const tolt = () => {
    rpc('account', { accountId })
      .then((x) => {
        setLap(x as Lap)
        setHiba('')
        // Egy teljes lapújratöltés friss (legfeljebb 50, legújabb) eseményt
        // hoz -- a korábbi lapozás állapota és a megnyitott teljes szövegek
        // ehhez képest elavultak, különben egy régi esemény azonosítója alatt
        // egy másik esemény törzse jelenhetne meg.
        setNincsTobbEsemeny(false)
        setTeljesSzovegek({})
      })
      .catch((e: Error) => setHiba(e.message))
  }
  useEffect(tolt, [accountId, rpc])

  const korabbiak = () => {
    if (!lap || lap.events.length === 0) return
    const legregebbi = lap.events[lap.events.length - 1]
    rpc('timeline', { accountId, before: legregebbi.occurred_at })
      .then((x) => {
        const uj = (x as { events: Event[] }).events
        if (uj.length === 0) { setNincsTobbEsemeny(true); return }
        // Funkcionális frissítő: a válasz akkor is a beérkezéskori (nem a
        // kattintáskori) lapra épül, ha közben pl. egy jegyzetelés újratöltötte
        // a lapot. Ha a lap időközben null lett, nincs mire visszaírni.
        setLap((elozo) => (elozo ? { ...elozo, events: lapozottIdovonal(elozo.events, uj) } : elozo))
        setHiba('')
      })
      .catch((e: Error) => setHiba(e.message))
  }

  const teljesSzoveget = (eventId: string) => {
    rpc('eventBody', { eventId })
      .then((x) => {
        const tartalom = (x as { content: string }).content
        setTeljesSzovegek((elozo) => ({ ...elozo, [eventId]: tartalom }))
        setHiba('')
      })
      .catch((e: Error) => setHiba(e.message))
  }

  const jegyzetel = () => {
    if (!jegyzet.trim()) return
    rpc('addNote', { accountId, text: jegyzet })
      .then(() => { setJegyzet(''); tolt() })
      .catch((e: Error) => setHiba(e.message))
  }

  const kapcsolatot = () => {
    if (!ujKapcsolat.trim()) return
    rpc('createContact', { accountId, name: ujKapcsolat, role: ujSzerep })
      .then(() => { setUjKapcsolat(''); setUjSzerep(''); tolt() })
      .catch((e: Error) => setHiba(e.message))
  }

  const cimet = (contactId: string) => {
    const cim = (cimek[contactId] || '').trim()
    if (!cim) return
    rpc('attachEmail', { contactId, address: cim })
      .then(() => { setCimek({ ...cimek, [contactId]: '' }); tolt() })
      .catch((e: Error) => setHiba(e.message))
  }

  const ugyet = () => {
    if (!ujUgy.trim()) return
    rpc('createDeal', { accountId, kind: ujFajta, title: ujUgy, valueHuf: Number(ujErtek) || 0 })
      .then(() => { setUjUgy(''); setUjErtek(''); tolt() })
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

      <h3>Ügyek</h3>
      <div className="crm-sor">
        <input value={ujUgy} onChange={(e) => setUjUgy(e.target.value)}
               placeholder="Ügy címe" aria-label="Új ügy címe" />
        <input type="number" value={ujErtek} onChange={(e) => setUjErtek(e.target.value)}
               placeholder="Érték (Ft)" aria-label="Új ügy értéke" />
        <select value={ujFajta} onChange={(e) => setUjFajta(e.target.value)} aria-label="Ügy fajtája">
          <option value="lead">Lead</option>
          <option value="engagement">Megbízás</option>
        </select>
        <button onClick={ugyet}>Új ügy</button>
      </div>
      {lap.deals.length === 0
        ? <p className="crm-halvany">Nincs ügy.</p>
        : (
          <ul className="crm-lista">
            {lap.deals.map((d) => (
              <li key={d.id}>
                {d.title}
                <span className="crm-cimke">{d.closed_at ? 'lezárt' : d.stage}</span>
                {d.value_huf > 0 && <span>{d.value_huf.toLocaleString('hu-HU')} Ft</span>}
              </li>
            ))}
          </ul>
        )}

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
      <div className="crm-sor">
        <input value={ujKapcsolat} onChange={(e) => setUjKapcsolat(e.target.value)}
               placeholder="Név" aria-label="Új kapcsolat neve" />
        <input value={ujSzerep} onChange={(e) => setUjSzerep(e.target.value)}
               placeholder="Szerep" aria-label="Új kapcsolat szerepe" />
        <button onClick={kapcsolatot}>Új kapcsolat</button>
      </div>
      <ul>
        {lap.contacts.map((c) => (
          <li key={c.id}>
            {c.name}{c.role && ` — ${c.role}`}
            <input value={cimek[c.id] || ''} onChange={(e) => setCimek({ ...cimek, [c.id]: e.target.value })}
                   placeholder="email@cim.hu" aria-label={`${c.name} email-címe`} />
            <button onClick={() => cimet(c.id)}>Cím hozzáadása</button>
          </li>
        ))}
      </ul>

      <h3>Idővonal</h3>
      <div className="crm-sor">
        <input value={jegyzet} onChange={(e) => setJegyzet(e.target.value)}
               placeholder="Jegyzet…" aria-label="Új jegyzet" />
        <button onClick={jegyzetel}>Rögzít</button>
      </div>
      <ul className="crm-idovonal">
        {lap.events.map((e) => {
          const teljes = teljesSzovegek[e.id]
          return (
            <li key={e.id}>
              <time dateTime={e.occurred_at}>{e.occurred_at.slice(0, 16).replace('T', ' ')}</time>
              <span className="crm-cimke">{e.kind}</span>
              {e.title && <strong>{e.title}</strong>}
              {teljes === undefined
                ? (
                  <>
                    {' '}{e.excerpt}
                    <button onClick={() => teljesSzoveget(e.id)}
                            aria-label={`${e.title || e.kind} teljes szövege`}>Teljes szöveg</button>
                  </>
                )
                /* Az idegen szöveg (a levél törzse) sima szövegcsomópontként kerül
                   a JSX-be -- soha nem dangerouslySetInnerHTML-lel --, hogy egy
                   levélbe rejtett jelölés ne válhasson a felület részévé. */
                : <p className="crm-torzs">{teljes}</p>}
            </li>
          )
        })}
      </ul>
      {!nincsTobbEsemeny && lap.events.length > 0 && (
        <button onClick={korabbiak} aria-label="Korábbi események betöltése">Korábbiak</button>
      )}
    </section>
  )
}
