import { useCallback, useState } from 'react'

import type { Board, Health, ManagedStatus, Rpc } from './api'
import { errorText } from './api'
import { describeManaged, formatDate, formatPerc } from './format'

/**
 * What the operator reads before the queue: every condition this module can
 * be stopped by, as its own sentence.
 *
 * NOTHING HERE IS FOLDED TOGETHER, and the whole point of the bar is that it
 * is not. `health.mjs` separates blocking failures, non-blocking warnings and
 * the one code it structurally cannot answer, and a bar that rendered those
 * as a single red dot would throw that separation away at the last step. So
 * the Remotion project, each tool, the browser directory, the platform, each
 * of the two contracts, the schedules and the turn recorder each get a line,
 * and the line says which of the three it is:
 *
 *   - a blocked capability is `.vid-bad` and names what is blocked,
 *   - a limitation that blocks nothing is `.vid-warn`,
 *   - a question nobody answered says so in those words and is neither.
 *
 * A `null` health is the third kind and is drawn as such: the module is not
 * idle, it is unqueried, and the bar says "az állapotot nem tudtam
 * lekérdezni" rather than falling back to a layout that looks calm.
 *
 * The two buttons here write. `Leállít` kills a running render through the
 * same `renderOps` the render tools use; `Tisztítás` deletes the row-bound
 * files in both namespaces and is behind a `window.confirm`, because it is
 * the one destructive action on this page. Both report what came back --
 * including a refusal -- as text.
 */

/** A count the server sent, or `?`: a number this page did not receive is not a 0. */
function szam(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '?'
}

function Mondat({ text, kind = 'plain' }: { text: string; kind?: 'plain' | 'warn' | 'bad' | 'muted' }) {
  const cls = kind === 'plain' ? 'vid-line' : `vid-line vid-${kind}`
  return <p className={cls}>{text}</p>
}

/** The Remotion project, in the four states `runHealth` can distinguish between. */
function remotionMondat(health: Health): { text: string; kind: 'plain' | 'bad' } {
  if (!health.remotion.beallitva) return { text: 'Remotion-könyvtár: nincs beállítva', kind: 'bad' }
  if (!health.remotion.letezik) return { text: 'Remotion-könyvtár: nem létezik', kind: 'bad' }
  if (health.remotion.hianyzoFajlok.length > 0) {
    return { text: `Remotion-könyvtár: hiányzik: ${health.remotion.hianyzoFajlok.join(', ')}`, kind: 'bad' }
  }
  return { text: 'Remotion-könyvtár: rendben', kind: 'plain' }
}

/** Each tool by name. A tool that answered its version probe is not listed as a problem, and one that did not is named. */
function eszkozMondat(health: Health): { text: string; kind: 'plain' | 'bad' } {
  const hianyzo = Object.entries(health.eszkozok).filter(([, ok]) => !ok).map(([name]) => `${name} hiányzik`)
  if (hianyzo.length === 0) {
    const nevek = Object.keys(health.eszkozok)
    return { text: `Eszközök: ${nevek.length === 0 ? 'nincs mit ellenőrizni' : `${nevek.join(', ')} megvan`}`, kind: 'plain' }
  }
  return { text: `Eszközök: ${hianyzo.join(', ')}`, kind: 'bad' }
}

/**
 * The platform line. A non-macOS host with the switch on is not a failure and
 * is not drawn as one; without the switch the render does not start, and the
 * sentence says that rather than saying the host is wrong.
 */
function platformMondat(health: Health): { text: string; kind: 'plain' | 'warn' | 'bad' } {
  if (health.platform === 'darwin') return { text: 'Render: ez a host macOS, a render indulhat', kind: 'plain' }
  if (health.linuxRenderEngedely) {
    return { text: `Render: nem macOS host (${health.platform}), de a linuxRenderEngedely beállítás engedélyezi; a tipográfia máshogy fog kinézni`, kind: 'warn' }
  }
  return { text: `Render: ezen a hoston nem indul (${health.platform})`, kind: 'bad' }
}

