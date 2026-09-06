import { useState } from 'react'

import { currentExtensionId, hostOf, hostReact } from './host'

type Nezet = 'ma' | 'ugyfelek' | 'ugyek'

export function CrmPage() {
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
  hostOf().registerPage(
    'crm',
    () => <CrmPage />,
    { react: hostReact(), extensionId },
  )
}
