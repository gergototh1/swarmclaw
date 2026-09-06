import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Unmatched = { id: string; sender_address: string; subject: string; guess_account_id: string | null }
type Suggestion = { id: string; text: string; reason: string }
type Account = { id: string; name: string }
type Kapcsolat = { id: string; name: string; accountId: string | null; accountName: string }

/**
 * A besorolatlan sor kapcsolat-választójának listája.
 *
 * A találgatás (`guessAccountId`) alapból szűkít -- ez a sweep egy kattintással
 * megspórolt találata --, de sosem dönt. Két eset nem eshet ki a listából:
 *
 * 1. A találgatás téves: a helyes kapcsolat másik ügyfélhez tartozik. Erre
 *    való a `mindet` jelölőnégyzet, ami soronként feloldja a szűkítést.
 * 2. A helyes kapcsolat még nincs ügyfélhez kötve (`accountId: null`) -- ez a
 *    leggyakoribb ok, amiért a levél egyáltalán a besorolatlan sorba került,
 *    ezért a kötetlen kapcsolatok a találgatással szűkített listában is
 *    mindig ott vannak.
 */
export function valaszthatoKapcsolatok(
  kapcsolatok: Kapcsolat[],
  guessAccountId: string | null,
  mindet: boolean,
): Kapcsolat[] {
  if (!guessAccountId || mindet) return kapcsolatok
  return kapcsolatok.filter((c) => c.accountId === guessAccountId || c.accountId === null)
}

export function MaNezet({ rpc, onOpen }: { rpc: Rpc; onOpen: (id: string) => void }) {
  const [unmatched, setUnmatched] = useState<Unmatched[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [kapcsolatok, setKapcsolatok] = useState<Kapcsolat[]>([])
  const [valasztott, setValasztott] = useState<Record<string, string>>({})
  const [mindet, setMindet] = useState<Record<string, boolean>>({})
  const [hiba, setHiba] = useState('')
  const [sopres, setSopres] = useState<string>('')
  const [fut, setFut] = useState(false)

  const tolt = () => {
    rpc('board')
      .then((b) => {
        const board = b as { unmatched: Unmatched[]; suggestions: Suggestion[]; accounts: Account[] }
        setUnmatched(board.unmatched)
        setSuggestions(board.suggestions)
        setAccounts(board.accounts)
      })
      .catch((e: Error) => setHiba(e.message))
    rpc('contactsForPicker')
      .then((c) => setKapcsolatok(c as Kapcsolat[]))
      .catch((e: Error) => setHiba(e.message))
  }
  useEffect(tolt, [rpc])

  const hozzarendel = (u: Unmatched) => {
    const contactId = valasztott[u.id]
    if (!contactId) return
    rpc('assignUnmatched', { unmatchedId: u.id, contactId })
      .then(tolt)
      .catch((e: Error) => setHiba(e.message))
  }

  const elvet = (suggestionId: string) => {
    rpc('setSuggestionStatus', { suggestionId, status: 'dismissed' })
      .then(tolt).catch((e: Error) => setHiba(e.message))
  }

  const soper = () => {
    setFut(true)
    rpc('sweepNow', { max: 50 })
      .then((r) => {
        const x = r as { scanned: number; recorded: number; unmatched: number; failed: number }
        const hibaResz = x.failed > 0 ? ` · ${x.failed} hibás (kihagyva)` : ''
        setSopres(`${x.scanned} levél átnézve · ${x.recorded} idővonalra · ${x.unmatched} besorolatlan${hibaResz}`)
        tolt()
      })
      .catch((e: Error) => setHiba(e.message))
      .finally(() => setFut(false))
  }

  return (
    <section>
      <h2>Ma</h2>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      <div className="crm-sor">
        <button onClick={soper} disabled={fut}>{fut ? 'Söprés fut…' : 'Levelek behúzása'}</button>
        {sopres && <span className="crm-halvany">{sopres}</span>}
      </div>

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
                <button disabled={!u.guess_account_id} onClick={() => u.guess_account_id && onOpen(u.guess_account_id)}>Megnyit</button>
                <label>
                  <input
                    type="checkbox"
                    checked={!!mindet[u.id]}
                    aria-label={`${u.sender_address}: összes kapcsolat, találgatás nélkül`}
                    onChange={(e) => setMindet({ ...mindet, [u.id]: e.target.checked })}
                  />
                  Összes kapcsolat
                </label>
                <select value={valasztott[u.id] || ''} aria-label={`${u.sender_address} hozzárendelése`}
                        onChange={(e) => setValasztott({ ...valasztott, [u.id]: e.target.value })}>
                  <option value="">Válassz kapcsolatot…</option>
                  {valaszthatoKapcsolatok(kapcsolatok, u.guess_account_id, !!mindet[u.id])
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.accountName && ` — ${c.accountName}`}
                      </option>
                    ))}
                </select>
                <button onClick={() => hozzarendel(u)} disabled={!valasztott[u.id]}>Hozzárendel</button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
