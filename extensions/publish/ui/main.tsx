import { useState } from 'react'

import { makeRpc, type Rpc } from './api'
import { FiokokNezet } from './fiokok'
import { currentExtensionId, hostOf, hostReact } from './host'
import { KiadasNezet } from './kiadas'
import { NaptarNezet } from './naptar'

/**
 * The page: the calendar (with the release detail view nested inside it, the
 * same "open a card" pattern `extensions/crm/ui/main.tsx` uses for its own
 * account detail) and the accounts screen, design spec 8's three views.
 *
 * Copied skeleton from `extensions/crm/ui/main.tsx`: the tab nav, the
 * `registerPage` call at module scope guarded on `currentExtensionId()`, and
 * the `data-extension` stamp that only exists once this is bundled and
 * injected by the loader.
 */

type Nezet = 'naptar' | 'fiokok'

export function PublishPage({ rpc }: { extensionId: string; rpc: Rpc }) {
  const [nezet, setNezet] = useState<Nezet>('naptar')
  const [nyitottKiadas, setNyitottKiadas] = useState<string | null>(null)

  return (
    <div className="pub-app">
      <nav className="pub-nav">
        <button
          type="button"
          onClick={() => { setNezet('naptar'); setNyitottKiadas(null) }}
          aria-pressed={nezet === 'naptar'}
        >
          Naptár
        </button>
        <button type="button" onClick={() => setNezet('fiokok')} aria-pressed={nezet === 'fiokok'}>Fiókok</button>
      </nav>
      <main className="pub-fo">
        {nezet === 'naptar' && (nyitottKiadas !== null
          ? <KiadasNezet rpc={rpc} kiadasId={nyitottKiadas} onBack={() => setNyitottKiadas(null)} />
          : <NaptarNezet rpc={rpc} onOpen={setNyitottKiadas} />)}
        {nezet === 'fiokok' && <FiokokNezet rpc={rpc} />}
      </main>
    </div>
  )
}

const extensionId = currentExtensionId()
if (extensionId) {
  const rpc = makeRpc(extensionId)
  hostOf().registerPage(
    'publish',
    (props: Record<string, unknown>) => <PublishPage extensionId={extensionId} rpc={rpc} {...props} />,
    { react: hostReact(), extensionId },
  )
}
