import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Unmatched = { id: string; sender_address: string; subject: string; guess_account_id: string | null }
type Suggestion = { id: string; text: string; reason: string }
type Account = { id: string; name: string }

export function MaNezet({ rpc, onOpen }: { rpc: Rpc; onOpen: (id: string) => void }) {
  const [unmatched, setUnmatched] = useState<Unmatched[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [hiba, setHiba] = useState('')

  const tolt = () => {
    rpc('board')
      .then((b) => {
        const board = b as { unmatched: Unmatched[]; suggestions: Suggestion[]; accounts: Account[] }
        setUnmatched(board.unmatched)
        setSuggestions(board.suggestions)
        setAccounts(board.accounts)
      })
      .catch((e: Error) => setHiba(e.message))
  }
  useEffect(tolt, [rpc])

  const elvet = (suggestionId: string) => {
    rpc('setSuggestionStatus', { suggestionId, status: 'dismissed' })
      .then(tolt).catch((e: Error) => setHiba(e.message))
  }

  return (
    <section>
      <h2>Ma</h2>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      <h3>Figyelmet igényel</h3>
      {/* A figyelem-lista a CRM-3-ban érkezik. Addig a javaslat-sor áll itt,
          hogy a felület alakja már most a helyén legyen. */}
      {suggestions.length === 0
        ? <p className="crm-halvany">Most nincs javaslat.</p>
        : (
          <ul className="crm-lista">
            {suggestions.map((s) => (
              <li key={s.id}>
                {s.text}
                {s.reason && <span className="crm-halvany"> — {s.reason}</span>}
                <button onClick={() => elvet(s.id)}>Elvet</button>
              </li>
            ))}
          </ul>
        )}

      <h3>Besorolatlan ({unmatched.length})</h3>
      {unmatched.length === 0
        ? <p className="crm-halvany">Nincs besorolatlan levél.</p>
        : (
          <ul className="crm-lista">
            {unmatched.map((u) => (
              <li key={u.id}>
                <strong>{u.sender_address}</strong> {u.subject}
                {u.guess_account_id && (
                  <span className="crm-halvany">
                    valószínűleg {accounts.find((a) => a.id === u.guess_account_id)?.name}
                  </span>
                )}
                <button onClick={() => u.guess_account_id && onOpen(u.guess_account_id)}>Megnyit</button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
