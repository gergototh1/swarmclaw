import { useState } from 'react'

import type { Health, HealthItem } from './api'
import { bekothetoE, healthMondat, keretSzoveg } from './format'

/**
 * What the operator reads before anything else: every condition this module
 * can be stopped or narrowed by, as its own sentence.
 *
 * NOTHING HERE IS FOLDED TOGETHER, and that is the whole point of the bar.
 * `runHealth` keeps three lists apart -- what blocks, what only narrows, and
 * what nobody could answer -- and a bar that drew them as one red dot would
 * throw that separation away at the last step. So:
 *
 *   - a blocking code is `.gm-bad`, gets the spec's own sentence and names the
 *     remedy;
 *   - a narrowing code is `.gm-warn` and says which single capability it
 *     stops, never more;
 *   - a question that was not answered says so in those words and is neither.
 *     Its absence from the failure list is not a pass, and the bar says that
 *     too.
 *
 * A health that could not be READ AT ALL is the same third kind one level up:
 * the bar prints the failure and does not fall back to a calm layout.
 *
 * THE OPERATOR WILL READ THIS PAGE WHILE THINGS ARE BROKEN. On a host with no
 * Google OAuth client -- which is the state this module ships into -- there is
 * no credential, nothing reaches Gmail, and every list below is empty for that
 * reason and not because the module is idle. That is why the failure sentences
 * come first, above the counters, and why the counters say what they are
 * counting.
 */

/**
 * The host's own consent route, root-relative so this bundle never needs to
 * know the origin, and behind the same auth cookie the page itself was served
 * with.
 *
 * IT IS REACHED BY A BUTTON, NOT BY A LINK, and the difference is the whole
 * reason this control was written twice. The aisignal page offers a plain
 * `<a href>`, and a host with no OAuth client answers that navigation with a
 * JSON body on a blank tab. Here the `health` load already knows whether a
 * client exists, so the control is DISABLED with the sentence beside it rather
 * than sending anybody anywhere. The route's 409 is the fallback for the one
 * case this cannot cover -- a client removed between the health read and the
 * click -- and 409 is what makes that answer readable instead of a bare 500.
 *
 * WHERE THE CONSENT SCREEN OPENS IN THE DESKTOP APP (design spec 14, third
 * open point; settled 2026-09-05 by reading `electron/external-navigation.ts`
 * rather than by a live consent, which has not been run). Not in this window:
 * this URL is app-origin, so the click starts in the window, and the 302 to
 * `accounts.google.com` arrives on Electron's `will-redirect`, where
 * `shouldExternaliseNavigation` sees a cross-origin main-frame navigation and
 * hands it to `shell.openExternal`. Google refuses to render consent in an
 * embedded user agent at all (`disallowed_useragent`), so the system browser
 * is the only place it can happen. The consequence an operator sees is that
 * the callback lands on `http://127.0.0.1:<port>` IN THAT BROWSER, and the
 * connected mailbox shows up in the app window only after this page is
 * reloaded there.
 */
const CONNECT_URL = '/api/oauth/google/start?purpose=gmail'

/** The codes that mean the mailbox itself has to be connected or reconnected. Each one already has its own sentence above the button. */
const UJRA_BEKOTES = Object.freeze(['gmail_hitelesites_hianyzik', 'gmail_scope_missing', 'gmail_token_revoked'])

function Mondat({ text, kind = 'plain' }: { text: string; kind?: 'plain' | 'warn' | 'bad' | 'muted' }) {
  return <p className={kind === 'plain' ? 'gm-line' : `gm-line gm-${kind}`}>{text}</p>
}

/** One health code: its sentence, and the remedy under it. A code with no sentence says so rather than borrowing another code's. */
function HealthSor({ item, kind }: { item: HealthItem; kind: 'warn' | 'bad' }) {
  const lap = healthMondat(item)
  return (
    <div className="gm-health-item" data-kod={lap.kod}>
      <p className={`gm-line gm-${kind}`}>{lap.mondat}</p>
      <p className="gm-line gm-muted">Teendő: {lap.teendo}</p>
      {!lap.ismert && <p className="gm-line gm-muted">Ehhez a kódhoz ezen a lapon nincs saját mondat, ezért a kód áll a mondat helyén.</p>}
    </div>
  )
}

