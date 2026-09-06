import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Account = { id: string; name: string; type: string; status: string; domains: string[] }

const STATUSZ: Record<string, string> = {
  lead: 'Lead', client: 'Ügyfél', inactive: 'Inaktív', lost: 'Elvesztett',
}

export function UgyfelekNezet({ rpc, onOpen }: { rpc: Rpc; onOpen: (id: string) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [szuro, setSzuro] = useState<string>('')
  const [hiba, setHiba] = useState('')
  const [ujNev, setUjNev] = useState('')

  const tolt = () => {
    rpc('board')
      .then((b) => setAccounts((b as { accounts: Account[] }).accounts))
      .catch((e: Error) => setHiba(e.message))
  }
  useEffect(tolt, [rpc])

  const felvesz = () => {
    if (!ujNev.trim()) return
    rpc('createAccount', { name: ujNev, type: 'company', status: 'lead' })
      .then(() => { setUjNev(''); tolt() })
      .catch((e: Error) => setHiba(e.message))
  }

  const lathato = szuro ? accounts.filter((a) => a.status === szuro) : accounts

  return (
    <section>
      <h2>Ügyfelek</h2>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      <div className="crm-sor">
        <select value={szuro} onChange={(e) => setSzuro(e.target.value)} aria-label="Státusz szűrő">
          <option value="">Mind</option>
          {Object.entries(STATUSZ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input value={ujNev} onChange={(e) => setUjNev(e.target.value)}
               placeholder="Új ügyfél neve" aria-label="Új ügyfél neve" />
        <button onClick={felvesz}>Felvesz</button>
      </div>

      {lathato.length === 0
        ? <p>Még nincs ügyfél. Vegyél fel egyet a fenti mezővel.</p>
        : (
          <ul className="crm-lista">
            {lathato.map((a) => (
              <li key={a.id}>
                <button onClick={() => onOpen(a.id)}>{a.name}</button>
                <span className="crm-cimke">{STATUSZ[a.status] || a.status}</span>
                {a.domains.length > 0 && <span className="crm-halvany">{a.domains.join(', ')}</span>}
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
