import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { Health, Kerelem, McpConfig, Rpc } from './api'
import { errorText, readHealth, readKerelmek, readMcpConfig } from './api'
import { formatDate, formatMs, formatSeconds, routeText, statusBadge, textOf } from './format'
import { currentExtensionId, hostOf, hostReact } from './host'

/**
 * The page: the status of the key, the endpoint and the day's counter; the
 * Settings > MCP Servers entry for the shim, as text to copy; what to do
 * before removing the extension; and the newest requests.
 *
 * Three loads, kept apart. `health` reads the settings and can be refused by
 * name when one of them cannot be honoured, `mcpConfig` is two paths and
 * cannot fail, and `kerelmek` is a read of the table. Folding them into one
 * request would let the settings refusal hide the list, and a page that shows
 * what it could load under the message for what it could not is the honest
 * one. A load that fails is shown as its message, and a section that has
 * already been shown stays on screen under that message rather than being
 * replaced by it; before the first load there is nothing to keep, so the
 * message stands alone. Nothing is drawn for a response that did not arrive.
 */

/** Rows the list asks for. `health.counts.kerelmek` is the total behind them, and the list says so when it is larger. */
export const LIST_LIMIT = 20

interface Loaded<T> {
  value: T | null
  error: string | null
}

const empty = <T,>(): Loaded<T> => ({ value: null, error: null })

function useLoad<T>(rpc: Rpc, method: string, body: object, read: (raw: unknown) => T): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>(empty<T>())
  const load = useCallback(() => {
    rpc(method, body)
      .then((raw) => setState({ value: read(raw), error: null }))
      .catch((err: unknown) => setState((prev) => ({ value: prev.value, error: errorText(err) })))
  }, [rpc, method, body, read])
  return [state, load]
}

const HEALTH_BODY = {}
const MCP_BODY = {}
const LIST_BODY = { limit: LIST_LIMIT }

export function TtsPage({ extensionId, rpc }: { extensionId: string; rpc: Rpc }) {
  const [health, loadHealth] = useLoad(rpc, 'health', HEALTH_BODY, readHealth)
  const [mcp, loadMcp] = useLoad(rpc, 'mcpConfig', MCP_BODY, readMcpConfig)
  const [list, loadList] = useLoad(rpc, 'kerelmek', LIST_BODY, readKerelmek)

  const refresh = useCallback(() => {
    loadHealth()
    loadMcp()
    loadList()
  }, [loadHealth, loadMcp, loadList])

  useEffect(() => { refresh() }, [refresh])

  return (
    <div className="tts-root" data-extension={extensionId}>
      <div className="tts-head">
        <h1>Narráció (TTS)</h1>
        <button type="button" className="tts-btn" onClick={refresh}>Frissítés</button>
      </div>
      <Section title="Állapot" loaded={health} render={(h) => <StatusPanel health={h} />} />
      <Section title="MCP-bejegyzés (Settings → MCP Servers)" loaded={mcp} render={(c) => <McpPanel config={c} />} />
      <section className="tts-section">
        <h2>Eltávolítás előtt</h2>
        <UninstallNotes />
      </section>
      <Section
        title={`Legutóbbi ${LIST_LIMIT} kérés`}
        loaded={list}
        render={(rows) => <KerelemList rows={rows} total={health.value ? health.value.counts.kerelmek : null} />}
      />
    </div>
  )
}

/**
 * One section of the page in its three states: not yet loaded, loaded, and
 * failed. A failure after a load keeps the old content under the message; a
 * failure before one shows the message alone.
 */
function Section<T>({ title, loaded, render }: { title: string; loaded: Loaded<T>; render: (value: T) => ReactNode }) {
  return (
    <section className="tts-section">
      <h2>{title}</h2>
      {loaded.error && (
        <p className="tts-error" role="alert">
          {loaded.value !== null ? 'A frissítés nem sikerült, a lenti állapot a korábbi betöltésé: ' : 'Nem sikerült betölteni: '}{loaded.error}
        </p>
      )}
      {loaded.value === null && !loaded.error && <p className="tts-muted">Betöltés…</p>}
      {loaded.value !== null && render(loaded.value)}
    </section>
  )
}

/** Set or not, as a word and a colour. The value of the key is never here: the server does not send it. */
function YesNo({ value, yes, no }: { value: boolean; yes: string; no: string }) {
  return value ? <span className="tts-yes">{yes}</span> : <span className="tts-no">{no}</span>
}

