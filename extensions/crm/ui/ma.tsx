import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Unmatched = { id: string; sender_address: string; subject: string; guess_account_id: string | null }
type Suggestion = { id: string; text: string; reason: string }
type Account = { id: string; name: string }
type Kapcsolat = { id: string; name: string; accountId: string | null; accountName: string }
type PostafiokAllapot = { available: boolean; reason?: string; address?: string; message?: string }

/**
 * A besorolatlan sor kapcsolat-választójának listája.
 *
 * A találgatás (`guessAccountId`) alapból szűkít -- ez a sweep egy kattintással
 * megspórolt találata --, de sosem dönt. Két eset nem eshet ki a listából:
 *
 * 1. A találgatás téves: a helyes kapcsolat másik ügyfélhez tartozik. Erre
 *    való a `mindet` jelölőnégyzet, ami soronként feloldja a szűkítést.
 * 2. A helyes kapcsolat még nincs ügyfélhez kötve (`accountId: null`) -- ez a
 *    leggyakoribb ok, amiért a levél egyáltalán a besorolatlan sorba került,
 *    ezért a kötetlen kapcsolatok a találgatással szűkített listában is
 *    mindig ott vannak.
 */
export function valaszthatoKapcsolatok(
  kapcsolatok: Kapcsolat[],
  guessAccountId: string | null,
  mindet: boolean,
): Kapcsolat[] {
  if (!guessAccountId || mindet) return kapcsolatok
  return kapcsolatok.filter((c) => c.accountId === guessAccountId || c.accountId === null)
}

/**
 * Igaz, ha a kiválasztott kapcsolat-id ténylegesen szerepel a JELENLEG
 * LÁTHATÓ listában.
 *
 * A "Összes kapcsolat" jelölőnégyzet ki/be kapcsolása szűkíti vagy bővíti a
 * választható listát (`valaszthatoKapcsolatok`), de nem törli a `valasztott`
 * state-et -- az egy külön, soronkénti state, amit a checkbox onChange-e nem
 * érint. Enélkül a guard nélkül egy korábban kiválasztott, majd a szűkítés
 * után eltűnő kapcsolat id-je a state-ben marad, a `<select>` a placeholderre
 * esik vissza (mert a value egyik látható option-nal sem egyezik), az
 * operátor üres választót lát -- és a "Hozzárendel" gomb mégis a régi,
 * láthatatlan id-re küldené a hívást. A guard-ot ide, a listaszűrő mellé
 * tettük, nem a komponensbe: mindkét hívó (a gomb enabled állapota és maga a
 * hozzárendelés) innen olvassa, tehát a kettő nem térhet el egymástól.
 */
export function kivalasztasLathato(kivalasztottId: string, lathatoLista: Kapcsolat[]): boolean {
  return kivalasztottId !== '' && lathatoLista.some((c) => c.id === kivalasztottId)
}

/**
 * A négy szerződés-szintű ok (`src/rpc.mjs` `mailboxHealth`), plusz a CRM
 * saját `crm_nincs_contracts` oka -- mindegyikhez más teendő tartozik, ezért
 * egyik sem olvad össze eggyel sem itt. `crm_postafiok_hiba` NINCS ebben a
 * táblában: annak a szövegét `postafiokHibaTeendo` állítja össze a hívás
 * `message` mezőjéből, mert az az egy ok maga nem mond semmit -- lásd ott.
 */
const POSTAFIOK_OK_HU: Readonly<Record<string, string>> = Object.freeze({
  not_declared: 'A telepített CRM nem kéri a postafiók szerződést -- telepítsd újra a CRM extensiont.',
  provider_missing: 'A Gmail extension nincs telepítve -- enélkül a levelek behúzása nem indulhat.',
  provider_disabled: 'A Gmail extension telepítve van, de ki van kapcsolva -- kapcsold be az Extensions lapon.',
  version_mismatch: 'A Gmail extension másik szerződés-verziót ad, mint amire a CRM épült -- az egyiket frissíteni kell.',
  crm_nincs_contracts: 'A hoszt ennek a telepítésnek nem ad szerződés-hozzáférést -- ez rendszerhiba, forduljon az üzemeltetőhöz.',
})

/**
 * A `gmail` extension saját, hitelesítő hiányára/lejártára utaló kódjai --
 * ezek a `mailbox()` hívás dobott hibájának ÜZENETÉBEN a puszta kód szövege
 * (nem mondat), mert `extensions/gmail/src/client.mjs` a `TOKEN_CODES`
 * halmazba eső üzenetet változatlanul továbbadja: `gmail_token_missing`
 * (nincs csatlakoztatva fiók), `gmail_token_unreadable` (a tárolt hitelesítő
 * nem olvasható), `gmail_token_revoked` (a jogosultság visszavonva vagy
 * lejárt), `gmail_refresh_failed` (a frissítés meg nem nevezett okból
 * hiúsult meg -- a gmail modul erre is az újracsatlakozást ajánlja, lásd
 * `client.mjs` idézett megjegyzése). Mind a négyhez ugyanaz a teendő tartozik:
 * a fiókot a Gmail extension saját lapján kell újra összekötni.
 */
