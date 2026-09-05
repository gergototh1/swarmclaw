import { useEffect, useState } from 'react'

import type { KimenoSor, KonyvSor, McpConfig, Rpc } from './api'
import { errorText, readMcpConfig } from './api'
import { bizonytalanKiiras, konyvKiiras, mcpJson } from './format'

/**
 * The foot of the page: the MCP entry to copy, and what to do before
 * uninstalling.
 *
 * WHY THE MCP ENTRY IS TEXT AND NOT A BUTTON. The host does not register MCP
 * servers on an extension's behalf, and nothing on this side can write a
 * setting the host owns. So the entry is printed for the operator to paste
 * into Settings > MCP Servers, exactly as `mcpConfig` built it -- including
 * `command`, which is `process.execPath` and therefore an absolute path into
 * the running app. That path is a fact about where the app is NOW: moving or
 * replacing the app changes it, and the stored entry then names a runtime that
 * is gone. The sentence under the block says so, because a page that printed
 * an absolute path without saying that would be promising a permanence it
 * cannot give.
 *
 * THE ACCESS KEY IS NEVER PRINTED. `SWARMCLAW_ACCESS_KEY` arrives from the
 * server carrying an instruction where a value would be, and this component
 * does not know the difference: it prints what it was handed. Nothing in this
 * bundle reads a key.
 *
 * WHY THE UNINSTALL SECTION EXISTS AT ALL. `deleteExtension` drops the
 * `ext_gmail_` tables, and after that there is no row for a draft standing in
 * Gmail to be attached to -- so the drafts stay in the mailbox with nothing
 * here listing them. The credential is the operator's to delete and DELETING
 * IT IS NOT REVOKING IT: the refresh token stays valid at Google until the
 * account's owner withdraws access in their own Google settings. The address
 * book goes with the tables, and a reinstall starts empty. That last one is a
 * deliberate consequence rather than a defect -- the book is the only gate on
 * the outbound side, and a gate that survives a reinstall without anybody
 * looking at it is not a gate -- which is why the book is printed here in a
 * copyable form before anything is deleted.
 */

/** The entry itself. Split out so the test can render it without a load. */
export function McpBlokk({ config }: { config: McpConfig }) {
  return (
    <div className="gm-mcp">
      <p className="gm-line gm-muted">
        Settings → MCP Servers, új bejegyzés. Ezt a modul nem tudja magától felvenni: az MCP-bejegyzések a hosté.
      </p>
      <pre className="gm-szoveg gm-mcp-json">{mcpJson(config)}</pre>
      <p className="gm-line gm-muted">
        A <span className="gm-mono">command</span> ennek a futó appnak az abszolút útvonala. Ha az appot áthelyezed vagy frissíted, ez az útvonal megváltozik, és a mentett bejegyzés egy nem létező futtatókörnyezetet fog megnevezni: akkor másold be újra ezt a blokkot.
      </p>
      <p className="gm-line gm-muted">
        A <span className="gm-mono">SWARMCLAW_ACCESS_KEY</span> értékét a host <span className="gm-mono">.env.local</span> fájljából kézzel kell bemásolnod. Ez a lap kulcsértéket sem nem olvas, sem nem ír ki.
      </p>
    </div>
  )
}

/**
 * The uninstall guide.
 *
 * `nyitottPiszkozat` and `bizonytalanSzam` are `null` when the health block
 * could not be read, and `kimeno` is `null` when the outbound page could not
 * be. The count is then unknown, and the guide says that rather than printing a
 * 0 next to the one step whose whole point is that unreleased drafts survive
 * the uninstall, or an empty box next to the one step whose whole point is that
 * an unanswered send has no other record.
 */
