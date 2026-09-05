import { useCallback, useState } from 'react'

import type { KonyvSor, Rpc, Uzenet } from './api'
import { errorText, readKonyvSor } from './api'
import { formatDate } from './format'

/**
 * The address book, and the form that adds to it.
 *
 * THIS IS THE ONLY PLACE IN THE WHOLE APP WHERE AN E-MAIL ADDRESS ENTERS THIS
 * MODULE BY BEING TYPED, and the page says so on screen rather than only in a
 * comment. `addRecipient` is not on the contract and not on the MCP shim's
 * allowlist; every other path into the outbound side names a recipient by a
 * handle that is already here, or replies to a letter whose envelope carries
 * the address. That is the gate the entire outbound design rests on: a
 * newsletter sentence asking for a letter to be sent somewhere gets no further
 * than a refused attempt, because there is no route from a string to an
 * address except this form.
 *
 * A HANDLE IS NEVER REUSED AND NEVER REVIVED. The server refuses a handle that
 * is already in the book, retired or not, and there is no reviving method at
 * all: an address that is wanted back is added under a new handle, and the
 * retired row stays readable beside the outbound rows that named it. This view
 * shows retired entries for exactly that reason rather than hiding them.
 *
 * Handles, addresses and notes are the operator's own words here, but the page
 * still renders every one of them as a React text child: the book can also be
 * read on an install whose rows somebody else's tooling wrote, and a field's
 * origin is not something a renderer should have to reason about.
 */

/** The book as a table. Split out so the test can render a state without a form's own state or a load. */
export function KonyvTabla({ konyv, dolgozik, onVisszavon }: {
  konyv: readonly KonyvSor[]
  dolgozik: boolean
  onVisszavon: (handle: string) => void
}) {
  if (konyv.length === 0) {
    return (
      <p className="gm-muted">
        A címzettkönyv üres. Amíg üres, könyvbeli handle-re címzett piszkozat nem készíthető; válasz-piszkozat igen, mert annak a címzettje a megválaszolt levél borítékjából jön.
      </p>
    )
  }
  return (
    <table className="gm-tabla">
      <thead>
        <tr>
          <th>Handle</th>
          <th>Cím</th>
          <th>Megjegyzés</th>
          <th>Felvéve</th>
          <th>Állapot</th>
        </tr>
      </thead>
      <tbody>
        {konyv.map((sor) => (
          <tr key={sor.handle} data-handle={sor.handle} className={sor.visszavontAt === null ? '' : 'gm-visszavont'}>
            <td className="gm-mono">{sor.handle}</td>
            <td>{sor.cim}</td>
            <td>{sor.megjegyzes}</td>
            <td className="gm-muted">{formatDate(sor.createdAt)}</td>
            <td>
              {sor.visszavontAt === null
                ? <button type="button" className="gm-btn gm-btn-small" disabled={dolgozik} onClick={() => onVisszavon(sor.handle)}>Visszavon</button>
                : <span className="gm-muted">visszavonva {formatDate(sor.visszavontAt)}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * `onUzenet` rather than local state, for the reason kimeno.tsx spells out:
 * this view is keyed on the board's load counter, so the refresh that follows
 * a successful write remounts it and would destroy the sentence reporting that
 * write.
 */
export function CimzettekNezet({ konyv, rpc, onChanged, onUzenet }: {
  konyv: readonly KonyvSor[]
  rpc: Rpc
  onChanged: () => void
  onUzenet: (uzenet: Uzenet | null) => void
}) {
  const [handle, setHandle] = useState('')
  const [cim, setCim] = useState('')
  const [megjegyzes, setMegjegyzes] = useState('')
  const [dolgozik, setDolgozik] = useState(false)

  const felvesz = useCallback(() => {
    setDolgozik(true)
    onUzenet(null)
    rpc('addRecipient', { handle, cim, megjegyzes })
      .then((raw) => {
        const sor = readKonyvSor('addRecipient', raw)
        onUzenet({ kind: 'plain', text: `Felvéve: ${sor.handle} — ${sor.cim}` })
        setHandle('')
        setCim('')
        setMegjegyzes('')
      })
      .catch((err: unknown) => onUzenet({ kind: 'bad', text: `A felvétel nem sikerült: ${errorText(err)}` }))
      .finally(() => { setDolgozik(false); onChanged() })
  }, [rpc, handle, cim, megjegyzes, onChanged, onUzenet])

  const visszavon = useCallback((kulcs: string) => {
    if (!window.confirm(`Visszavonom ezt a handle-t: ${kulcs}. A sor megmarad olvashatónak, de nem lehet újra élővé tenni, és új piszkozat nem címezhető rá. Folytassam?`)) return
    setDolgozik(true)
    onUzenet(null)
    rpc('retireRecipient', { handle: kulcs })
      .then((raw) => {
        const sor = readKonyvSor('retireRecipient', raw)
        onUzenet({ kind: 'plain', text: `Visszavonva: ${sor.handle}` })
      })
      .catch((err: unknown) => onUzenet({ kind: 'bad', text: `A visszavonás nem sikerült: ${errorText(err)}` }))
      .finally(() => { setDolgozik(false); onChanged() })
  }, [rpc, onChanged, onUzenet])

  return (
    <div className="gm-cimzettek">
      <p className="gm-line gm-warn">
        Ez az egyetlen hely, ahol e-mail-cím keletkezik ehhez a modulhoz. Se a szerződés, se az MCP-szerver nem tud címet felvenni, és piszkozat csak az itteni handle-ökre vagy egy megválaszolt levél feladójára címezhető.
      </p>

      <KonyvTabla konyv={konyv} dolgozik={dolgozik} onVisszavon={visszavon} />

      <h3>Új címzett</h3>
      {/*
        A form element rather than three loose inputs, so Enter in any field
        submits the one action this section has -- which is what a keyboard
        operator expects. `onSubmit` with `preventDefault` is the whole
        mechanism: no key handler is registered anywhere on this page, and the
        one the aisignal review found had swallowed Enter from every focused
        control on that page.
      */}
      <form
        className="gm-form"
        onSubmit={(e) => { e.preventDefault(); felvesz() }}
      >
        <label>
          Handle
          <input className="gm-input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="pl. dorina" />
        </label>
        <label>
          E-mail-cím
          <input className="gm-input" value={cim} onChange={(e) => setCim(e.target.value)} placeholder="pl. dorina@example.test" />
        </label>
        <label>
          Megjegyzés
          <input className="gm-input" value={megjegyzes} onChange={(e) => setMegjegyzes(e.target.value)} placeholder="kinek, mihez" />
        </label>
        <div className="gm-actions">
          <button type="submit" className="gm-btn" disabled={dolgozik || handle.trim() === '' || cim.trim() === ''}>Felvesz</button>
          {(handle.trim() === '' || cim.trim() === '') && <span className="gm-muted">handle és cím nélkül nincs mit felvenni</span>}
        </div>
      </form>
      <p className="gm-line gm-muted">
        A handle alakja: kisbetűk, számjegyek és kötőjel, legfeljebb 40 karakter. Egy handle nem vehető fel kétszer, és egy visszavont handle nem éleszthető újra: ha a cím megint kell, új handle alatt vedd fel.
      </p>
    </div>
  )
}
