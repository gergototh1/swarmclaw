import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Deal = { id: string; account_id: string; kind: string; title: string; stage: string; value_huf: number }
type Account = { id: string; name: string }

/** A lead útja. A `won` és a `lost` végállapot; oda a lezárás visz, nem a léptetés. */
export const SZAKASZOK = ['new', 'talking', 'proposal', 'negotiation'] as const
/**
 * A szakaszok magyar nevei. EXPORTÁLT, mert ugyanezt a szótárt az ügyfél lap
 * ügy-listája is használja (`ugyfel-lap.tsx`) -- ott korábban a nyers `stage`
 * érték jelent meg (`new`, `proposal`), egy sorral a magyar „lezárt" alatt.
 * Két külön másolat helyett egy szótár, egy helyen karbantartva.
 */
export const SZAKASZ_NEV: Readonly<Record<string, string>> = Object.freeze({
  new: 'Új', talking: 'Egyeztetés', proposal: 'Ajánlat', negotiation: 'Tárgyalás',
  won: 'Nyert', lost: 'Elvesztett', running: 'Fut',
})

/**
 * Egy szakasz magyar felirata, vagy -- ismeretlen értékre -- maga a nyers
 * érték. Ugyanaz a visszaesés, mint `feladatStatuszCimke` és
 * `esemenyFajtaCimke` (`ugyfel-lap.tsx`): egy új, nem listázott szakasz
 * inkább csúnyán jelenjen meg, mint némán tűnjön el.
 */
export function szakaszCimke(stage: string): string {
  return SZAKASZ_NEV[stage] || stage
}

/**
 * A `SZAKASZOK`-ban a `stage` utáni szakasz, vagy `null`, ha nincs -- ez az
 * utolsó szakaszon (`negotiation`) áll fenn, onnan a lezárás visz tovább
 * (lásd `lezar`), a léptetés nem. `null`-t ad ismeretlen `stage`-re is
 * (`indexOf` -1-et ad, azt a második ág ugyanúgy elkapja).
 *
 * Önálló, exportált függvény, hogy a lépés célja (a "következő szakasz")
 * a rendertől függetlenül, közvetlenül tesztelhető legyen -- a task-8-brief.md
 * szerint egy gomb, ami nem visz sehova (vagy rossz helyre), ugyanaz a hiba,
 * amit ez a projekt már háromszor javított.
 */
export function kovetkezoSzakasz(stage: string): (typeof SZAKASZOK)[number] | null {
  const idx = SZAKASZOK.indexOf(stage as (typeof SZAKASZOK)[number])
  if (idx === -1 || idx === SZAKASZOK.length - 1) return null
  return SZAKASZOK[idx + 1]
}

export function UgyekNezet({ rpc }: { rpc: Rpc }) {
  const [deals, setDeals] = useState<Deal[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [hiba, setHiba] = useState('')

  const tolt = () => {
    rpc('board')
      .then((b) => {
        const board = b as { deals: Deal[]; accounts: Account[] }
        setDeals(board.deals)
        setAccounts(board.accounts)
      })
      .catch((e: Error) => setHiba(e.message))
  }
  useEffect(tolt, [rpc])

  const nevOf = (id: string) => accounts.find((a) => a.id === id)?.name || '—'
  const lezar = (dealId: string, stage: string) => {
    rpc('closeDeal', { dealId, stage, reason: '' }).then(tolt).catch((e: Error) => setHiba(e.message))
  }
  /**
   * A "Tovább" gomb hívója. A `kovetkezo` a hívó helyén (a JSX-ben) már
   * `kovetkezoSzakasz(sz)` -- itt csak az `updateDeal` rpc-t hívja meg vele,
   * hiba esetén `setHiba`, siker esetén `tolt()`, ugyanúgy, mint `lezar`.
   */
  const lept = (dealId: string, kovetkezo: string) => {
    rpc('updateDeal', { dealId, stage: kovetkezo }).then(tolt).catch((e: Error) => setHiba(e.message))
  }

  return (
    <section className="crm-sec-wrap">
      <h2 className="crm-h2">Ügyek</h2>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      <div className="crm-sec">
        <div className="crm-sechead">
          <h3>Leadek</h3>
          <span className="crm-count">{deals.filter((d) => d.kind === 'lead').length}</span>
        </div>
        <div className="crm-pipe">
          {SZAKASZOK.map((sz) => {
            const kovetkezo = kovetkezoSzakasz(sz)
            const oszlop = deals.filter((d) => d.kind === 'lead' && d.stage === sz)
            return (
              <div key={sz} className="crm-lane">
                <div className="crm-lanehead">
                  <span className="crm-lanebar" aria-hidden="true"></span>
                  <h4>{szakaszCimke(sz)}</h4>
                  <span className="crm-lanen">{oszlop.length}</span>
                </div>
                {oszlop.map((d) => (
                  <div key={d.id} className="crm-deal">
                    <span className="crm-dealt">{d.title}</span>
                    <span className="crm-deala">{nevOf(d.account_id)}</span>
                    {d.value_huf > 0 && <span className="crm-dealv">{d.value_huf.toLocaleString('hu-HU')} Ft</span>}
                    {/*
                      F3: a "Tovább" -- a leggyakoribb, könnyen visszavonható
                      lépés (a lead a következő szakaszba kerül) -- kapja a
                      hangsúlyos (primary) stílust. A "Nyert"/"Elvesztett" a
                      ritka, lezáró, nehezen visszavonható döntés -- ugyanazt
                      a halk (quiet) kezelést kapják, egymással egyenrangúan,
                      hogy egyik se tűnjön a másiknál "biztonságosabb"
                      alapértelmezésnek. A handlerek, a feltétel és a magyar
                      feliratok változatlanok.
                    */}
                    <div className="crm-attact">
                      {kovetkezo && <button className="crm-btn crm-btn-primary crm-btn-sm" onClick={() => lept(d.id, kovetkezo)}>Tovább</button>}
                      <button className="crm-btn crm-btn-quiet crm-btn-sm" onClick={() => lezar(d.id, 'won')}>Nyert</button>
                      <button className="crm-btn crm-btn-quiet crm-btn-sm" onClick={() => lezar(d.id, 'lost')}>Elvesztett</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      <div className="crm-sec">
        <div className="crm-sechead">
          <h3>Futó megbízások</h3>
          <span className="crm-count">{deals.filter((d) => d.kind === 'engagement').length}</span>
        </div>
        {deals.filter((d) => d.kind === 'engagement').length === 0
          ? <p className="crm-empty">Nincs futó megbízás.</p>
          : (
            <ul className="crm-rows crm-card">
              {deals.filter((d) => d.kind === 'engagement').map((d) => (
                <li key={d.id} className="crm-row">
                  <span className="crm-grow">{d.title}</span>
                  <span className="crm-halvany">{nevOf(d.account_id)}</span>
                  {d.value_huf > 0 && <span className="crm-dealv">{d.value_huf.toLocaleString('hu-HU')} Ft</span>}
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  )
}