export function UninstallBlokk({ konyv, kimeno, bizonytalanSzam, nyitottPiszkozat }: {
  konyv: readonly KonyvSor[] | null
  kimeno: readonly KimenoSor[] | null
  bizonytalanSzam: number | null
  nyitottPiszkozat: number | null
}) {
  return (
    <details className="gm-uninstall">
      <summary>Uninstall előtt</summary>
      <ol>
        <li>
          Adj ki vagy vess el minden piszkozatot a Kimenő nézetben.{' '}
          {nyitottPiszkozat === null
            ? 'Hány van nyitva, azt most nem tudni: az állapotot nem sikerült lekérdezni.'
            : `Most ${nyitottPiszkozat} nyitott piszkozat van.`}{' '}
          Az eltávolítás eldobja az <span className="gm-mono">ext_gmail_</span> táblákat, és utána a Gmailben álló piszkozatokhoz nem tartozik semmilyen sor, amihez a kiadás vagy a törlés kötődhetne.
        </li>
        <li>
          Töröld a <span className="gm-mono">google-oauth:gmail</span> hitelesítőt a Credentials képernyőn, és ha az AI Signal átállása megtörtént, a <span className="gm-mono">google-oauth:aisignal</span> hitelesítőt is.
        </li>
        <li>
          <strong>A törlés nem visszavonás.</strong> A fiók itt le lesz választva, de a refresh token a Google-nál érvényes marad, amíg a fiók tulajdonosa a saját Google-fiókbeállításaiban vissza nem vonja a hozzáférést.
        </li>
        <li>
          Töröld az MCP-bejegyzést a Settings → MCP Servers alatt. Amíg ott áll, a shim egy hívásra <span className="gm-mono">gmail_extension_hianyzik</span>-kal bukik, nem csendben.
        </li>
        <li>
          A <span className="gm-mono">mailbox</span> szerződés fogyasztóinak a következő hívása <span className="gm-mono">provider_missing</span> lesz. Ez névvel bukik: az AI Signal sweepje nem lép előre a frontierben.
        </li>
        <li>
          Az újratelepítés üres táblákkal indul, tehát <strong>a címzettkönyv elvész.</strong> Ez szándékos: a könyv az egyetlen kapu a kimenő oldalon, és egy kapu, ami egy újratelepítést túlél anélkül, hogy bárki ránézne, nem kapu. Másold ki innen, ha meg akarod tartani:
        </li>
      </ol>
      <pre className="gm-szoveg gm-konyv-kiiras">{konyvKiiras(konyv)}</pre>
      <p className="gm-line">
        <strong>A bizonytalan sorok is elvesznek, és ezeket máshonnan nem lehet pótolni.</strong>{' '}
        {bizonytalanSzam === null
          ? 'Hány van, azt most nem tudni: az állapotot nem sikerült lekérdezni.'
          : `Most ${bizonytalanSzam} ilyen sor van.`}{' '}
        Egy ilyen sornál a küldés elindult, és a Gmail nem válaszolt rá: nem tudjuk, kiment-e a levél, és az eltávolítás után nem marad semmi, amiből ez a kérdés egyáltalán felvethető volna. Másold ki, mielőtt bármit törölnél, és a választ a postafiók Elküldött mappájában keresd.
      </p>
      <pre className="gm-szoveg gm-bizonytalan-kiiras">{bizonytalanKiiras(kimeno, bizonytalanSzam)}</pre>
    </details>
  )
}

export function Lablec({ rpc, konyv, kimeno, bizonytalanSzam, nyitottPiszkozat }: {
  rpc: Rpc
  konyv: readonly KonyvSor[] | null
  kimeno: readonly KimenoSor[] | null
  bizonytalanSzam: number | null
  nyitottPiszkozat: number | null
}) {
  const [config, setConfig] = useState<McpConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    rpc('mcpConfig')
      .then((raw) => { if (!stale) { setConfig(readMcpConfig(raw)); setError(null) } })
      .catch((err: unknown) => { if (!stale) setError(errorText(err)) })
    return () => { stale = true }
  }, [rpc])

  return (
    <div className="gm-lablec">
      <h3>MCP-bejegyzés</h3>
      {error !== null && <p className="gm-error" role="alert">Az MCP-bejegyzést nem sikerült lekérdezni, tehát nincs mit bemásolni: {error}</p>}
      {config === null && error === null && <p className="gm-muted">Betöltés…</p>}
      {config !== null && <McpBlokk config={config} />}

      <h3>Eltávolítás</h3>
      <UninstallBlokk konyv={konyv} kimeno={kimeno} bizonytalanSzam={bizonytalanSzam} nyitottPiszkozat={nyitottPiszkozat} />
    </div>
  )
}
