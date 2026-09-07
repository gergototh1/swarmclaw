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

/** A host `/api/tasks` válaszának egy sora -- csak azok a mezők, amiket ez a lap megjelenít. */
type Feladat = {
  id: string
  title: string
  status: string
  dueAt: number | null
  createdAt: number
  customFields?: Record<string, unknown>
}

/**
 * Az ügyfélhez tartozó feladatok, a legfrissebbel elöl.
 *
 * A kapcsolat a `customFields.crm_account` mezőn áll -- ezt az
 * `acceptSuggestion` (`src/rpc.mjs`) írja a feladatra elfogadáskor, lásd ott.
 * A host `/api/tasks` GET-je objektumot ad (id -> feladat), nem tömböt, ezért
 * a szűrés előtt `Object.values`-szel kell listává alakítani.
 */
export function ugyfelFeladatai(feladatok: Record<string, Feladat>, accountId: string): Feladat[] {
  return Object.values(feladatok)
    .filter((f) => f.customFields && f.customFields.crm_account === accountId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * A lapozott idővonal következő állapota: a már látott események, kiegészítve
 * egy újonnan behúzott lappal.
 *
 * A repo (`src/db.mjs` `listEvents`) `beforeId`-vel hívva a `(occurred_at, id)`
 * összetett kulcson lapoz, ugyanazon a rendezésen, mint amivel a lap maga
 * érkezik -- ezért sem duplikálás, sem elhagyás nem fordulhat elő, még akkor
 * sem, ha egy esemény `occurred_at`-ja pontosan egybeesik a határoló
 * (legrégebbi látott) eseményével: a `beforeId` ezt az egyezést dönti el
 * helyesen, ahelyett hogy a szigorú `occurred_at < before` egy ilyen egyező
 * eseményt véglegesen kihagyna. Az itteni id szerinti szűrés emiatt ma is
 * csak védekező jellegű, nem egy ismert hiba ellen szól -- de ártalmatlan,
 * ezért marad.
 */
export function lapozottIdovonal(meglevo: Event[], ujOldal: Event[]): Event[] {
  if (ujOldal.length === 0) return meglevo
  const ismertIdk = new Set(meglevo.map((e) => e.id))
  return [...meglevo, ...ujOldal.filter((e) => !ismertIdk.has(e.id))]
}

/**
 * Az idővonal-elem osztálya az esemény fajtájából.
 *
 * A csomópont kerete jelöli az irányt: a bejövő az akcent, a kimenő a siker
 * színét kapja, minden más semlegeset. Tiszta függvény, mert a „minden
 * ismeretlen fajta is kap valamit" szabály külön tesztelhető kell legyen --
 * enélkül egy új esemény-fajta csomópont nélkül, a sínen kívül jelenne meg.
 */
export function idovonalOsztaly(kind: string): string {
  if (kind === 'email_in') return 'crm-tlitem'
  if (kind === 'email_out') return 'crm-tlitem crm-tl-out'
  return 'crm-tlitem crm-tl-note'
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
  const [feladatok, setFeladatok] = useState<Feladat[] | null>(null)
  const [feladatHiba, setFeladatHiba] = useState('')

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

  /**
   * A feladatlista NEM az extension saját rpc-jén megy: a lap a
   * bejelentkezett origin-en fut, tehát a host `/api/tasks` GET-je
   * közvetlenül hívható, ugyanazzal a munkamenettel, amivel a felület maga
   * be van jelentkezve. Külön hiba-state, saját okkal: egy elhasalt
   * feladat-lekérdezés a lap TÖBBI részét ne vigye magával némán üresbe.
   */
  const feladatokatTolt = () => {
    fetch('/api/tasks')
      .then((res) => {
        if (!res.ok) throw new Error(`feladatlista: HTTP ${res.status}`)
        return res.json() as Promise<Record<string, Feladat>>
      })
      .then((x) => { setFeladatok(ugyfelFeladatai(x, accountId)); setFeladatHiba('') })
      .catch((e: Error) => setFeladatHiba(e.message))
  }
  useEffect(feladatokatTolt, [accountId])
  useEffect(tolt, [accountId, rpc])

  const korabbiak = () => {
    if (!lap || lap.events.length === 0) return
    const legregebbi = lap.events[lap.events.length - 1]
    rpc('timeline', { accountId, before: legregebbi.occurred_at, beforeId: legregebbi.id })
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
  if (hiba && !lap) {
    return (
      <p className="crm-hiba" role="alert">
        {hiba} <button className="crm-btn crm-btn-quiet crm-btn-sm" onClick={onBack}>Vissza</button>
      </p>
    )
  }
  if (!lap) return <p className="crm-empty">Betöltés…</p>

  return (
    <section className="crm-sec-wrap">
      <div className="crm-crumb">
        <button className="crm-btn crm-btn-quiet crm-btn-sm" onClick={onBack}>← Vissza</button>
        <h2 className="crm-h2">{lap.account.name}</h2>
      </div>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      {/*
        F5: a DOM sorrend -- Összefoglaló, majd a "checks" kártyák
        (Nyitott ígéretek / Feladatok / Ügyek / Kapcsolatok), majd az
        Idővonal utoljára -- szándékosan MÁS, mint a széles nézet
        balra/jobbra vizuális elrendezése; a `.crm-cols`
        `grid-template-areas`-a nevesített területekkel rakja a helyükre
        őket (lásd `style.css`). Ez az egyetlen sorrend, ami mindkét
        töréspontnál (860px alatt és fölött) megegyezik a billentyűzetes
        fókuszsorrenddel -- a `.crm-col`-onkénti DOM-csoportosítás 860px
        alatt az idővonalat (akár 50, egyenként teljes email-törzsre
        bővíthető esemény) az ellenőrizendő kártyák FÖLÉ tolta volna,
        pontosan azt a hosszú görgetést reprodukálva, amit ez a feladat meg
        akart szüntetni. */}
      <div className="crm-cols">

        <div className={`crm-card crm-summary${lap.summary && lap.summary.stale ? ' crm-summary-stale' : ''}`}>
          <div className="crm-sechead"><h3>Összefoglaló</h3></div>
          {lap.summary
            ? (
              <>
                {/* A frissesség tény, nem becslés: a szerver a legfrissebb lefedett
                    esemény idejét bélyegezte az összefoglalóra, és ez egy COUNT. */}
                {lap.summary.stale && (
                  <p className="crm-elavult">Elavult — {lap.summary.newerEvents} új esemény azóta</p>
                )}
                <p className="crm-torzs">{lap.summary.summary.text}</p>
              </>
            )
            : <p className="crm-empty">Még nincs összefoglaló.</p>}
        </div>

        <div className="crm-checks">
          {/* Nyitott ígéretek, Feladatok, Ügyek, Kapcsolatok -- mind `crm-card`,
              a soraik `crm-rows` / `crm-row`. A szűrések, az űrlapok, a
              feladat-betöltés hibaága és minden szöveg változatlan. */}

          <div className="crm-card">
            <div className="crm-sechead">
              <h3>Nyitott ígéretek</h3>
              <span className="crm-count">
                {lap.commitments.filter((c) => c.status === 'open' && !c.task_id).length}
              </span>
            </div>
            {/* A repo `openOnly`-ja (src/db.mjs listCommitments) is így definiálja a
                nyitottat: status = 'open' ÉS nincs task_id. Ma a kettő egybeesik --
                minden ígéret 'open'-ként jön létre --, de csak azért, mert semmi
                nem állít mást. A `task_id`-ra szűrés önmagában akkor is a régi
                eredményt adná, ha egy ígéret státusza már 'done' vagy 'cancelled'
                lenne. */}
            {lap.commitments.filter((c) => c.status === 'open' && !c.task_id).length === 0
              ? <p className="crm-empty">Nincs nyitott ígéret.</p>
              : (
                <ul className="crm-rows">
                  {lap.commitments.filter((c) => c.status === 'open' && !c.task_id).map((c) => (
                    <li key={c.id} className="crm-row">
                      <span className={`crm-pill ${c.direction === 'ours' ? 'crm-pill-sajat' : 'crm-pill-idegen'}`}>
                        {c.direction === 'ours' ? 'Én ígértem' : 'Nekem ígérték'}
                      </span>
                      <span className="crm-grow">{c.text}</span>
                    </li>
                  ))}
                </ul>
              )}
          </div>

          <div className="crm-card">
            <div className="crm-sechead">
              <h3>Feladatok</h3>
              {/* F6: amíg a lista be sem töltött (feladatok === null), a jelvény
                  0-t mutatna, miközben a kártya törzse "Feladatok betöltése…"-t
                  ír -- két egymásnak ellentmondó állítás. A jelvény inkább
                  egyáltalán nem jelenik meg, amíg nincs mit számolnia. */}
              {feladatok !== null && <span className="crm-count">{feladatok.length}</span>}
            </div>
            {/* A CRM-3 (7. feladat) elfogadott javaslataiból és lezárt ígéreteiből
                született feladatok -- a host `/api/tasks`-ából, `customFields.crm_account`-ra
                szűrve. Üres lista soha nem marad néma dobozként: vagy mutatja, hogy
                még nincs feladat, vagy a lekérdezés hibáját. */}
            {feladatHiba && <p className="crm-hiba" role="alert">{feladatHiba}</p>}
            {feladatok === null
              ? <p className="crm-empty">Feladatok betöltése…</p>
              : feladatok.length === 0
                ? <p className="crm-empty">Ehhez az ügyfélhez még nincs feladat.</p>
                : (
                  <ul className="crm-rows">
                    {feladatok.map((f) => (
                      <li key={f.id} className="crm-row">
                        <span className="crm-grow">{f.title}</span>
                        <span className="crm-pill crm-pill-plain">{f.status}</span>
                        {f.dueAt
                          ? <time className="crm-age" dateTime={new Date(f.dueAt).toISOString()}>{new Date(f.dueAt).toLocaleDateString('hu-HU')}</time>
                          : <span className="crm-age">nincs határidő</span>}
                      </li>
                    ))}
                  </ul>
                )}
          </div>

          <div className="crm-card">
            <div className="crm-sechead">
              <h3>Ügyek</h3>
              <span className="crm-count">{lap.deals.length}</span>
            </div>
            <div className="crm-toolbar">
              <input value={ujUgy} onChange={(e) => setUjUgy(e.target.value)}
                     placeholder="Ügy címe" aria-label="Új ügy címe" />
              <input type="number" value={ujErtek} onChange={(e) => setUjErtek(e.target.value)}
                     placeholder="Érték (Ft)" aria-label="Új ügy értéke" />
              <select value={ujFajta} onChange={(e) => setUjFajta(e.target.value)} aria-label="Ügy fajtája">
                <option value="lead">Lead</option>
                <option value="engagement">Megbízás</option>
              </select>
              <button className="crm-btn" onClick={ugyet}>Új ügy</button>
            </div>
            {lap.deals.length === 0
              ? <p className="crm-empty">Nincs ügy.</p>
              : (
                <ul className="crm-rows">
                  {lap.deals.map((d) => (
                    <li key={d.id} className="crm-row">
                      <span className="crm-grow">{d.title}</span>
                      <span className="crm-pill crm-pill-plain">{d.closed_at ? 'lezárt' : d.stage}</span>
                      {d.value_huf > 0 && <span className="crm-mono">{d.value_huf.toLocaleString('hu-HU')} Ft</span>}
                    </li>
                  ))}
                </ul>
              )}
          </div>

          <div className="crm-card">
            <div className="crm-sechead">
              <h3>Kapcsolatok</h3>
              <span className="crm-count">{lap.contacts.length}</span>
            </div>
            <div className="crm-toolbar">
              <input value={ujKapcsolat} onChange={(e) => setUjKapcsolat(e.target.value)}
                     placeholder="Név" aria-label="Új kapcsolat neve" />
              <input value={ujSzerep} onChange={(e) => setUjSzerep(e.target.value)}
                     placeholder="Szerep" aria-label="Új kapcsolat szerepe" />
              <button className="crm-btn" onClick={kapcsolatot}>Új kapcsolat</button>
            </div>
            <ul className="crm-rows">
              {lap.contacts.map((c) => (
                <li key={c.id} className="crm-row">
                  <span className="crm-grow">{c.name}{c.role && ` — ${c.role}`}</span>
                  <input value={cimek[c.id] || ''} onChange={(e) => setCimek({ ...cimek, [c.id]: e.target.value })}
                         placeholder="email@cim.hu" aria-label={`${c.name} email-címe`} />
                  <button className="crm-btn" onClick={() => cimet(c.id)}>Cím hozzáadása</button>
                </li>
              ))}
            </ul>
          </div>

        </div>

        <div className="crm-sec crm-timeline">
          <div className="crm-sechead"><h3>Idővonal</h3></div>
          <div className="crm-toolbar">
            <input value={jegyzet} onChange={(e) => setJegyzet(e.target.value)}
                   placeholder="Jegyzet…" aria-label="Új jegyzet" />
            <button className="crm-btn" onClick={jegyzetel}>Rögzít</button>
          </div>
          <ul className="crm-tl">
            {lap.events.map((e) => {
              const teljes = teljesSzovegek[e.id]
              return (
                <li key={e.id} className={idovonalOsztaly(e.kind)}>
                  <span className="crm-tlrail" aria-hidden="true">
                    <span className="crm-tlnode"></span><span className="crm-tlline"></span>
                  </span>
                  <div className="crm-tlbody">
                    <div className="crm-tlmeta">
                      <time className="crm-tltime" dateTime={e.occurred_at}>
                        {e.occurred_at.slice(0, 16).replace('T', ' ')}
                      </time>
                      <span className="crm-pill crm-pill-plain">{e.kind}</span>
                    </div>
                    {e.title && <span className="crm-atttitle">{e.title}</span>}
                    {teljes === undefined
                      ? (
                        <>
                          <span className="crm-attwhy">{e.excerpt}</span>
                          <button className="crm-btn crm-btn-quiet crm-btn-sm"
                                  onClick={() => teljesSzoveget(e.id)}
                                  aria-label={`${e.title || e.kind} teljes szövege`}>Teljes szöveg</button>
                        </>
                      )
                      /* Az idegen szöveg (a levél törzse) sima szövegcsomópontként kerül
                         a JSX-be -- soha nem dangerouslySetInnerHTML-lel --, hogy egy
                         levélbe rejtett jelölés ne válhasson a felület részévé. */
                      : <p className="crm-torzs">{teljes}</p>}
                  </div>
                </li>
              )
            })}
          </ul>
          {!nincsTobbEsemeny && lap.events.length > 0 && (
            <button className="crm-btn crm-btn-quiet crm-btn-sm"
                    onClick={korabbiak} aria-label="Korábbi események betöltése">Korábbiak</button>
          )}
        </div>

      </div>
    </section>
  )
}
