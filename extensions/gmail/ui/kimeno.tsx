import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'

import type { Board, KimenoSor, KonyvSor, LiveDraft, Rpc, Uzenet } from './api'
import { errorCode, errorText, readKiadas, readLiveDraft } from './api'
import { BIZONYTALAN_KOD, BIZONYTALAN_MONDAT, ajtoLabel, allapotLabel, cimEntrybol, cimekFejlecbol, formatDate, konyvonKivuliek } from './format'

/**
 * The outbound queue, and the only control in this whole system that sends a
 * letter.
 *
 * WHY THE RELEASE IS TWO STEPS AND NOT ONE. The row carries a copy of the body
 * as it stood when the draft was written. The draft itself lives in Gmail,
 * where the operator can edit it, and `releaseDraft` checks the confirmation
 * hash against a FRESH READ of that draft -- so a page that sent the row's
 * hash beside the row's body would refuse every draft its operator had
 * touched, and a page that sent the LIVE hash beside the ROW's body would send
 * bytes nobody had read. Neither is acceptable, so:
 *
 *   1. `Kiadás előkészítése` calls `liveDraft`, which reads the draft out of
 *      Gmail and answers with the body, the recipients and the fingerprint of
 *      what is actually there;
 *   2. that body and those recipients are what the panel below displays, in
 *      full and untruncated, with the difference from the row named when there
 *      is one;
 *   3. the operator ticks the box saying they read it, which is what enables
 *      the `Kiadás` button;
 *   4. the button sends `megerosites: eloHash` -- the hash of the bytes on the
 *      screen, computed by the server that read them.
 *
 * A ONE-CLICK SEND BESIDE A STALE PREVIEW WOULD DEFEAT THE WHOLE DESIGN. Every
 * layer under this page stops at a draft on purpose, because neither the
 * contract handle nor the MCP shim carries a caller identity the host
 * re-checks; the person pressing this button is what stands in for that. So
 * the button is deliberate by construction: it does not exist until the live
 * draft has been read and displayed, and it does not enable until the box is
 * ticked.
 *
 * THE PAGE DOES NOT COMPUTE THE HASH. `megerosites` is `eloHash` exactly as
 * `liveDraft` sent it. A sha256 in the browser would mean two implementations
 * of one fingerprint had to agree byte for byte, and the day they stopped
 * agreeing would show up as a silent `gmail_lap_elavult` on every release.
 *
 * THE FIFTH STATE HAS NO BUTTON. `bizonytalan` is a send that was asked for
 * and did not answer: neither sent nor failed, and terminal. This view gives
 * it its own group, its own sentence and no release control at all, because a
 * second send is worse than not knowing.
 *
 * EVERY FIELD HERE WAS WRITTEN BY SOMEBODY ELSE and every one of them is a
 * React text child inside a box that wraps. No url in a body becomes a link,
 * no subject reaches an attribute that is not `data-`, and the boxes are
 * height-capped and scroll, so a single unbroken 4000-character word cannot
 * push the buttons off the screen.
 */

/** One recipient chip: the entry as it stands, marked when the live book does not know its address. */
function Cimzett({ entry, konyv }: { entry: string; konyv: readonly KonyvSor[] }) {
  const kivul = konyvonKivuliek([cimEntrybol(entry)], konyv).length > 0
  return (
    <span className={kivul ? 'gm-cim gm-cim-kivul' : 'gm-cim'}>
      {entry}{kivul ? ' — nincs az élő könyvben' : ''}
    </span>
  )
}

/** A stored text field, in a box that wraps, scrolls and is labelled with who wrote it. */
function Szoveg({ label, text, tone = 'plain' }: { label: string; text: string; tone?: 'plain' | 'live' }) {
  return (
    <div className="gm-szoveg-blokk">
      <p className={tone === 'live' ? 'gm-szoveg-cimke gm-warn' : 'gm-szoveg-cimke gm-muted'}>{label}</p>
      <pre className={tone === 'live' ? 'gm-szoveg gm-szoveg-live' : 'gm-szoveg'}>{text}</pre>
    </div>
  )
}