/**
 * One contract, with the host's own reason verbatim.
 *
 * `provider_missing`, `provider_disabled`, `not_declared` and
 * `version_mismatch` are the host's vocabulary and are not translated here:
 * they are what the operator will search for, and a paraphrase would be a
 * word this page invented for a state it did not decide.
 */
function szerzodesMondat(nev: string, why: string | null, kovetkezmeny: string, blokkolo: boolean): { text: string; kind: 'plain' | 'warn' | 'bad' } {
  if (why === null) return { text: `${nev}: rendben`, kind: 'plain' }
  return { text: `${nev}: ${why} — ${kovetkezmeny}`, kind: blokkolo ? 'bad' : 'warn' }
}

/**
 * Everything the bar says once it is open -- every condition on its own line,
 * which is the separation `health.mjs` makes and this file refuses to fold.
 *
 * It is split out for the same reason `VideoBody` and `SablonokBody` are: the
 * shell above owns state (the fold, the message, the in-flight flag) and a
 * server render never runs an effect or a click, so the tests that pin what a
 * state LOOKS like render this half directly and pass the state as props.
 *
 * The two write buttons stay here, with the sentences they belong to. Their
 * RESULT does not: `uzenet` is drawn by the shell, outside the fold, so
 * closing the bar right after a cleanup does not throw away what it reported.
 */
export function StatusBarBody({ board, health, managed, healthError, dolgozik, leallit, tisztit }: {
  board: Board | null
  health: Health | null
  managed: ManagedStatus | null
  healthError: string | null
  dolgozik: boolean
  leallit: (renderId: string) => void
  tisztit: () => void
}) {
  const schedule = describeManaged(managed)
  // The board is its own load and can fail on its own. When it did, this body
  // still draws everything that does not come from it -- the health lines,
  // the schedules, the two buttons -- because a queue that could not be read
  // says nothing about whether ffmpeg is installed or whether Reconcile has
  // been pressed, and those are what the operator needs in order to act. The
  // two facts that DO come from the board say they are unknown rather than
  // being drawn as their calm value: no running render, no recorded turns.
  const futo = board ? board.futoRender : null
  const remotion = health ? remotionMondat(health) : null
  const eszkoz = health ? eszkozMondat(health) : null
  const platform = health ? platformMondat(health) : null
  return (
    <>
      {healthError && <Mondat kind="bad" text={`Az állapotot nem tudtam lekérdezni: ${healthError}`} />}
      {!health && !healthError && <Mondat kind="muted" text="Az állapot lekérdezése folyamatban." />}

      {health && remotion && <Mondat kind={remotion.kind} text={remotion.text} />}
      {health && eszkoz && <Mondat kind={eszkoz.kind} text={eszkoz.text} />}
      {health && (
        <Mondat
          kind={health.chrome.konyvtar ? 'plain' : 'bad'}
          text={`Chrome Headless Shell: a könyvtár ${health.chrome.konyvtar ? 'megvan' : 'hiányzik'} — ${health.chrome.megjegyzes}`}
        />
      )}
      {health && platform && <Mondat kind={platform.kind} text={platform.text} />}
      {health && (() => {
        const tts = szerzodesMondat('tts.narration', health.szerzodesek.tts, 'e nélkül a narráció nem készül el', true)
        return <Mondat kind={tts.kind} text={tts.text} />
      })()}
      {health && (() => {
        const signals = szerzodesMondat('aisignal.signals', health.szerzodesek.signals, 'ez nem állít meg semmit, a videoOpen kézi forrással megy', false)
        return <Mondat kind={signals.kind} text={signals.text} />
      })()}

      <Mondat kind={schedule.trouble ? 'bad' : 'plain'} text={schedule.text} />
      {managed !== null && managed.kind === 'unscheduled' && (
        <p className="vid-line vid-reconcile-warning">nincs ütemezés — Reconcile kell</p>
      )}

      {health && (
        <Mondat
          kind="muted"
          text={`Fordulók rögzítése: ${health.forduloRogzites === 'mind' ? 'minden csatolt ügynök, 60 napig' : 'csak a modul két ügynöke'}`}
        />
      )}

      {board !== null && (futo ? (
        <div className="vid-status-run">
          <span className={futo.hostUjraindult ? 'vid-warn' : ''}>
            {futo.hostUjraindult
              ? `futó render, eltelt idő ismeretlen a host újraindulása óta (${futo.renderId})`
              : `Fut: ${futo.renderId}, ${formatPerc(futo.elteltMs)} perce`}
          </span>
          <button type="button" className="vid-btn vid-btn-small" disabled={dolgozik} onClick={() => leallit(futo.renderId)}>Leállít</button>
        </div>
      ) : (
        <Mondat kind="muted" text="Nem fut render." />
      ))}

      {board === null && <Mondat kind="muted" text="A sort nem sikerült betölteni, így a futó renderről és a fordulókról itt nincs adat." />}
      {board !== null && (board.utolsoFordulok.length > 0 ? (
        <ul className="vid-fordulok">
          {board.utolsoFordulok.slice(0, 3).map((f, i) => (
            <li key={`${f.agentId}-${f.at}-${i}`}>A modul fordulói szerint: {f.agentId} {f.forras} {formatDate(f.at)}</li>
          ))}
        </ul>
      ) : (
        <Mondat kind="muted" text="A modul még egyetlen fordulót sem rögzített." />
      ))}

      {health && health.sorNelkul !== null && health.sorNelkul > 0 && (
        <Mondat kind="warn" text={`${health.sorNelkul} sor nélküli fájl a két névtérben (az operátoré)`} />
      )}
      {health && health.sorNelkul === null && (
        <Mondat kind="muted" text="Sor nélküli fájlok: nincs megszámolva (ehhez olvasható Remotion-projekt kell)." />
      )}

      {health && health.nemValaszolt.length > 0 && (
        <Mondat
          kind="muted"
          text={`Ezekre a health nem tud válaszolni, a hiánylistából nem következik, hogy rendben vannak: ${health.nemValaszolt.join(', ')}`}
        />
      )}
      {health && health.blokkolt.length > 0 && (
        <Mondat kind="bad" text={`Most blokkolt: ${health.blokkolt.join(', ')}`} />
      )}

      <details className="vid-uninstall">
        <summary>Uninstall előtt</summary>
        <ol>
          <li>Állítsd le a futó rendert (Leállít).</li>
          <li>Tisztítás: a sorhoz kötött fájlok törlése a Remotion-projekt out/swarmclaw/ és public/narracio/swarmclaw/ alól, és a sablon-előnézetek gyorsítótára (out/swarmclaw/sablon-elonezet/) — ez a modulé, sor nem köti, tehát csak innen tűnik el.</li>
          <li>Az eltávolítás eldobja az ext_video_ táblákat; utána már nincs sor, amihez a törlés kötődhetne.</li>
        </ol>
        <button type="button" className="vid-btn vid-btn-small" disabled={dolgozik} onClick={tisztit}>Tisztítás</button>
      </details>
    </>
  )
}