export function StatusPanel({ health }: { health: Health }) {
  return (
    <dl className="tts-facts">
      <dt>Soniox API-kulcs</dt>
      <dd><YesNo value={health.kulcsBeallitva} yes="beállítva" no="nincs beállítva" /></dd>
      <dt>Végpont</dt>
      <dd><YesNo value={health.vegpontBeallitva} yes="beállítva" no="nincs beállítva" /></dd>
      {/*
        The root by value, not as a yes/no: it is the one directory this
        extension writes into, the operator has to be able to read it back,
        and a caller that names a path outside it is refused. An empty one
        refuses every call, so it is said in those words rather than shown as
        a blank line.
      */}
      <dt>Hangfájlok gyökere</dt>
      <dd className="tts-mono">{health.hangGyoker === '' ? <span className="tts-no">nincs beállítva — minden hívás elutasítva (tts_gyoker_hianyzik)</span> : textOf(health.hangGyoker)}</dd>
      <dt>Mai felhasználás</dt>
      <dd>{formatSeconds(health.maiMasodperc)} / {formatSeconds(health.napiKeret)} napi keret</dd>
      <dt>Hang</dt>
      <dd>{health.hang}</dd>
      <dt>Modell</dt>
      <dd>{health.modell}</dd>
      <dt>Nyelv</dt>
      <dd>{health.nyelv}</dd>
      <dt>Kérések</dt>
      <dd>{health.counts.kerelmek} összesen, {health.counts.kesz} kész, {health.counts.hiba} hibás</dd>
      <dt>Port-fájl</dt>
      <dd className="tts-mono">{health.portFile}</dd>
      <dt>MCP-shim</dt>
      <dd className="tts-mono">{health.shim}</dd>
    </dl>
  )
}

/**
 * The entry as JSON text. Rendered as a text child of a `pre`, so whatever
 * the paths contain arrives as characters, and the access key is the
 * placeholder the server sent: the operator fills it in by hand from the
 * host's `.env.local`, and this page never sees the value.
 */
export function McpPanel({ config }: { config: McpConfig }) {
  return (
    <>
      <p className="tts-muted">Másold be a Settings → MCP Servers alá. A SWARMCLAW_ACCESS_KEY értékét a host .env.local fájljából írd be kézzel; ez a lap nem ismeri.</p>
      <p className="tts-muted">A command a hostot futtató programot nevezi meg teljes úton, nem a „node” szót: a host a saját PATH-jával indítja a szervert, és a csomagolt alkalmazásé nem tartalmaz Node-ot. Ha az alkalmazást áthelyezed vagy frissíted, másold be újra ezt a blokkot.</p>
      <pre className="tts-pre">{JSON.stringify(config, null, 2)}</pre>
    </>
  )
}

export function UninstallNotes() {
  return (
    <ol className="tts-steps">
      <li>A Settings → MCP Servers alól töröld a <code>tts</code> bejegyzést; amíg ott van, a shim névvel bukik, nem csendben.</li>
      <li>Az extension eltávolítása eldobja az <code>ext_tts_</code> táblákat, a cache-t és a napi számlálót velük. A cache-fájlok a hívók könyvtáraiban maradnak: a videómodulé a Remotion-projekt <code>public/narracio/swarmclaw/</code> alatt. Ez az oldal nem törli más könyvtár fájljait.</li>
    </ol>
  )
}

/**
 * The newest requests. `szoveg` and `fajl` are rendered as text children and
 * nowhere else: the text was written by whoever asked, and a path is the
 * caller's own. `total` is the table's count from `health`; when more rows
 * stand behind the list than were dealt, the list says so with both numbers
 * instead of implying it is the whole table.
 */
export function KerelemList({ rows, total }: { rows: Kerelem[]; total: number | null }) {
  if (rows.length === 0) return <p className="tts-muted">Még nem volt kérés.</p>
  return (
    <div>
      {rows.map((row, i) => {
        const badge = statusBadge(row.status, row.hiba_kod)
        return (
          <div className="tts-row" key={typeof row.id === 'string' ? row.id : `row-${i}`}>
            <p>{textOf(row.szoveg)}</p>
            <div className="tts-meta tts-mono">
              <span className={`tts-badge${badge.known && row.status !== 'hiba' ? '' : ' tts-badge-bad'}`}>{badge.text}</span>
              <span>{formatMs(row.hossz_ms)}</span>
              <span>{routeText(row.kerte)}</span>
              <span>{textOf(row.hang)} · {textOf(row.modell)} · {textOf(row.nyelv)}</span>
              <span>{formatDate(row.created_at)}</span>
            </div>
            <div className="tts-meta tts-mono"><span>{textOf(row.fajl)}</span></div>
          </div>
        )
      })}
      {total !== null && total > rows.length && (
        <p className="tts-muted tts-capped">A lista az utolsó {rows.length} kérést mutatja; összesen {total} van.</p>
      )}
    </div>
  )
}

/**
 * Registration happens at top-level script scope, where
 * `document.currentScript` still names the tag the loader injected. The
 * extension id comes from that tag: the registry keys pages on the extension
 * file's id and refuses a registration under any other, so it is read rather
 * than written here. A missing id is passed through as '' and the registry's
 * own message says what to fix.
 *
 * Guarded on `document` so the same module can be imported by the tests,
 * which render the components on the server and have no host to register with.
 */
if (typeof document !== 'undefined') {
  hostOf().registerPage('tts', TtsPage, { react: hostReact(), extensionId: currentExtensionId() ?? '' })
}
