import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Deal = { id: string; account_id: string; kind: string; title: string; stage: string; value_huf: number }
type Account = { id: string; name: string }

/** A lead útja. A `won` és a `lost` végállapot; oda a lezárás visz, nem a léptetés. */
const SZAKASZOK = ['new', 'talking', 'proposal', 'negotiation'] as const
const SZAKASZ_NEV: Record<string, string> = {
  new: 'Új', talking: 'Egyeztetés', proposal: 'Ajánlat', negotiation: 'Tárgyalás',
  won: 'Nyert', lost: 'Elvesztett', running: 'Fut',
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

  return (
    <section>
      <h2>Ügyek</h2>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      <h3>Leadek</h3>
      <div className="crm-pipeline">
        {SZAKASZOK.map((sz) => (
          <div key={sz} className="crm-oszlop">
            <h4>{SZAKASZ_NEV[sz]}</h4>
            {deals.filter((d) => d.kind === 'lead' && d.stage === sz).map((d) => (
              <div key={d.id} className="crm-kartya">
                <strong>{d.title}</strong>
                <span className="crm-halvany">{nevOf(d.account_id)}</span>
                {d.value_huf > 0 && <span>{d.value_huf.toLocaleString('hu-HU')} Ft</span>}
                <div className="crm-sor">
                  <button onClick={() => lezar(d.id, 'won')}>Nyert</button>
                  <button onClick={() => lezar(d.id, 'lost')}>Elvesztett</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <h3>Futó megbízások</h3>
      {deals.filter((d) => d.kind === 'engagement').length === 0
        ? <p className="crm-halvany">Nincs futó megbízás.</p>
        : (
          <ul className="crm-lista">
            {deals.filter((d) => d.kind === 'engagement').map((d) => (
              <li key={d.id}>{d.title} <span className="crm-halvany">{nevOf(d.account_id)}</span></li>
            ))}
          </ul>
        )}
    </section>
  )
}