const GMAIL_HITELESITO_UZENETEK: ReadonlySet<string> = new Set([
  'gmail_token_missing', 'gmail_token_unreadable', 'gmail_token_revoked', 'gmail_refresh_failed',
])

/**
 * A `crm_postafiok_hiba` teendője a hívás `message` mezőjéből.
 *
 * A `message` IDEGEN SZÖVEG -- a `gmail` extension dobja, a CRM nem
 * ellenőrzi a tartalmát --, ezért ez a függvény kizárólag ADATKÉNT olvassa
 * (mintaillesztés stringen), sosem jelenít meg markupként vagy épít belőle
 * más kódba interpolált szöveget.
 *
 * Két esetet tudunk biztosan megkülönböztetni:
 *
 * 1. A hoszton nincs Google OAuth kliens beállítva. Ekkor `client.mjs` a
 *    host saját `GoogleOAuthNotConfiguredError`-jának mondatát adja tovább
 *    (`"Google OAuth is not configured, ..."`, lásd
 *    `src/lib/server/oauth/google.ts`) a `google_oauth_client_missing` kód
 *    mögött -- ezt a mondatot a hoszt saját tesztje is `/not configured/i`
 *    mintával azonosítja, ezért ez itt is stabil jel. A teendő ilyenkor NEM
 *    kattintható: két környezeti változó és egy újraindítás.
 * 2. Hiányzó vagy lejárt Gmail-hitelesítő (`GMAIL_HITELESITO_UZENETEK`) --
 *    ilyenkor a teendő a fiók újra-összekötése a Gmail extension saját
 *    lapján.
 *
 * Minden más esetben -- ismeretlen `message`, vagy egyáltalán nincs -- a
 * függvény ezt őszintén bevallja, és a nyers üzenetet mutatja a kitalált
 * diagnózis helyett.
 */
function postafiokHibaTeendo(message: string): string {
  if (/google_oauth_client_missing/.test(message) || /not configured/i.test(message)) {
    return (
      'A hoszton nincs beállítva Google OAuth kliens -- ezt az operátor a felületen nem tudja megoldani. ' +
      'Üzemeltetői teendő: állítsd be a módhoz tartozó két környezeti változót (asztali app esetén ' +
      'GOOGLE_OAUTH_CLIENT_DESKTOP_ID és GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET; szerveren ' +
      'GOOGLE_OAUTH_CLIENT_WEB_ID és GOOGLE_OAUTH_CLIENT_WEB_SECRET), majd indítsd újra a hosztot.'
    )
  }
  if (GMAIL_HITELESITO_UZENETEK.has(message)) {
    return 'Hiányzik vagy lejárt a Gmail-hitelesítő -- kösd össze újra a fiókot a Gmail extension saját lapján.'
  }
  return message
    ? `A postafiók-lekérdezés elhasalt, az ok innen nem állapítható meg biztosan. A hívás üzenete: „${message}".`
    : 'A postafiók-lekérdezés elhasalt, de a hívás nem adott üzenetet -- az ok innen nem állapítható meg.'
}

/**
 * A postafiók-állapot egyetlen sora. Elérhető szerződés esetén halk (a cím,
 * ha van), egyébként a névre szóló ok és a hozzá tartozó teendő -- soha nem
 * egy összemosott "nem működik" mondat, mert az öt ok mindegyikéhez más
 * lépés tartozik az operátornak.
 */
function postafiokUzenet(p: PostafiokAllapot): string {
  if (p.available) return p.address ? `Postafiók elérhető: ${p.address}` : 'Postafiók elérhető.'
  const reason = p.reason ?? ''
  if (reason === 'crm_postafiok_hiba') return postafiokHibaTeendo(p.message ?? '')
  return POSTAFIOK_OK_HU[reason] ?? `A levelek behúzása áll: ismeretlen ok (${reason || 'nincs megadva'}).`
}