/**
 * Everything the bar says once it is open -- every condition on its own line,
 * which is the separation `health.mjs` makes and this file refuses to fold.
 *
 * It is split out for the same reason the other bodies in this bundle are:
 * the shell owns the fold, and a server render never runs a click, so the
 * tests that pin what a state LOOKS like render this half directly.
 */
export function StatusBarBody({ health, healthError }: { health: Health | null; healthError: string | null }) {
  // Not knowing and knowing there is no client are two different answers, and
  // only the second may disable the button. With no health at all the control
  // stays live and the route's 409 carries the remedy; disabling it here would
  // be this page reporting a missing client it never checked.
  const bekotheto = health === null ? true : bekothetoE(health.hibak)
  const ujra = health !== null && health.hibak.some((item) => UJRA_BEKOTES.includes(item.kod))
  return (
    <>
      {healthError && <Mondat kind="bad" text={`Az állapotot nem tudtam lekérdezni: ${healthError}`} />}
      {!health && !healthError && <Mondat kind="muted" text="Az állapot lekérdezése folyamatban." />}

      {health && (
        <Mondat
          kind={health.postafiok ? 'plain' : 'muted'}
          text={health.postafiok
            ? `Bekötött postafiók: ${health.postafiok}`
            : 'Bekötött postafiók: nincs olyan cím, amit a profil-olvasás visszaadott volna.'}
        />
      )}

      {health && health.hibak.map((item) => <HealthSor key={item.kod} item={item} kind="bad" />)}

      <div className="gm-connect">
        <button
          type="button"
          className="gm-btn"
          disabled={!bekotheto}
          onClick={() => { window.location.assign(CONNECT_URL) }}
        >
          {ujra ? 'Postafiók újra bekötése' : 'Postafiók bekötése'}
        </button>
        {!bekotheto && (
          <span className="gm-muted">
            A gomb ki van kapcsolva, mert ezen a hoston nincs OAuth-kliens: a bekötés nem tudna elindulni.
          </span>
        )}
        {bekotheto && health === null && (
          <span className="gm-muted">
            Az állapot még nem érkezett meg, tehát nem tudni, van-e OAuth-kliens. Ha nincs, a bekötés 409-cel válaszol, és a válasz megmondja, mit kell beállítani.
          </span>
        )}
      </div>

      {health && health.figyelmeztetesek.map((item) => <HealthSor key={item.kod} item={item} kind="warn" />)}

      {health && health.nemValaszolt.length > 0 && (
        <div className="gm-health-item">
          <p className="gm-line gm-muted">
            Ezekre a health nem tudott válaszolni: {health.nemValaszolt.map((n) => `${n.mit}${n.kod ? ` (${n.kod})` : ' (kód nélkül)'}`).join(', ')}.
          </p>
          <p className="gm-line gm-muted">
            Abból, hogy ezek nincsenek a hibalistán, nem következik, hogy rendben vannak: a kérdést nem sikerült feltenni, vagy nem jött rá válasz.
          </p>
        </div>
      )}

      {health && health.blokkolt.length > 0 && (
        <Mondat kind="bad" text={`Most blokkolt képességek: ${health.blokkolt.join(', ')}`} />
      )}
      {health && health.blokkolt.length === 0 && (
        <Mondat kind="plain" text="Nincs blokkolt képesség." />
      )}

      {health && (
        <Mondat
          kind={health.keretek.piszkozat.olvashatatlan || health.keretek.kiadas.olvashatatlan ? 'warn' : 'plain'}
          text={`Mai keretek (${health.keretek.nap}): ${keretSzoveg('piszkozat', health.keretek.piszkozat.mai, health.keretek.piszkozat.keret, health.keretek.piszkozat.olvashatatlan)}, ${keretSzoveg('kiadás', health.keretek.kiadas.mai, health.keretek.kiadas.keret, health.keretek.kiadas.olvashatatlan)}`}
        />
      )}

      {health && (
        <Mondat
          kind="muted"
          text={`Sorok: ${health.szamok.piszkozat} piszkozat, ${health.szamok.kiadva} kiadva, ${health.szamok.elvetve} elvetve, ${health.szamok.hiba} hiba, ${health.szamok.bizonytalan} bizonytalan; címzettek: ${health.szamok.eloCimzettek} élő a ${health.szamok.cimzettek}-ból; visszautasított kísérletek: ${health.szamok.kiserletek}`}
        />
      )}

      {health && (
        <Mondat
          kind={health.portFajl.elo ? 'muted' : 'warn'}
          text={`Port-fájl: ${health.portFajl.utvonal} — ${health.portFajl.elo ? 'megvan, és élő folyamatot nevez meg ebből az indításból' : health.portFajl.letezik ? 'megvan, de nem ebből az indításból való élő folyamatot nevez meg' : 'nincs ott'}. Ez a fájl-létezés ellenőrzése, nem ígéret arra, hogy az MCP-szerver csatlakozni fog.`}
        />
      )}
    </>
  )
}

