import { useCallback, useEffect, useState } from 'react'

import type { Board, Rpc, Uzenet } from './api'
import { errorText, readBoard } from './api'
import { CimzettekNezet } from './cimzettek'
import { currentExtensionId, hostOf, hostReact } from './host'
import { KimenoNezet } from './kimeno'
import { KiserletekNezet } from './kiserletek'
import { Lablec } from './lablec'
import { StatusBar } from './status-bar'

/**
 * The page: one `board` load, a status bar, three views and a foot.
 *
 * IT IS NOT A VIEWER. It is the only surface in this system that can send a
 * letter. Every layer under it stops at a draft on purpose -- neither the
 * contract handle nor the MCP shim carries a caller identity the host
 * re-checks, so nobody can be held responsible for what goes out -- and this
 * page is the person who is. That is why `releaseDraft` lives on the rpc and
 * nowhere else, and why the release here is two steps with a fresh read
 * between them (see kimeno.tsx).
 *
 * ONE REQUEST FILLS THREE OF THE FOUR SECTIONS. `board` carries the health
 * block, the outbound queue and the address book together, because those three
 * are what a page load needs and the operator reads them against each other:
 * an out-of-book recipient only means something beside the book. The attempts
 * list and the MCP entry are their own requests, made by their own views when
 * the operator opens them, so a page load does not fetch a refusal log and an
 * absolute path nobody asked for.
 *
 * THE STATUS BAR NEVER WAITS ON THE QUEUE. A board that failed costs the
 * queue, the book and the health block, and the bar says which -- but the
 * tabs, the foot and the bar's own frame are drawn anyway. The video page was
 * rebuilt for exactly this reason: with everything behind one load, a single
 * refused response left the operator with nothing but that response's message,
 * on a page whose whole job is to be readable while things are broken.
 *
 * THERE IS NO SCHEDULE CHECK HERE, and its absence is deliberate rather than
 * an omission. The sibling pages ask the host whether their declared schedules
 * exist, because an unreconciled install leaves their queue permanently empty
 * with nothing to say so. This module declares no managed agent and no
 * schedule at all (design spec 11.10): nothing runs on a timer, every draft is
 * written by a caller and every release is a click. A line reporting "0
 * ütemezés" would invite the operator to press Reconcile for something that
 * does not exist.
 *
 * NO KEY HANDLER, NO EVENT LISTENER, ANYWHERE IN THIS BUNDLE. The aisignal
 * page's review found a window-level `keydown` handler taking Enter from every
 * focused control, so a keyboard operator could activate no button at all and
 * each attempt opened a stranger's url instead. Every interaction on this page
 * is a `<button>`, a `<label>`ed input, or a `<form onSubmit>`; the browser's
 * own activation behaviour is the whole keyboard implementation, and
 * test/ui.test.mjs pins that the built bundle contains no `addEventListener`.
 *
 * `version` counts successful board loads and keys the queue, so a reload
 * gives it a fresh subtree instead of new rows under old panel state -- an
 * open release panel holding a confirmation hash from a previous load is
 * exactly the stale preview this page exists to prevent.
 */

type Nezet = 'kimeno' | 'cimzettek' | 'kiserletek'

export function GmailPage({ extensionId, rpc }: { extensionId: string; rpc: Rpc }) {
  const [board, setBoard] = useState<{ value: Board; version: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nezet, setNezet] = useState<Nezet>('kimeno')
  // The outcome of the last write, held HERE and not in the view that made it.
  // The queue and the book are keyed on `version`, so the refresh that follows
  // a successful write remounts them; a message kept inside one of those
  // subtrees is destroyed by that remount. A browser pass caught exactly that:
  // a letter went out and the page said nothing, because the reload that
  // followed the send wiped the sentence reporting it. It is also above the
  // tabs rather than inside a view, so switching views does not lose the one
  // outcome in this system that cannot be undone.
  const [uzenet, setUzenet] = useState<Uzenet | null>(null)

  const refresh = useCallback(() => {
    rpc('board')
      .then((raw) => {
        const value = readBoard(raw)
        setBoard((prev) => ({ value, version: (prev?.version ?? 0) + 1 }))
        setError(null)
      })
      .catch((err: unknown) => setError(errorText(err)))
  }, [rpc])

  useEffect(() => { refresh() }, [refresh])

  const tab = (kind: Nezet, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={nezet === kind}
      className={`gm-tab${nezet === kind ? ' gm-tab-active' : ''}`}
      onClick={() => setNezet(kind)}
    >
      {label}
    </button>
  )

  return (
    <div className="gm-root" data-extension={extensionId}>
      {error && (
        <p className="gm-error" role="alert">
          {board ? 'A frissítés nem sikerült, a lenti állapot a korábbi betöltésé: ' : 'Nem sikerült betölteni: '}{error}
        </p>
      )}
      {!board && !error && <p className="gm-muted">Betöltés…</p>}

      {uzenet && (
        <p className={`gm-notice gm-${uzenet.kind}`} role="status">
          {uzenet.text}
          <button type="button" className="gm-btn gm-btn-small" onClick={() => setUzenet(null)}>Elrejt</button>
        </p>
      )}

      <StatusBar
        health={board ? board.value.health : null}
        healthError={board ? null : error}
        onRefresh={refresh}
      />

      <div className="gm-tabs" role="tablist">
        {tab('kimeno', 'Kimenő')}
        {tab('cimzettek', 'Címzettek')}
        {tab('kiserletek', 'Kísérletek')}
      </div>

      {nezet === 'kimeno' && (board
        ? <KimenoNezet key={board.version} board={board.value} rpc={rpc} onChanged={refresh} onUzenet={setUzenet} />
        : <p className="gm-muted">A kimenő sort nem sikerült betölteni, ezért itt semmi nem látszik. Ez nem azt jelenti, hogy nincs nyitott piszkozat.</p>)}
      {nezet === 'cimzettek' && (board
        ? <CimzettekNezet key={board.version} konyv={board.value.konyv} rpc={rpc} onChanged={refresh} onUzenet={setUzenet} />
        : <p className="gm-muted">A címzettkönyvet nem sikerült betölteni, ezért itt semmi nem látszik. Ez nem azt jelenti, hogy üres.</p>)}
      {nezet === 'kiserletek' && <KiserletekNezet rpc={rpc} />}

      <Lablec
        rpc={rpc}
        konyv={board ? board.value.konyv : null}
        nyitottPiszkozat={board ? board.value.health.szamok.piszkozat : null}
      />
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
 * Guarded on `document` so the same module can be imported by the tests, which
 * render the components on the server and have no host to register with.
 */
if (typeof document !== 'undefined') {
  hostOf().registerPage('gmail', GmailPage, { react: hostReact(), extensionId: currentExtensionId() ?? '' })
}