export function MaNezet({ rpc, onOpen }: { rpc: Rpc; onOpen: (id: string) => void }) {
  const [unmatched, setUnmatched] = useState<Unmatched[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [kapcsolatok, setKapcsolatok] = useState<Kapcsolat[]>([])
  const [valasztott, setValasztott] = useState<Record<string, string>>({})
  const [mindet, setMindet] = useState<Record<string, boolean>>({})
  const [hiba, setHiba] = useState('')
  const [sopres, setSopres] = useState<string>('')
  const [fut, setFut] = useState(false)
  const [postafiok, setPostafiok] = useState<PostafiokAllapot | null>(null)
  const [csakTanult, setCsakTanult] = useState('')

  const tolt = () => {
    rpc('board')
      .then((b) => {
        const board = b as { unmatched: Unmatched[]; suggestions: Suggestion[]; accounts: Account[] }
        setUnmatched(board.unmatched)
        setSuggestions(board.suggestions)
        setAccounts(board.accounts)
      })
      .catch((e: Error) => setHiba(e.message))
    rpc('contactsForPicker')
      .then((c) => setKapcsolatok(c as Kapcsolat[]))
      .catch((e: Error) => setHiba(e.message))
    // A postafiók-állapot külön hívás, saját state-tel: egy hiba itt (a
    // metódus maga sosem dob, mindig névvel tér vissza -- lásd `src/rpc.mjs`
    // `mailboxHealth` -- de a hálózat vagy egy elavult host még mindig
    // eldobhatja a promise-t) nem futtathatja a `hiba` sávot, és nem
    // állíthatja meg a lap többi részének betöltését.
    rpc('mailboxHealth')
      .then((h) => setPostafiok(h as PostafiokAllapot))
      .catch(() => setPostafiok(null))
  }
  useEffect(tolt, [rpc])

  const hozzarendel = (u: Unmatched, lathatoLista: Kapcsolat[]) => {
    const contactId = valasztott[u.id]
    if (!kivalasztasLathato(contactId, lathatoLista)) return
    setCsakTanult('')
    rpc('assignUnmatched', { unmatchedId: u.id, contactId })
      .then((r) => {
        const eredmeny = r as { eventFiled: boolean }
        if (!eredmeny.eventFiled) {
          setCsakTanult(
            `${u.sender_address}: a cím megtanulva, a sor lezárva -- de a kiválasztott kapcsolatnak ` +
            'még nincs ügyfele, ezért a levél egyetlen idővonalra sem került fel.',
          )
        }
        tolt()
      })
      .catch((e: Error) => setHiba(e.message))
  }

  const elvet = (suggestionId: string) => {
    rpc('setSuggestionStatus', { suggestionId, status: 'dismissed' })
      .then(tolt).catch((e: Error) => setHiba(e.message))
  }

  const soper = () => {
    setFut(true)
    rpc('sweepNow', { max: 50 })
      .then((r) => {
        const x = r as { scanned: number; recorded: number; unmatched: number; failed: number }
        const hibaResz = x.failed > 0 ? ` · ${x.failed} hibás (kihagyva)` : ''
        setSopres(`${x.scanned} levél átnézve · ${x.recorded} idővonalra · ${x.unmatched} besorolatlan${hibaResz}`)
        tolt()
      })
      .catch((e: Error) => setHiba(e.message))
      .finally(() => setFut(false))
  }

  return (
    <section>
      <h2>Ma</h2>
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      <div className="crm-sor">
        <button onClick={soper} disabled={fut}>{fut ? 'Söprés fut…' : 'Levelek behúzása'}</button>
        {sopres && <span className="crm-halvany">{sopres}</span>}
      </div>
      {postafiok && (
        postafiok.available
          ? <p className="crm-halvany">{postafiokUzenet(postafiok)}</p>
          : <p className="crm-hiba" role="status">{postafiokUzenet(postafiok)}</p>
      )}
      {csakTanult && <p className="crm-halvany" role="status">{csakTanult}</p>}

      <h3>Figyelmet igényel</h3>
      {/* A figyelem-lista a CRM-3-ban érkezik. Addig a javaslat-sor áll itt,
          hogy a felület alakja már most a helyén legyen. */}
      {suggestions.length === 0
        ? <p className="crm-halvany">Most nincs javaslat.</p>
        : (
          <ul className="crm-lista">
            {suggestions.map((s) => (
              <li key={s.id}>
                {s.text}
                {s.reason && <span className="crm-halvany"> — {s.reason}</span>}
                <button onClick={() => elvet(s.id)}>Elvet</button>
              </li>
            ))}
          </ul>
        )}

      <h3>Besorolatlan ({unmatched.length})</h3>
      {unmatched.length === 0
        ? <p className="crm-halvany">Nincs besorolatlan levél.</p>
        : (
          <ul className="crm-lista">
            {unmatched.map((u) => {
              const lathatoLista = valaszthatoKapcsolatok(kapcsolatok, u.guess_account_id, !!mindet[u.id])
              const kivalasztott = valasztott[u.id] || ''
              return (
                <li key={u.id}>
                  <strong>{u.sender_address}</strong> {u.subject}
                  {u.guess_account_id && (
                    <span className="crm-halvany">
                      valószínűleg {accounts.find((a) => a.id === u.guess_account_id)?.name}
                    </span>
                  )}
                  <button disabled={!u.guess_account_id} onClick={() => u.guess_account_id && onOpen(u.guess_account_id)}>Megnyit</button>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!mindet[u.id]}
                      aria-label={`${u.sender_address}: összes kapcsolat, találgatás nélkül`}
                      onChange={(e) => setMindet({ ...mindet, [u.id]: e.target.checked })}
                    />
                    Összes kapcsolat
                  </label>
                  <select value={kivalasztott} aria-label={`${u.sender_address} hozzárendelése`}
                          onChange={(e) => setValasztott({ ...valasztott, [u.id]: e.target.value })}>
                    <option value="">Válassz kapcsolatot…</option>
                    {lathatoLista.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.accountName && ` — ${c.accountName}`}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => hozzarendel(u, lathatoLista)} disabled={!kivalasztasLathato(kivalasztott, lathatoLista)}>Hozzárendel</button>
                </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}
