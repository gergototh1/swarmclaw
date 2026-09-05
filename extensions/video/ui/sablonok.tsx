import { useEffect, useState } from 'react'

import type { Rpc, Templates } from './api'
import { errorText, readTemplates } from './api'
import { kodSzamok, megtartasSzoveg } from './format'

/**
 * The per-template numbers of spec 6.3, and the weekly row under them.
 *
 * TWO SENTINELS ARE PASSED THROUGH UNTRANSLATED, and the reason is the same
 * for both. `qaBukas` is the constant `nincs_idokodos_szabaly`: rule set 1
 * has no scene-scoped QA rule, so no QA failure can be attributed to a
 * template, and a 0 in that column would say "this template never failed QA"
 * -- something nothing has measured. `megtartas` is `meretlen` when no
 * retention point falls inside the type's scenes, for the same reason. Both
 * are the module's own words and are shown as those words.
 *
 * A CATALOGUE THAT COULD NOT BE READ IS NOT AN EMPTY CATALOGUE. `templates`
 * answers with `sablonStat: null` beside a refusal code in that case, and
 * this view shows the code and nothing else, rather than a table of no rows
 * that would read as "no type was ever used". The weekly row is computed
 * from stored rows and does not need the project, so it stays.
 */

export function SablonokBody({ data }: { data: Templates }) {
  const stat = data.sablonStat
  const tipusok = stat === null ? [] : Object.keys(stat).sort()
  return (
    <div className="vid-sablonok">
      {data.hiba !== null && (
        <p className="vid-bad" role="alert">A katalógus nem olvasható: <span className="vid-mono">{data.hiba}</span></p>
      )}
      {data.hiba === null && (
        <p className="vid-muted vid-mono">katalógus-hash: {data.katalogusHash ?? '(nincs)'}</p>
      )}

      {stat === null ? (
        <p className="vid-muted">Katalógus nélkül nincs típusonkénti táblázat. A heti sor alább ettől függetlenül megvan.</p>
      ) : (
        <table className="vid-tabla">
          <thead>
            <tr>
              <th scope="col">típus</th>
              <th scope="col">használat</th>
              <th scope="col">lektori találat</th>
              <th scope="col">QA-bukás</th>
              <th scope="col">visszajelzés</th>
              <th scope="col">megtartás</th>
            </tr>
          </thead>
          <tbody>
            {tipusok.map((tipus) => {
              const s = stat[tipus]
              return (
                <tr key={tipus}>
                  <th scope="row" className="vid-mono">{tipus}</th>
                  <td>{s.hasznalat}</td>
                  <td>{kodSzamok(s.lektoriTalalat)}</td>
                  <td className="vid-mono">{s.qaBukas}</td>
                  <td>{s.visszajelzes}</td>
                  <td className="vid-mono">{megtartasSzoveg(s.megtartas)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h3>Heti sor</h3>
      {data.hetiSor.length === 0 ? (
        <p className="vid-muted">Egyetlen hétre sincs adat: nem futott render, nem született QA-sor és nincs lektori ítélet.</p>
      ) : (
        <table className="vid-tabla">
          <thead>
            <tr>
              <th scope="col">hét</th>
              <th scope="col">renderek</th>
              <th scope="col">QA-bukások</th>
              <th scope="col">lektori találatok kódonként</th>
            </tr>
          </thead>
          <tbody>
            {data.hetiSor.map((h) => (
              <tr key={h.het}>
                <th scope="row" className="vid-mono">{h.het}</th>
                <td>{h.renderek}</td>
                <td>{h.qaBukas}</td>
                <td>{kodSzamok(h.lektoriTalalat)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function Sablonok({ rpc }: { rpc: Rpc }) {
  const [data, setData] = useState<Templates | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    rpc('templates')
      .then((raw) => { if (!stale) { setData(readTemplates(raw)); setError(null) } })
      .catch((err: unknown) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [rpc])

  if (error && data === null) return <p className="vid-error" role="alert">A sablon-táblát nem sikerült betölteni: {error}</p>
  if (data === null) return <p className="vid-muted">Betöltés…</p>
  return (
    <>
      {error && <p className="vid-error" role="alert">A frissítés nem sikerült, a lenti állapot a korábbi betöltésé: {error}</p>}
      <SablonokBody data={data} />
    </>
  )
}