/**
 * The panel that stands between the operator and the send.
 *
 * Everything on it comes from the live read: the recipients as Gmail has them,
 * the subject as Gmail has it, the body as Gmail has it, and the fingerprint
 * of those three. `szerkesztve` is the fact that they differ from the row, and
 * it is stated first, because a draft somebody edited in Gmail after an agent
 * wrote it is the case the whole confirmation exists for.
 */
export function KiadasPanel({ live, konyv, olvastam, onOlvastam, onKiad, onMegsem, dolgozik }: {
  live: LiveDraft
  konyv: readonly KonyvSor[]
  olvastam: boolean
  onOlvastam: (value: boolean) => void
  onKiad: () => void
  onMegsem: () => void
  dolgozik: boolean
}) {
  const entryk = cimekFejlecbol(live.cimek)
  const kivul = konyvonKivuliek(entryk.map(cimEntrybol), konyv)
  return (
    <div className="gm-kiadas-panel" data-kimeno-id={live.kimenoId}>
      <h4>Ez fog kimenni</h4>
      <p className="gm-line gm-muted">
        A lenti szöveg és címzettlista most lett kiolvasva a Gmailből, nem a tárolt sorból. A kiadás ennek a szövegnek az ujjlenyomatát küldi vissza megerősítésként, és a szerver ugyanezt olvassa el újra, mielőtt küld.
      </p>
      {live.szerkesztve
        ? (
          <p className="gm-line gm-warn">
            Ez a piszkozat a Gmailben megváltozott, mióta ez a sor készült. Amit lent olvasol, az a mostani állapot; a sor a kiadáskor frissül rá.
          </p>
        )
        : <p className="gm-line gm-muted">A Gmailben álló piszkozat megegyezik a tárolt sorral.</p>}

      <p className="gm-line">
        Címzettek ({entryk.length}):{' '}
        {entryk.length === 0
          ? <span className="gm-warn">a Gmailben álló piszkozatnak nincs olvasható címzettje</span>
          : entryk.map((entry, i) => <Cimzett key={`${entry}-${i}`} entry={entry} konyv={konyv} />)}
      </p>
      {kivul.length > 0 && (
        <p className="gm-line gm-warn">
          {kivul.length} címzett nincs benne az élő címzettkönyvben. Ez nem tiltás: lehet, hogy te írtad be a saját levelezőprogramodban. Ezt a modul nem tudja eldönteni, ezért rád tartozik.
        </p>
      )}

      <p className="gm-line">Tárgy: {live.targy === '' ? '(nincs tárgy)' : live.targy}</p>
      <Szoveg label="A Gmailben álló törzs — ez megy ki, teljes egészében:" text={live.torzs} tone="live" />
      <p className="gm-line gm-mono">megerősítés: {live.eloHash}</p>

      <label className="gm-checkbox">
        <input type="checkbox" checked={olvastam} onChange={(e) => onOlvastam(e.target.checked)} />
        {' '}Elolvastam a fenti törzset és a címzettlistát, és ezt akarom kiküldeni.
      </label>
      <div className="gm-actions">
        <button type="button" className="gm-btn gm-kiadas" disabled={dolgozik || !olvastam} onClick={onKiad}>Kiadás</button>
        <button type="button" className="gm-btn gm-btn-small" disabled={dolgozik} onClick={onMegsem}>Mégsem</button>
        {!olvastam && <span className="gm-muted">a Kiadás addig ki van kapcsolva, amíg a jelölőnégyzet üres</span>}
      </div>
    </div>
  )
}

/**
 * One draft row: who it goes to, what it says, and the two controls.
 *
 * The body is shown WHOLE and never truncated -- what the operator is going to
 * send is what they have to be able to read -- and it is labelled as the
 * stored copy, because the bytes that actually go out are read fresh by the
 * panel above.
 */