/**
 * The one line the bar shows while it is closed.
 *
 * The bar opens closed (the operator asked for that), which puts a duty on
 * this line: a fault the operator cannot see is a fault they cannot act on,
 * so NOTHING THAT BLOCKS IS HIDDEN BEHIND THE FOLD. What the fold hides is
 * the calm detail -- the frames, the row counts, the port file -- and what it
 * never hides is the name of what is blocked.
 *
 * `figyelmeztetesek` is COUNTED, not listed: it is the group that blocks
 * nothing, and the open bar spells each out with its own remedy.
 */
function osszefoglalo(health: Health | null, healthError: string | null): { text: string; kind: 'plain' | 'warn' | 'bad' | 'muted' } {
  if (healthError) return { text: 'nem tudtam lekérdezni', kind: 'bad' }
  if (!health) return { text: 'lekérdezés folyamatban', kind: 'muted' }
  if (health.blokkolt.length > 0) return { text: `blokkolt: ${health.blokkolt.join(', ')}`, kind: 'bad' }
  // A blocking code that named no capability is still blocking, and the closed
  // bar says its code rather than calling the mailbox ready.
  if (health.hibak.length > 0) return { text: health.hibak.map((h) => h.kod).join(', '), kind: 'bad' }
  if (health.figyelmeztetesek.length > 0) return { text: `${health.figyelmeztetesek.length} figyelmeztetés`, kind: 'warn' }
  return { text: health.postafiok ? `postafiók: ${health.postafiok}` : 'nincs bekötött postafiók', kind: health.postafiok ? 'plain' : 'warn' }
}

export function StatusBar({ health, healthError, onRefresh }: {
  health: Health | null
  healthError: string | null
  onRefresh: () => void
}) {
  // Closed by default: the operator reads the board on this page, not the bar.
  const [nyitva, setNyitva] = useState(false)
  const ossz = osszefoglalo(health, healthError)

  return (
    <div className="gm-status">
      <div className="gm-status-head">
        <button
          type="button"
          className="gm-status-toggle"
          aria-expanded={nyitva}
          onClick={() => setNyitva((v) => !v)}
        >
          <span className="gm-caret" aria-hidden="true">{nyitva ? '▾' : '▸'}</span>
          <strong>Állapot</strong>
          <span className={ossz.kind === 'plain' ? 'gm-muted' : `gm-${ossz.kind}`}>{ossz.text}</span>
        </button>
        <button type="button" className="gm-btn gm-btn-small" onClick={onRefresh}>Frissítés</button>
      </div>

      {nyitva && <StatusBarBody health={health} healthError={healthError} />}
    </div>
  )
}
