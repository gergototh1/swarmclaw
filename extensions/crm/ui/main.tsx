import { useState } from 'react'

import { makeRpc, type Rpc } from './api'
import { currentExtensionId, hostOf, hostReact } from './host'

type Nezet = 'ma' | 'ugyfelek' | 'ugyek'

export function CrmPage({ rpc }: { extensionId: string; rpc: Rpc }) {
  const [nezet, setNezet] = useState<Nezet>('ma')
  return (
    <div className="crm">
      <nav className="crm-nav">
        <button onClick={() => setNezet('ma')} aria-pressed={nezet === 'ma'}>Ma</button>
        <button onClick={() => setNezet('ugyfelek')} aria-pressed={nezet === 'ugyfelek'}>Ügyfelek</button>
        <button onClick={() => setNezet('ugyek')} aria-pressed={nezet === 'ugyek'}>Ügyek</button>
      </nav>
      <main className="crm-fo">
        {nezet === 'ma' && <p>Ma — a figyelem-lista a CRM-3-ban érkezik.</p>}
        {nezet === 'ugyfelek' && <p>Ügyfelek</p>}
        {nezet === 'ugyek' && <p>Ügyek</p>}
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