export function PiszkozatKartya({ sor, konyv, dolgozik, elokeszitve, onElokeszit, onElvet, children }: {
  sor: KimenoSor
  konyv: readonly KonyvSor[]
  dolgozik: boolean
  elokeszitve: boolean
  onElokeszit: (id: string) => void
  onElvet: (id: string) => void
  children?: ReactNode
}) {
  const kivul = konyvonKivuliek(sor.cimzettCimek, konyv)
  return (
    <div className="gm-sor gm-sor-piszkozat" data-kimeno-id={sor.id}>
      <div className="gm-sor-fej">
        <span className="gm-badge">Piszkozat</span>
        <span className="gm-mono">{sor.id}</span>
        <span className="gm-muted">{formatDate(sor.createdAt)}</span>
        <span className="gm-muted">{ajtoLabel(sor.ajto)}</span>
      </div>

      <p className="gm-line">
        Címzettek:{' '}
        {sor.cimzettHandlek.length === 0 && sor.cimzettCimek.length === 0
          ? <span className="gm-warn">a soron nincs címzett</span>
          : sor.cimzettCimek.map((cim, i) => (
            <span key={`${cim}-${i}`} className={kivul.includes(cim) ? 'gm-cim gm-cim-kivul' : 'gm-cim'}>
              {sor.cimzettHandlek[i] === undefined ? cim : `${sor.cimzettHandlek[i]} — ${cim}`}
              {kivul.includes(cim) ? ' — nincs az élő könyvben' : ''}
            </span>
          ))}
      </p>
      {sor.valaszUzenetId !== '' && (
        <p className="gm-line gm-muted">Válasz erre az üzenetre: <span className="gm-mono">{sor.valaszUzenetId}</span></p>
      )}
      {sor.szerkesztveAt !== '' && (
        <p className="gm-line gm-warn">Szerkesztve a Gmailben: {formatDate(sor.szerkesztveAt)}</p>
      )}

      <p className="gm-line">Tárgy: {sor.targy === '' ? '(nincs tárgy)' : sor.targy}</p>
      <Szoveg label="A tárolt törzs, ahogy a piszkozat készült. A kiadás előtt a Gmailben álló szöveget olvassuk ki újra:" text={sor.torzs} />

      <div className="gm-actions">
        <button type="button" className="gm-btn" disabled={dolgozik || elokeszitve} onClick={() => onElokeszit(sor.id)}>Kiadás előkészítése</button>
        <button type="button" className="gm-btn gm-elvetes" disabled={dolgozik} onClick={() => onElvet(sor.id)}>Elvetés</button>
      </div>
      {children}
    </div>
  )
}

/**
 * One closed row.
 *
 * FOUR ENDINGS, FOUR SENTENCES, AND NO BUTTON ON ANY OF THEM. `kiadva` names
 * the sent message; `elvetve` says the Gmail draft was deleted; `hiba` carries
 * the code the module refused with; `bizonytalan` gets the paragraph the whole
 * fifth state exists for. A state this page has no word for is printed as the
 * raw value and flagged, rather than being drawn as one of the four.
 */
export function LezartSor({ sor }: { sor: KimenoSor }) {
  const allapot = allapotLabel(sor.allapot)
  const bizonytalan = sor.allapot === 'bizonytalan'
  return (
    <div className={bizonytalan ? 'gm-sor gm-sor-bizonytalan' : 'gm-sor'} data-kimeno-id={sor.id}>
      <div className="gm-sor-fej">
        <span className={bizonytalan ? 'gm-badge gm-badge-bad' : 'gm-badge'}>{allapot.label}</span>
        {!allapot.known && <span className="gm-warn">ezt az állapotot ez a lap nem ismeri</span>}
        <span className="gm-mono">{sor.id}</span>
        <span className="gm-muted">{formatDate(sor.kiadvaAt === '' ? sor.updatedAt : sor.kiadvaAt)}</span>
        <span className="gm-muted">{ajtoLabel(sor.ajto)}</span>
      </div>

      <p className="gm-line">Tárgy: {sor.targy === '' ? '(nincs tárgy)' : sor.targy}</p>
      <p className="gm-line">
        Címzettek:{' '}
        {sor.cimzettCimek.length === 0
          ? <span className="gm-muted">nincs a soron</span>
          : sor.cimzettCimek.map((cim, i) => <span key={`${cim}-${i}`} className="gm-cim">{cim}</span>)}
      </p>
      {sor.konyvonKivul.length > 0 && (
        <p className="gm-line gm-warn">A kiadáskor {sor.konyvonKivul.length} címzett nem volt az élő könyvben: {sor.konyvonKivul.join(', ')}</p>
      )}
      {sor.allapot === 'kiadva' && (
        <p className="gm-line">Elküldött üzenet azonosítója: <span className="gm-mono">{sor.gmailMessageId === '' ? '(a sor nem tárol üzenet-azonosítót)' : sor.gmailMessageId}</span></p>
      )}
      {bizonytalan && <p className="gm-line gm-bad">{BIZONYTALAN_MONDAT}</p>}
      {sor.hibaKod !== '' && (
        <p className="gm-line gm-muted">A rögzített ok kódja: <span className="gm-mono">{sor.hibaKod}</span>{sor.hibaSzoveg === '' ? '' : ` — ${sor.hibaSzoveg}`}</p>
      )}
      {bizonytalan && sor.hibaKod === '' && (
        <p className="gm-line gm-muted">A soron nincs ok-kód: a folyamat a küldés közben állt le, mielőtt bármit vissza tudott volna írni.</p>
      )}
    </div>
  )
}

