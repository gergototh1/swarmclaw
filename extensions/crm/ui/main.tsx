import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { makeRpc, type Rpc } from './api'
import { currentExtensionId, hostOf, hostReact } from './host'
import { MaNezet } from './ma'
import { UgyekNezet } from './ugyek'
import { UgyfelLap } from './ugyfel-lap'
import { UgyfelekNezet } from './ugyfelek'
import { alapHely, helyAzUtbol, utAHelybol, type CrmHely, type Nezet } from './utvonal'

/**
 * A fülsáv nézetei, megjelenési sorrendben.
 *
 * Egy tömb, nem három kézzel írt gomb: a `role="tab"` teljes mintájához a
 * fülnek ISMERNIE kell a sorrendben előtte és utána állót (nyíl-navigáció),
 * és a fókuszálható fül indexét (roving `tabindex`) -- ezt három, egymásról
 * mit sem tudó JSX-elemmel nem lehet megadni, csak megismételni.
 */
const NEZETEK: readonly { id: Nezet; cimke: string }[] = Object.freeze([
  { id: 'ma', cimke: 'Ma' },
  { id: 'ugyfelek', cimke: 'Ügyfelek' },
  { id: 'ugyek', cimke: 'Ügyek' },
])

/**
 * A panel azonosítója. EGY panel van, mert a `main` egyszerre pontosan egy
 * nézetet rendereli -- ezért mindhárom fül ugyanerre az (állandóan létező)
 * azonosítóra mutat az `aria-controls`-szal, és a panel `aria-labelledby`-ja
 * fordul rá az ÉPPEN kiválasztott fülre. Fülönkénti panel-azonosító itt
 * lógó hivatkozás lenne: a másik két panel nincs a dokumentumban.
 */
const PANEL_ID = 'crm-panel'
const fulId = (nezet: Nezet) => `crm-tab-${nezet}`

/**
 * Amit a host ad a lapnak. A `subPath`, `navigate` és `setTitle` újabb hostnál
 * érkezik; régebbi alatt hiányzik, és a lap helyi állapotból dolgozik tovább.
 */
type OldalProps = {
  extensionId: string
  rpc: Rpc
  subPath?: string
  navigate?: (subPath: string, opts?: { replace?: boolean }) => void
  setTitle?: (text: string | null) => void
}

export function CrmPage({ rpc, subPath, navigate, setTitle }: OldalProps) {
  const [helyiUt, setHelyiUt] = useState('')
  const hely = helyAzUtbol(subPath ?? helyiUt)
  const nezet = hely.nezet
  const nyitottAccount = hely.nezet === 'ugyfelek' ? hely.accountId : null
  const menj = (uj: CrmHely) => {
    const ut = utAHelybol(uj)
    if (navigate) navigate(ut)
    else setHelyiUt(ut)
  }

  // Ügyféllap nélkül a cím a sima CRM; a lapon a betöltött név adja (lásd lent).
  useEffect(() => { if (!nyitottAccount) setTitle?.(null) }, [nyitottAccount, setTitle])

  const fulsav = useRef<HTMLDivElement | null>(null)

  /**
   * Bal/jobb nyíl: a `role="tab"` minta kötelező része. A `role="tab"`
   * ígéretet tesz a képernyőolvasónak (fül-widget), és egy fül-widget, ami
   * nyílra nem mozdul, pontosan azt az ígéretet szegi meg. Körbeér, mert a
   * fülsáv vízszintes és zárt halmaz; a fókuszt is visszük, nem csak a
   * kiválasztást (automatic activation -- a nézetváltás itt olcsó).
   */
  const nyilra = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lepes = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (lepes === 0) return
    e.preventDefault()
    const cel = (index + lepes + NEZETEK.length) % NEZETEK.length
    menj(alapHely(NEZETEK[cel].id))
    fulsav.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[cel]?.focus()
  }

  return (
    <div className="crm-app">
      <div className="crm-appbar">
        <div className="crm-tabs" role="tablist" aria-label="CRM nézetek" ref={fulsav}>
          {NEZETEK.map((f, i) => (
            <button key={f.id} type="button" className="crm-tab" role="tab"
                    id={fulId(f.id)} aria-controls={PANEL_ID}
                    aria-selected={nezet === f.id} tabIndex={nezet === f.id ? 0 : -1}
                    onKeyDown={(e) => nyilra(e, i)}
                    onClick={() => menj(alapHely(f.id))}>{f.cimke}</button>
          ))}
        </div>
      </div>
      <main className="crm-screen" role="tabpanel" id={PANEL_ID} aria-labelledby={fulId(nezet)}>
        {nezet === 'ma' && <MaNezet rpc={rpc} onOpen={(id) => menj({ nezet: 'ugyfelek', accountId: id })} />}
        {nezet === 'ugyfelek' && (nyitottAccount
          ? <UgyfelLap
              key={nyitottAccount}
              rpc={rpc}
              accountId={nyitottAccount}
              onBack={() => menj({ nezet: 'ugyfelek', accountId: null })}
              onBetoltve={(nev) => setTitle?.(`CRM · ${nev}`)}
            />
          : <UgyfelekNezet rpc={rpc} onOpen={(id) => menj({ nezet: 'ugyfelek', accountId: id })} />)}
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
