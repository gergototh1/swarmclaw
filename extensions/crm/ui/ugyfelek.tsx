import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Account = { id: string; name: string; type: string; status: string; domains: string[] }

const STATUSZ: Record<string, string> = {
  lead: 'Lead', client: 'Ügyfél', inactive: 'Inaktív', lost: 'Elvesztett',
}

/**
 * A státuszhoz tartozó pill-osztály.
 *
 * Az élő és a holt státusz nem nézhet egyformán ki: az „Ügyfél" a bevétel, a
 * „Lead" a lehetőség, az „Inaktív" és az „Elvesztett" pedig archívum. Egy
 * ismeretlen státusz semleges pillt kap, nem tűnik el.
 */
export const STATUSZ_PILL: Record<string, string> = {
  client: 'crm-pill-ok',
  lead: 'crm-pill-nema',
  inactive: 'crm-pill-plain',
  lost: 'crm-pill-plain',
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
    <section className="crm-sec-wrap">
      <h2 className="crm-h2">Ügyfelek</h2>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      <div className="crm-toolbar">
        <select value={szuro} onChange={(e) => setSzuro(e.target.value)} aria-label="Státusz szűrő">
          <option value="">Mind</option>
          {Object.entries(STATUSZ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input value={ujNev} onChange={(e) => setUjNev(e.target.value)}
               placeholder="Új ügyfél neve" aria-label="Új ügyfél neve" />
        <button className="crm-btn crm-btn-primary" onClick={felvesz}>Felvesz</button>
      </div>

      <div className="crm-sec">
        {/* Nincs kulon h3: az egyetlen szakasz cime mar a fenti h2, egy
            azonos szovegu h3 csak megismetelne a kepernyoolvaso cim-fajanak. */}
        <div className="crm-sechead"><span className="crm-count">{lathato.length}</span></div>
        {lathato.length === 0
          ? <p className="crm-empty">Még nincs ügyfél. Vegyél fel egyet a fenti mezővel.</p>
          : (
            <ul className="crm-accts">
              {lathato.map((a) => (
                <li key={a.id}>
                  <button className="crm-acct" onClick={() => onOpen(a.id)}>
                    <span className="crm-grow">{a.name}</span>
                    {a.domains.length > 0 && <span className="crm-mono crm-halvany crm-acct-dom">{a.domains.join(', ')}</span>}
                    <span className={`crm-pill ${STATUSZ_PILL[a.status] || 'crm-pill-plain'}`}>
                      {STATUSZ[a.status] || a.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  )
}