const PISZKOZAT = 'piszkozat'
const BIZONYTALAN = 'bizonytalan'

/**
 * `onUzenet` rather than local state, and the reason is a defect a browser
 * pass found rather than a preference: this component is keyed on the board's
 * load counter, so the refresh that follows a successful release remounts it
 * and destroys anything it was holding. The sentence saying a letter went out
 * has to outlive that remount, so it is the page's state and this view only
 * writes it.
 */
export function KimenoNezet({ board, rpc, onChanged, onUzenet }: {
  board: Board
  rpc: Rpc
  onChanged: () => void
  onUzenet: (uzenet: Uzenet | null) => void
}) {
  const [nyitott, setNyitott] = useState<string | null>(null)
  const [live, setLive] = useState<LiveDraft | null>(null)
  const [liveHiba, setLiveHiba] = useState<string | null>(null)
  const [olvastam, setOlvastam] = useState(false)
  const [dolgozik, setDolgozik] = useState(false)

  /** Closes the panel. Called after every release attempt: a hash that has been used, or refused, must not stay on screen next to a live button. */
  const zar = useCallback(() => {
    setNyitott(null)
    setLive(null)
    setLiveHiba(null)
    setOlvastam(false)
  }, [])

  const elokeszit = useCallback((kimenoId: string) => {
    setNyitott(kimenoId)
    setLive(null)
    setLiveHiba(null)
    setOlvastam(false)
    onUzenet(null)
    setDolgozik(true)
    rpc('liveDraft', { kimenoId })
      .then((raw) => { setLive(readLiveDraft(raw)) })
      .catch((err: unknown) => setLiveHiba(errorText(err)))
      .finally(() => setDolgozik(false))
  }, [rpc, onUzenet])

  const kiad = useCallback((kimenoId: string, megerosites: string) => {
    setDolgozik(true)
    rpc('releaseDraft', { kimenoId, megerosites })
      .then((raw) => {
        const eredmeny = readKiadas(raw)
        const kivul = eredmeny.konyvonKivul.length === 0 ? '' : ` A könyvön kívüli címzettek: ${eredmeny.konyvonKivul.join(', ')}.`
        onUzenet({
          kind: eredmeny.konyvonKivul.length === 0 ? 'plain' : 'warn',
          text: `Kiment. Üzenet-azonosító: ${eredmeny.gmailMessageId}, időpont: ${formatDate(eredmeny.kiadvaAt)}.${eredmeny.szerkesztve ? ' A sor frissült a Gmailben álló szövegre.' : ''}${kivul}`,
        })
      })
      .catch((err: unknown) => {
        const kod = errorCode(err)
        if (kod === BIZONYTALAN_KOD) onUzenet({ kind: 'bad', text: `${BIZONYTALAN_MONDAT} A modul által rögzített ok: ${errorText(err)}` })
        else if (kod === 'gmail_lap_elavult') onUzenet({ kind: 'warn', text: `A kiadás nem történt meg: ${errorText(err)}. A piszkozat a Gmailben azóta megváltozott, ezért olvasd ki újra az Előkészítéssel, és nézd meg, mi lett belőle.` })
        else onUzenet({ kind: 'bad', text: `A kiadás nem történt meg: ${errorText(err)}` })
      })
      .finally(() => {
        setDolgozik(false)
        // The panel closes on every outcome, success and refusal alike. A
        // confirmation that has been spent, or one the server has just told us
        // no longer holds, must not stay next to a button that would send it
        // again.
        zar()
        onChanged()
      })
  }, [rpc, onChanged, zar, onUzenet])

  const elvet = useCallback((kimenoId: string) => {
    if (!window.confirm('Törlöm a Gmailben álló piszkozatot, és lezárom ezt a sort. Ez nem vonható vissza. Folytassam?')) return
    setDolgozik(true)
    onUzenet(null)
    rpc('discardDraft', { kimenoId })
      .then(() => { onUzenet({ kind: 'plain', text: 'A piszkozat törölve a Gmailből, a sor elvetve.' }) })
      .catch((err: unknown) => onUzenet({ kind: 'bad', text: `Az elvetés nem sikerült: ${errorText(err)}` }))
      .finally(() => { setDolgozik(false); zar(); onChanged() })
  }, [rpc, onChanged, zar, onUzenet])

  const items = board.kimeno.items
  const piszkozatok = items.filter((sor) => sor.allapot === PISZKOZAT)
  const bizonytalanok = items.filter((sor) => sor.allapot === BIZONYTALAN)
  const lezartak = items.filter((sor) => sor.allapot !== PISZKOZAT && sor.allapot !== BIZONYTALAN)

  return (
    <div className="gm-kimeno">
      {board.kimeno.total > board.kimeno.count && (
        <p className="gm-line gm-muted">
          {board.kimeno.count} sor látszik a {board.kimeno.total}-ból; a lap egyszerre {board.kimenoLimit} sort kér le.
        </p>
      )}

      <h3>Piszkozatok</h3>
      {piszkozatok.length === 0
        ? <p className="gm-muted">Nincs nyitott piszkozat. Ez a lap az egyetlen hely, ahonnan levél kimehet, tehát amíg itt nincs sor, ez a modul nem küld semmit.</p>
        : piszkozatok.map((sor) => (
          <PiszkozatKartya
            key={sor.id}
            sor={sor}
            konyv={board.konyv}
            dolgozik={dolgozik}
            elokeszitve={nyitott === sor.id}
            onElokeszit={elokeszit}
            onElvet={elvet}
          >
            {nyitott === sor.id && liveHiba !== null && (
              <p className="gm-line gm-bad" role="alert">A Gmailben álló piszkozatot nem sikerült kiolvasni, ezért nincs mit kiadni: {liveHiba}</p>
            )}
            {nyitott === sor.id && live === null && liveHiba === null && (
              <p className="gm-line gm-muted">A Gmailben álló piszkozat kiolvasása folyamatban.</p>
            )}
            {nyitott === sor.id && live !== null && (
              <KiadasPanel
                live={live}
                konyv={board.konyv}
                olvastam={olvastam}
                onOlvastam={setOlvastam}
                onKiad={() => kiad(live.kimenoId, live.eloHash)}
                onMegsem={zar}
                dolgozik={dolgozik}
              />
            )}
          </PiszkozatKartya>
        ))}

      <h3>Bizonytalan</h3>
      {bizonytalanok.length === 0
        ? <p className="gm-muted">Nincs bizonytalan sor: minden küldésre jött válasz.</p>
        : (
          <>
            <p className="gm-line gm-bad">{BIZONYTALAN_MONDAT}</p>
            {bizonytalanok.map((sor) => <LezartSor key={sor.id} sor={sor} />)}
          </>
        )}

      <h3>Lezárt sorok</h3>
      {lezartak.length === 0
        ? <p className="gm-muted">Nincs lezárt sor.</p>
        : lezartak.map((sor) => <LezartSor key={sor.id} sor={sor} />)}
    </div>
  )
}