/**
 * The one line the bar shows while it is closed.
 *
 * The bar opens closed (the operator asked for that), which puts a duty on
 * this line: a fault the operator cannot see is a fault they cannot act on,
 * so NOTHING THAT BLOCKS IS HIDDEN BEHIND THE FOLD. What the fold hides is
 * the calm detail -- the tool list, the platform, the contracts, the turn
 * recorder -- and what it never hides is the name of what is blocked.
 *
 * The order is the order of the operator's next move: a health call that did
 * not answer, then blocked capabilities by name, then the schedule, then
 * blocking codes that named no capability, then the count of non-blocking
 * warnings. `figyelmeztetesek` is COUNTED, not listed: it is the one group
 * that blocks nothing, and the open bar spells each out.
 */
function osszefoglalo({ health, healthError, scheduleTrouble, utemezetlen }: {
  health: Health | null
  healthError: string | null
  scheduleTrouble: boolean
  utemezetlen: boolean
}): { text: string; kind: 'plain' | 'warn' | 'bad' | 'muted' } {
  if (healthError) return { text: 'nem tudtam lekérdezni', kind: 'bad' }
  if (!health) return { text: 'lekérdezés folyamatban', kind: 'muted' }
  const gond: string[] = []
  if (health.blokkolt.length > 0) gond.push(`blokkolt: ${health.blokkolt.join(', ')}`)
  if (utemezetlen) gond.push('nincs ütemezés — Reconcile kell')
  else if (scheduleTrouble) gond.push('ütemezés: gond')
  // A blocking code that named no capability is still blocking, and the
  // closed bar says its code rather than calling the module calm.
  if (gond.length === 0 && health.hibak.length > 0) gond.push(health.hibak.join(', '))
  if (gond.length > 0) return { text: gond.join(' · '), kind: 'bad' }
  if (health.figyelmeztetesek.length > 0) return { text: `${health.figyelmeztetesek.length} figyelmeztetés`, kind: 'warn' }
  return { text: 'rendben', kind: 'plain' }
}

