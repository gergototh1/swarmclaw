import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Allapot, Fa, Rpc } from './api'
import { errorText, readAllapot, readFa } from './api'
import { FaOszlop } from './fa'
import { currentExtensionId, hostOf, hostReact } from './host'
import { Panel } from './panel'
import { Szerkeszto } from './szerkeszto'

/**
 * The page: a status strip and three columns.
 *
 * TWO LOADS, TWO FAILURE STATES, NEVER FOLDED TOGETHER. `allapot` failing means
 * the module could not be asked about itself; `fa` failing means the tree could
 * not be read. Neither gates the other, and neither is drawn as its opposite: a
 * tree that never loaded shows its message rather than an empty folder list,
 * and a status that could not be read does not make the page pretend everything
 * is fine.
 *
 * The most important thing this page can say is that the root is unwritable,
 * and it says it at the top, with the way out -- because a reader who does not
 * see that reads the empty tree below it as "I have no documents".
 */

export function DocsPage({ rpc }: { extensionId: string; rpc: Rpc }) {
  const [fa, setFa] = useState<Fa | null>(null)
  const [faHiba, setFaHiba] = useState<string | null>(null)
  const [allapot, setAllapot] = useState<Allapot | null>(null)
  const [allapotHiba, setAllapotHiba] = useState<string | null>(null)
  const [aktivId, setAktivId] = useState<string | null>(null)
  const [agentNevek, setAgentNevek] = useState<Map<string, string>>(new Map())

  const refresh = useCallback(() => {
    rpc('fa')
      .then((raw) => { setFa(readFa(raw)); setFaHiba(null) })
      .catch((err) => setFaHiba(String(err?.message ?? err)))
    rpc('allapot')
      .then((raw) => { setAllapot(readAllapot(raw)); setAllapotHiba(null) })
      .catch((err) => setAllapotHiba(String(err?.message ?? err)))
    rpc('ugynokok')
      .then((raw) => {
        if (errorText(raw)) return
        const list = (raw as { ugynokok?: Array<{ slug?: string }> }).ugynokok ?? []
        setAgentNevek(new Map(list.map((a) => [String(a.slug ?? ''), String(a.slug ?? '')])))
      })
      .catch(() => { /* A fa a sluggal is használható; ez csak szebb nevet adna. */ })
  }, [rpc])

  useEffect(() => { refresh() }, [refresh])

  const cimek = useMemo(() => new Set(fa?.cimek ?? []), [fa])

  return (
    <div className="docs-lap">
      {allapot && !allapot.gyokerRendben && (
        <p className="docs-sav docs-sav-baj" role="alert">
          A doksi-gyökér nem érhető el: {allapot.gyokerHiba ?? allapot.beallitottGyoker}. Állítsd be a Doksik
          extension beállításainál, aztán frissítsd ezt a lapot.
        </p>
      )}
      {allapotHiba && <p className="docs-sav docs-sav-baj" role="alert">Az állapot nem olvasható: {allapotHiba}</p>}
      {allapot?.gyokerRendben && !allapot.figyeloFut && (
        <p className="docs-sav">
          A külső szerkesztés figyelése áll{allapot.figyeloHiba ? `: ${allapot.figyeloHiba}` : ''}. A Finderben vagy
          Obsidianban végzett módosítás nem jelenik meg a keresőben, amíg újra nem indítod.
          <button type="button" onClick={() => { rpc('figyeloUjraindit').then(refresh).catch(() => refresh()) }}>
            Újraindítom
          </button>
          <button type="button" onClick={() => { rpc('ujraindex').then(refresh).catch(() => refresh()) }}>
            Újraindexelem most
          </button>
        </p>
      )}

      <div className="docs-hasabok">
        <FaOszlop
          rpc={rpc}
          fa={fa}
          faHiba={faHiba}
          aktivId={aktivId}
          onOpen={setAktivId}
          onValtozott={refresh}
          agentNevek={agentNevek}
        />
        <Szerkeszto rpc={rpc} id={aktivId} cimek={cimek} onMentve={refresh} />
        <Panel rpc={rpc} id={aktivId} onValtozott={refresh} />
      </div>
    </div>
  )
}

/**
 * Registration happens at top-level script scope, where
 * `document.currentScript` still names the tag the loader injected. The
 * extension id comes from that tag: the registry keys pages on the extension
 * file's id and refuses a registration under any other, so it is read rather
 * than written here.
 *
 * Guarded on `document` so the same module can be imported by the tests, which
 * have no host to register with.
 */
if (typeof document !== 'undefined') {
  hostOf().registerPage('docs', DocsPage, { react: hostReact(), extensionId: currentExtensionId() ?? '' })
}
