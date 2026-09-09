import { useCallback, useEffect, useState } from 'react'

import type { Board, Decision, ManagedStatus, Rpc } from './api'
import { errorText, readBoard } from './api'
import { Deck } from './deck'
import { currentExtensionId, hostOf, hostReact } from './host'
import { List } from './list'
import { loadManagedStatus } from './managed-state'
import { StatusBar } from './status-bar'

/**
 * The page: one `board` load, a status bar, and a tab between the deck and
 * the list.
 *
 * A load that fails is shown as its message, and a board that has already
 * been shown stays on screen under that message rather than being replaced by
 * it: the operator can still read what was loaded, and the message says the
 * refresh did not land. Before the first board there is nothing to keep, so
 * the message stands alone. In neither case is an empty board drawn for a
 * response that did not arrive.
 *
 * `version` counts successful loads and keys the deck, so a reload gives the
 * deck a fresh controller rather than an old undo stack over new rows.
 *
 * The schedule check is a second request, to the host rather than to this
 * extension's rpc, and it is refreshed with the board so a Reconcile pressed
 * in another tab shows up on the next Frissítés. It never fails the page: its
 * own failure is one of its three states (see managed-state.ts).
 */
export function AiSignalPage({ extensionId, rpc }: { extensionId: string; rpc: Rpc }) {
  const [board, setBoard] = useState<{ value: Board; version: number } | null>(null)
  const [managed, setManaged] = useState<ManagedStatus | null>(null)
  const [view, setView] = useState<'deck' | 'list'>('deck')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    rpc('board')
      .then((raw) => {
        const value = readBoard(raw)
        setBoard((prev) => ({ value, version: (prev?.version ?? 0) + 1 }))
        setError(null)
      })
      .catch((err: unknown) => setError(errorText(err)))
    void loadManagedStatus((input, init) => fetch(input, init), extensionId).then(setManaged)
  }, [rpc, extensionId])

  useEffect(() => { refresh() }, [refresh])

  const decide = useCallback((id: string, decision: Decision) => rpc('decide', { id, decision }), [rpc])

  return (
    <div className="ais-root" data-extension={extensionId}>
      {/* A lap neve a lapon van, nem csak a bal sávban -- a hoszt minden
          teljes szélességű lapja így kezdődik. */}
      <h1 className="ais-cim">AI Signal</h1>
      {error && (
        <p className="ais-error" role="alert">
          {board ? 'A frissítés nem sikerült, a lenti állapot a korábbi betöltésé: ' : 'Nem sikerült betölteni: '}{error}
        </p>
      )}
      {!board && !error && <p className="ais-muted">Betöltés…</p>}
      {board && (
        <>
          <StatusBar board={board.value} managed={managed} onRefresh={refresh} />
          <div className="ais-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'deck'} className={`ais-tab${view === 'deck' ? ' ais-tab-active' : ''}`} onClick={() => setView('deck')}>Pakli</button>
            <button type="button" role="tab" aria-selected={view === 'list'} className={`ais-tab${view === 'list' ? ' ais-tab-active' : ''}`} onClick={() => setView('list')}>Lista</button>
          </div>
          {view === 'deck'
            ? <Deck key={board.version} board={board.value} decide={decide} onChanged={refresh} />
            : <List rpc={rpc} decide={decide} limit={board.value.allLimit} onChanged={refresh} />}
        </>
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
  hostOf().registerPage('aisignal', AiSignalPage, { react: hostReact(), extensionId: currentExtensionId() ?? '' })
}
