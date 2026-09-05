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
 * AND NONE OF THE THREE GATES THE OTHERS. Keeping the whole page behind
 * `board` is what turned one refused response into a blank page: the status
 * bar, the health lines, the Reconcile sentence and every tab were inside
 * that branch, so the only thing the operator could read was the board's own
 * error. What a failed board load costs is the queue, and nothing else. This
 * is the shape the tts page has (extensions/tts/ui/main.tsx): every section
 * draws in its own three states, and a section that failed sits under its
 * message beside the sections that did not.
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
      {/*
        The status bar and the tabs do NOT wait on the board. They used to,
        and one failed `board` call then took the whole page with it: the
        health lines, the schedule sentence, the Reconcile warning and every
        view were behind it, and all the operator got was the board's error
        message. The three loads are three facts and are drawn as three: the
        bar renders what it has, the queue says it could not be read, and the
        other views make their own requests and answer for themselves.
      */}
      <StatusBar board={board ? board.value : null} health={health} healthError={healthError} managed={managed} onRefresh={refresh} rpc={rpc} />
      <div className="vid-tabs" role="tablist">
        {tab('sor', 'Sor')}
        {tab('javaslatok', 'Javaslatok')}
        {tab('sablonok', 'Sablonok')}
      </div>
      {nezet.kind === 'sor' && (board
        ? <Sor key={board.version} board={board.value} onOpen={(id) => setNezet({ kind: 'video', id })} />
        : <p className="vid-muted">A sor nem érhető el.</p>)}
      {nezet.kind === 'video' && <VideoView rpc={rpc} id={nezet.id} onBack={() => { setNezet({ kind: 'sor' }); refresh() }} />}
      {nezet.kind === 'javaslatok' && <Javaslatok rpc={rpc} videoIdk={videoIdk} onOpenVideo={(id) => setNezet({ kind: 'video', id })} />}
      {nezet.kind === 'sablonok' && <Sablonok rpc={rpc} />}
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