export function StatusBar({ board, health, managed, healthError, onRefresh, rpc }: {
  board: Board | null
  health: Health | null
  managed: ManagedStatus | null
  healthError: string | null
  onRefresh: () => void
  rpc: Rpc
}) {
  const [uzenet, setUzenet] = useState<string | null>(null)
  const [dolgozik, setDolgozik] = useState(false)
  // Closed by default: the operator reads the queue on this page, not the bar.
  const [nyitva, setNyitva] = useState(false)

  const leallit = useCallback((renderId: string) => {
    setDolgozik(true)
    rpc('cancelRender', { renderId })
      .then(() => { setUzenet('A leállítást elküldtem; a render sora a következő frissítésen mutatja az eredményt.') })
      .catch((err: unknown) => setUzenet(`A leállítás nem sikerült: ${errorText(err)}`))
      .finally(() => { setDolgozik(false); onRefresh() })
  }, [rpc, onRefresh])

  const tisztit = useCallback(() => {
    if (!window.confirm('Törlöm a sorhoz kötött fájlokat a Remotion-projekt out/swarmclaw/ és public/narracio/swarmclaw/ könyvtárából, és a sablon-előnézetek gyorsítótárát. Ez nem vonható vissza. Folytassam?')) return
    setDolgozik(true)
    rpc('cleanup')
      .then((raw) => {
        const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        // Four numbers, and the fourth is kept apart on purpose: the preview
        // cache is the module's own and is deleted by hash directory, not by
        // row. `sorNelkul` is a recount and now excludes that cache, so a
        // non-zero here after a cleanup means files the module never had a row
        // for -- which it does not delete, and which this line does not claim
        // it did.
        setUzenet(`Tisztítás kész: ${szam(r.renderek)} render-fájl, ${szam(r.narraciok)} narráció és ${szam(r.elonezetek)} előnézet-gyorsítótár törölve; sor nélkül maradt: ${szam(r.sorNelkul)}.`)
      })
      .catch((err: unknown) => setUzenet(`A tisztítás nem futott le: ${errorText(err)}`))
      .finally(() => { setDolgozik(false); onRefresh() })
  }, [rpc, onRefresh])

  const schedule = describeManaged(managed)
  const utemezetlen = managed !== null && managed.kind === 'unscheduled'
  const ossz = osszefoglalo({ health, healthError, scheduleTrouble: schedule.trouble, utemezetlen })

  return (
    <div className="vid-status">
      <div className="vid-status-head">
        <button
          type="button"
          className="vid-status-toggle"
          aria-expanded={nyitva}
          onClick={() => setNyitva((v) => !v)}
        >
          <span className="vid-caret" aria-hidden="true">{nyitva ? '▾' : '▸'}</span>
          <strong>Állapot</strong>
          <span className={ossz.kind === 'plain' ? 'vid-muted' : `vid-${ossz.kind}`}>{ossz.text}</span>
        </button>
        <button type="button" className="vid-btn vid-btn-small" onClick={onRefresh}>Frissítés</button>
      </div>

      {uzenet && (
        <p className="vid-line vid-notice" role="status">
          {uzenet}
          <button type="button" className="vid-btn vid-btn-small" onClick={() => setUzenet(null)}>Elrejt</button>
        </p>
      )}

      {nyitva && <StatusBarBody board={board} health={health} managed={managed} healthError={healthError} dolgozik={dolgozik} leallit={leallit} tisztit={tisztit} />}
    </div>
  )
}
