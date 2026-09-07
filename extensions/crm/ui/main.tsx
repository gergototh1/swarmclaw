import { useState } from 'react'

import { makeRpc, type Rpc } from './api'
import { currentExtensionId, hostOf, hostReact } from './host'
import { MaNezet } from './ma'
import { UgyekNezet } from './ugyek'
import { UgyfelLap } from './ugyfel-lap'
import { UgyfelekNezet } from './ugyfelek'

type Nezet = 'ma' | 'ugyfelek' | 'ugyek'

export function CrmPage({ rpc }: { extensionId: string; rpc: Rpc }) {
  const [nezet, setNezet] = useState<Nezet>('ma')
  const [nyitottAccount, setNyitottAccount] = useState<string | null>(null)
  return (
    <div className="crm-app">
      <div className="crm-appbar">
        <div className="crm-tabs" role="tablist" aria-label="CRM nézetek">
          <button type="button" className="crm-tab" role="tab"
                  aria-selected={nezet === 'ma'} onClick={() => setNezet('ma')}>Ma</button>
          <button type="button" className="crm-tab" role="tab"
                  aria-selected={nezet === 'ugyfelek'} onClick={() => setNezet('ugyfelek')}>Ügyfelek</button>
          <button type="button" className="crm-tab" role="tab"
                  aria-selected={nezet === 'ugyek'} onClick={() => setNezet('ugyek')}>Ügyek</button>
        </div>
      </div>
      <main className="crm-screen">
        {nezet === 'ma' && <MaNezet rpc={rpc} onOpen={(id) => { setNyitottAccount(id); setNezet('ugyfelek') }} />}
        {nezet === 'ugyfelek' && (nyitottAccount
          ? <UgyfelLap rpc={rpc} accountId={nyitottAccount} onBack={() => setNyitottAccount(null)} />
          : <UgyfelekNezet rpc={rpc} onOpen={setNyitottAccount} />)}
        {nezet === 'ugyek' && <UgyekNezet rpc={rpc} />}
      </main>
    </div>
  )
}

const extensionId = currentExtensionId()
if (extensionId) {
  const rpc = makeRpc(extensionId)
  hostOf().registerPage(
    'crm',
    (props: Record<string, unknown>) => <CrmPage extensionId={extensionId} rpc={rpc} {...props} />,
    { react: hostReact(), extensionId },
  )
}
