import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Board, Health, ManagedStatus, Rpc } from './api'
import { errorText, readBoard, readHealth } from './api'
import { currentExtensionId, hostOf, hostReact } from './host'
import { Javaslatok } from './javaslatok'
import { loadManagedStatus } from './managed-state'
import { Sablonok } from './sablonok'
import { Sor } from './sor'
import { StatusBar } from './status-bar'
import { VideoView } from './video'

/**
 * The page: one `board` load, one `health` load, one question to the host
 * about the schedules, a status bar and four views.
 *
 * THREE REQUESTS, THREE FAILURE STATES, NEVER FOLDED. `board` failing means
 * the queue could not be read; `health` failing means the module's own
 * conditions could not be read; the managed-resources request failing means
 * the schedules could not be checked. Each is reported where it belongs and
 * none is drawn as its opposite: a board that never loaded shows its message
 * instead of an empty queue, a board that failed to RELOAD keeps what was
 * there under a message saying the state is stale, and a health that could
 * not be read makes the status bar say so rather than fall back to a calm
 * layout.
 *
 * `version` counts successful board loads and keys the queue, so a reload
 * gives it a fresh subtree instead of new rows under old state.
 *
 * The evidence links on the Javaslatok view need to know which stored ids are
 * videos, and only the board can say: ids in this module are opaque hex with
 * no prefix. The set is built from the board here and passed down.
 */

type Nezet = { kind: 'sor' } | { kind: 'video'; id: string } | { kind: 'javaslatok' } | { kind: 'sablonok' }

export function VideoPage({ extensionId, rpc }: { extensionId: string; rpc: Rpc }) {
  const [board, setBoard] = useState<{ value: Board; version: number } | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [managed, setManaged] = useState<ManagedStatus | null>(null)
  const [nezet, setNezet] = useState<Nezet>({ kind: 'sor' })
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    rpc('board')
      .then((raw) => {
        const value = readBoard(raw)
        setBoard((prev) => ({ value, version: (prev?.version ?? 0) + 1 }))
        setError(null)
      })
      .catch((err: unknown) => setError(errorText(err)))
    rpc('health')
      .then((raw) => { setHealth(readHealth(raw)); setHealthError(null) })
      .catch((err: unknown) => setHealthError(errorText(err)))
    void loadManagedStatus((input, init) => fetch(input, init), extensionId).then(setManaged)
  }, [rpc, extensionId])

  useEffect(() => { refresh() }, [refresh])

  const videoIdk = useMemo(() => {
    const ids = new Set<string>()
    if (board) for (const cards of Object.values(board.value.oszlopok)) for (const card of cards) ids.add(card.id)
    return ids
  }, [board])

  const tab = (kind: 'sor' | 'javaslatok' | 'sablonok', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={nezet.kind === kind}
      className={`vid-tab${nezet.kind === kind ? ' vid-tab-active' : ''}`}
      onClick={() => setNezet({ kind })}
    >
      {label}
    </button>
  )

  return (
    <div className="vid-root" data-extension={extensionId}>
      {error && (
        <p className="vid-error" role="alert">
          {board ? 'A frissítés nem sikerült, a lenti állapot a korábbi betöltésé: ' : 'Nem sikerült betölteni: '}{error}
        </p>
      )}
      {!board && !error && <p className="vid-muted">Betöltés…</p>}
      {board && (
        <>
          <StatusBar board={board.value} health={health} healthError={healthError} managed={managed} onRefresh={refresh} rpc={rpc} />
          <div className="vid-tabs" role="tablist">
            {tab('sor', 'Sor')}
            {tab('javaslatok', 'Javaslatok')}
            {tab('sablonok', 'Sablonok')}
          </div>
          {nezet.kind === 'sor' && <Sor key={board.version} board={board.value} onOpen={(id) => setNezet({ kind: 'video', id })} />}
          {nezet.kind === 'video' && <VideoView rpc={rpc} id={nezet.id} onBack={() => { setNezet({ kind: 'sor' }); refresh() }} />}
          {nezet.kind === 'javaslatok' && <Javaslatok rpc={rpc} videoIdk={videoIdk} onOpenVideo={(id) => setNezet({ kind: 'video', id })} />}
          {nezet.kind === 'sablonok' && <Sablonok rpc={rpc} />}
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
 * which render the components on the server and have no host to register
 * with.
 */
if (typeof document !== 'undefined') {
  hostOf().registerPage('video', VideoPage, { react: hostReact(), extensionId: currentExtensionId() ?? '' })
}
