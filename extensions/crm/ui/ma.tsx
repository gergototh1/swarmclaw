import { useEffect, useState } from 'react'

import type { Rpc } from './api'

type Unmatched = { id: string; sender_address: string; subject: string; guess_account_id: string | null }
type Suggestion = { id: string; text: string; reason: string }
type Account = { id: string; name: string }
/**
 * Egy sor a figyelem-listáról (`rpc.mjs` `attention` -> `src/attention.mjs`
 * `rangsor`). A négy azonosító-mező közül soronként más van kitöltve --
 * `accountId` az egyetlen, ami MINDIG megvan, és ezért az egyetlen, amin a
 * lap a továbblépést kínálja.
 */
type FigyelemSor = {
  kind: string
  accountId: string
  dealId?: string | null
  eventId?: string | null
  commitmentId?: string | null
  kor: number
  cim: string
  indok: string
}
type FigyelemValasz = { sorok: FigyelemSor[]; osszes: number }
type Kapcsolat = { id: string; name: string; accountId: string | null; accountName: string }
type PostafiokAllapot = { available: boolean; reason?: string; address?: string; message?: string }

/**
 * A figyelem-lista négy trigger-típusa magyarul. A kulcsok a
 * `src/attention.mjs` `SULY` táblájának kulcsai -- ha ott új típus születik,
 * ez a tábla hiányos lesz, és `figyelemKindNev` a nyers kulcsot adja vissza
 * ahelyett, hogy a sort elrejtené vagy egy hamis címkét ragasztana rá.
 */
export const FIGYELEM_KIND_HU: Readonly<Record<string, string>> = Object.freeze({
  sajat_igeret: 'Saját ígéret',
  valasz_nelkul: 'Válasz nélkül',
  nema_ugy: 'Néma ügy',
  idegen_igeret: 'Nekem ígérték',
})

/**
 * A típus magyar neve, vagy -- ismeretlen típusra -- maga a kulcs.
 *
 * Az ismeretlen kulcs NEM esik ki és nem kap általános címkét ("Egyéb"): a
 * figyelem-lista determinisztikus, és ha a rangsor egy olyan típust ad, amit
 * ez a lap nem ismer, az egy telepítés-eltérés, amit látni kell, nem
 * elsimítani. A nyers kulcs megnevezi magát, és a sor a helyén marad a
 * rangsorban.
 */
export function figyelemKindNev(kind: string): string {
  return FIGYELEM_KIND_HU[kind] ?? kind
}

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

/**
 * A javaslat elfogadásának (`rpc.mjs` `acceptSuggestion`) nevesített hibakódjai,
 * magyar mondatra fordítva -- CLAUDE.md UX-szabálya szerint egy hibaállapot
 * mondja meg, mi történt ÉS mi a teendő, nem a nyers kódot mutatja
 * (`crm_host_hivas_sikertelen`) az operátornak. Ez a tábla KIZÁRÓLAG az
 * `elfogad` hívás hibáira vonatkozik -- az `elvet` és a `soper` saját hibái
 * (`setSuggestionStatus`, `sweepNow`) más okhalmazból jönnek, és nem osztoznak
 * ezen a szótáron.
 */
const ELFOGADAS_HIBA_HU: Readonly<Record<string, string>> = Object.freeze({
  crm_ismeretlen_javaslat: 'Ez a javaslat már nem létezik -- valaki más időközben elfogadta vagy elvetette. Frissítsd az oldalt.',
  crm_nincs_port_fajl: 'A hoszt port-fájlja nem található -- a szerver talán most indul vagy indul újra. Próbáld újra néhány másodperc múlva.',
  crm_olvashatatlan_port_fajl: 'A hoszt port-fájlja nem olvasható -- ez rendszerhiba, forduljon az üzemeltetőhöz.',
  crm_regi_port_fajl: 'A port-fájl egy korábbi, már leállt szerverpéldányról maradt vissza -- próbáld újra, vagy ha a hiba marad, indítsd újra a hosztot.',
  crm_host_hivas_sikertelen: 'A hoszt nem válaszolt a feladat létrehozására -- próbáld újra.',
  crm_projekt_nem_talalhato: 'A CRM projekt nem található a hoszton, a feladat emiatt nem jött létre -- ellenőrizd, hogy a CRM extension telepítése rendben van-e, vagy forduljon az üzemeltetőhöz.',
  crm_feladat_nem_jott_letre: 'A hoszt nem adott vissza feladat-azonosítót -- a feladat lehet, hogy mégsem jött létre. Ellenőrizd a feladatlistán.',
  crm_ervenytelen_host_valasz: 'A hoszt válasza nem értelmezhető -- a feladat lehet, hogy mégsem jött létre. Ellenőrizd a feladatlistán, vagy forduljon az üzemeltetőhöz.',
})

function elfogadasHibaUzenete(message: string): string {
  return ELFOGADAS_HIBA_HU[message] ?? `A javaslat elfogadása nem sikerült: ${message}`
}

/**
 * A figyelem-sor típusához tartozó osztályok.
 *
 * Tiszta függvény, mert ez az egyetlen hely, ahol a `rangsor` négy
 * trigger-típusa vizuális súlyt kap, és külön tesztelhetőnek kell lennie
 * attól, hogy a lap egyáltalán renderelődik-e. A sorrend szándékosan egyezik
 * a `src/attention.mjs` `SULY`-áéval: ha a kettő elcsúszik, az azt jelentené,
 * hogy a lap más súlyt mutat, mint amit a szerver rangsorolt.
 *
 * Ismeretlen típus nem tűnik el és nem dob: semleges osztályt kap, mert egy
 * új trigger bevezetése nem teheti láthatatlanná a saját sorát.
 */
export function figyelemOsztaly(kind: string): { sor: string; pill: string } {
  switch (kind) {
    case 'sajat_igeret': return { sor: 'crm-k-sajat', pill: 'crm-pill-sajat' }
    case 'valasz_nelkul': return { sor: 'crm-k-valasz', pill: 'crm-pill-valasz' }
    case 'nema_ugy': return { sor: 'crm-k-nema', pill: 'crm-pill-nema' }
    case 'idegen_igeret': return { sor: 'crm-k-idegen', pill: 'crm-pill-idegen' }
    default: return { sor: 'crm-k-idegen', pill: 'crm-pill-plain' }
  }
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
  const [elfogadFut, setElfogadFut] = useState<Record<string, boolean>>({})
  const [elfogadEredmeny, setElfogadEredmeny] = useState('')
  const [figyelem, setFigyelem] = useState<FigyelemSor[]>([])
  const [figyelemOsszes, setFigyelemOsszes] = useState(0)

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
    // A figyelem-lista ugyanabból a törzsből jön, mint amit az Ügyfélkezelő
    // a 08:10-es körében lát (`rpc.mjs` `attention`) -- ez az egyetlen módja
    // annak, hogy az operátor a napi üzenetet ellenőrizni tudja, ne csak
    // elhinni. A hibája a közös `hiba` sávba megy, mint a `board`-é: enélkül
    // egy néma üres lista megkülönböztethetetlen lenne attól, hogy tényleg
    // nincs teendő, és pont a proaktivitás hallgatna el csendben.
    rpc('attention', { limit: 20 })
      .then((f) => {
        const valasz = f as FigyelemValasz
        setFigyelem(valasz.sorok)
        setFigyelemOsszes(valasz.osszes)
      })
      .catch((e: Error) => setHiba(e.message))
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

  /**
   * Az ügyfél lapjára lépés, a lap minden sorából ugyanezen az egy úton.
   *
   * Azért nem a nyers `onOpen`-t adjuk a gomboknak, mert az `elfogadEredmeny`
   * ("Feladat létrehozva: …") egy EGYSZERI művelet visszajelzése, nem a lap
   * állapota: ha a navigáció nem törölné, az operátor egy másik ügyfél lapjáról
   * visszatérve továbbra is egy régi, már nem ide tartozó feladat-azonosítót
   * olvasna a Figyelmet igényel szakasz tetején. Ugyanezért törli `elvet` és
   * `soper` is -- mindhárom olyan művelet, ami után a mondat már mást állítana,
   * mint ami épp történt.
   */
  const megnyit = (accountId: string) => {
    setElfogadEredmeny('')
    onOpen(accountId)
  }

  const elvet = (suggestionId: string) => {
    setElfogadEredmeny('')
    rpc('setSuggestionStatus', { suggestionId, status: 'dismissed' })
      .then(tolt).catch((e: Error) => setHiba(e.message))
  }

  /**
   * A javaslat elfogadása -- ez csinál belőle feladatot (`rpc.mjs`
   * `acceptSuggestion`). A válasz feladat-azonosítóját kiírjuk, hogy az
   * operátor lássa, tényleg született valami, ne csak azt, hogy a javaslat
   * eltűnt a listáról.
   *
   * A `deduplicated` mezőt megkülönböztetjük: ha igaz, a hoszt NEM hozott
   * létre új feladatot, hanem egy már létező, azonos című feladatot adott
   * vissza (`acceptSuggestion` doksija a `rpc.mjs`-ben). Ezt a "Feladat
   * létrehozva"-tól eltérő mondat mutatja -- különben az operátor azt
   * hinné, most született valami, miközben csak egy korábbi feladatra
   * kaptunk vissza mutatót.
   *
   * A MONDAT NEM ÁLLÍTJA, HOGY EZ A JAVASLAT HOZTA LÉTRE A FELADATOT --
   * I-NEW-2: a dedup a hoszt cím+agentId fingerprintjén dől el
   * (`acceptSuggestion` doksija), tehát az ütköző, már létező feladatot akár
   * egy MÁSIK javaslat is létrehozhatta (két javaslat, azonos cím-fingerprint
   * -- lásd a javaslat-id-szuffixot a `rpc.mjs`-ben, ami ezt a legvalószínűbb
   * esetet kizárja, de a szuffix nélküli, régebbi feladatokkal vagy egy
   * kézzel felvitt, azonos című feladattal szemben nem tud garantálni
   * semmit). Az "Ez a javaslat már korábban létrehozott egy feladatot" mondat
   * ezt a hamis okozati állítást tette -- a mondat most azt írja le, amit a
   * hoszt ténylegesen jelentett: hogy egy nyitott, azonos című feladat már
   * létezik, ezért új nem jött létre, és megnevezi az azonosítóját, hogy az
   * operátor meg tudja nézni, tényleg erről a javaslatról van-e szó.
   *
   * MINDKÉT `setElfogadFut` hívás funkcionális formában frissít
   * (`(elozo) => ...`), nem a render-closure `elfogadFut`-ját olvassa: két
   * javaslat gyors egymás utáni elfogadása esetén a második hívás
   * indításakor a closure még a frissítés előtti állapotot látná, és
   * elveszítené az elsőn időközben beállított `true`-t.
   */
  const elfogad = (suggestionId: string) => {
    setElfogadFut((elozo) => ({ ...elozo, [suggestionId]: true }))
    setElfogadEredmeny('')
    rpc('acceptSuggestion', { suggestionId })
      .then((r) => {
        const eredmeny = r as { taskId: string; deduplicated?: boolean }
        setElfogadEredmeny(
          eredmeny.deduplicated
            ? `Már létezik egy nyitott, azonos című feladat -- új nem jött létre, a meglévő azonosítója: ${eredmeny.taskId}`
            : `Feladat létrehozva: ${eredmeny.taskId}`,
        )
        tolt()
      })
      .catch((e: Error) => setHiba(elfogadasHibaUzenete(e.message)))
      .finally(() => setElfogadFut((elozo) => ({ ...elozo, [suggestionId]: false })))
  }

  const soper = () => {
    setFut(true)
    setElfogadEredmeny('')
    rpc('sweepNow', { max: 50 })
      .then((r) => {
        const x = r as {
          scanned: number; recorded: number; recordedOut: number
          unmatched: number; failed: number; skippedOut: number
        }
        const hibaResz = x.failed > 0 ? ` · ${x.failed} hibás (kihagyva)` : ''
        const kimenoKihagyasResz = x.skippedOut > 0 ? ` · ${x.skippedOut} kimenő kihagyva (ismeretlen szál)` : ''
        setSopres(
          `${x.scanned} levél átnézve · ${x.recorded} bejövő idővonalra · ${x.recordedOut} kimenő idővonalra · ` +
          `${x.unmatched} besorolatlan${hibaResz}${kimenoKihagyasResz}`,
        )
        tolt()
      })
      .catch((e: Error) => setHiba(e.message))
      .finally(() => setFut(false))
  }

  return (
    <section className="crm-sec-wrap">
      {hiba && <p className="crm-hiba" role="alert">{hiba}</p>}

      <div className={`crm-strip${postafiok && !postafiok.available ? ' crm-strip-warn' : ''}`}>
        <button className="crm-btn crm-btn-primary crm-btn-sm" onClick={soper} disabled={fut}>
          {fut ? 'Söprés fut…' : 'Levelek behúzása'}
        </button>
        {sopres && <span className="crm-mono crm-halvany">{sopres}</span>}
        {postafiok && (
          <span className={postafiok.available ? 'crm-halvany' : 'crm-hiba'}
                role={postafiok.available ? undefined : 'status'}>
            {postafiokUzenet(postafiok)}
          </span>
        )}
      </div>
      {csakTanult && <p className="crm-halvany" role="status">{csakTanult}</p>}

      <div className="crm-sec">
        <div className="crm-sechead">
          <h3>Figyelmet igényel</h3>
          <span className="crm-count">{figyelem.length} / {figyelemOsszes}</span>
        </div>
        {elfogadEredmeny && <p className="crm-halvany" role="status">{elfogadEredmeny}</p>}
        {/* Ugyanaz a lista, amiből az Ügyfélkezelő a 08:10-es körében dolgozik.
            A sorrend és az indok a `rangsor`-é (`src/attention.mjs`), a lap nem
            rangsorol újra -- ha itt más sorrend látszana, mint amiről az ügynök
            ír, a napi üzenet ellenőrizhetetlen lenne. */}
        {figyelem.length === 0
          ? <p className="crm-empty">Most nincs, ami figyelmet igényelne.</p>
          : (
            <ul className="crm-att">
              {figyelem.map((f) => {
                const o = figyelemOsztaly(f.kind)
                return (
                  <li key={`${f.kind}:${f.commitmentId || f.dealId || f.eventId || f.accountId}`}
                      className={`crm-attrow ${o.sor}`}>
                    <span className="crm-stripe" aria-hidden="true"></span>
                    <div className="crm-attbody">
                      <div className="crm-attline">
                        <span className={`crm-pill ${o.pill}`}>{figyelemKindNev(f.kind)}</span>
                        <span className="crm-atttitle">{f.cim}</span>
                      </div>
                      <p className="crm-attwhy">{f.indok}</p>
                    </div>
                    <div className="crm-attact">
                      <button className="crm-btn crm-btn-sm" onClick={() => megnyit(f.accountId)}>Megnyit</button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        {/* A `osszes` a limitálás ELŐTTI szám (`src/attention-service.mjs`):
            enélkül húsz sor és a teljes lista megkülönböztethetetlen volna, és
            az operátor azt hinné, mindent lát. */}
        {figyelemOsszes > figyelem.length && (
          <p className="crm-halvany">A lista teteje látszik: {figyelem.length} a(z) {figyelemOsszes} sorból.</p>
        )}
      </div>

      <div className="crm-sec">
        <div className="crm-sechead"><h3>Javaslatok</h3><span className="crm-count">{suggestions.length}</span></div>
        {suggestions.length === 0
          ? <p className="crm-empty">Most nincs javaslat.</p>
          : (
            <ul className="crm-sugs">
              {suggestions.map((s) => (
                <li key={s.id} className="crm-sug">
                  <span className="crm-atttitle">{s.text}</span>
                  {s.reason && <span className="crm-attwhy">{s.reason}</span>}
                  <div className="crm-attact">
                    <button className="crm-btn crm-btn-primary crm-btn-sm"
                            onClick={() => elfogad(s.id)} disabled={!!elfogadFut[s.id]}>
                      {elfogadFut[s.id] ? 'Elfogadás…' : 'Elfogad'}
                    </button>
                    <button className="crm-btn crm-btn-quiet crm-btn-sm"
                            onClick={() => elvet(s.id)} disabled={!!elfogadFut[s.id]}>Elvet</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>

      <div className="crm-sec">
        <div className="crm-sechead"><h3>Besorolatlan</h3><span className="crm-count">{unmatched.length}</span></div>
        {unmatched.length === 0
          ? <p className="crm-empty">Nincs besorolatlan levél.</p>
          : (
            <ul className="crm-triage">
              {unmatched.map((u) => {
                const lathatoLista = valaszthatoKapcsolatok(kapcsolatok, u.guess_account_id, !!mindet[u.id])
                const kivalasztott = valasztott[u.id] || ''
                return (
                  <li key={u.id} className="crm-tri">
                    <div className="crm-tri-who">
                      <span className="crm-mono">{u.sender_address}</span>
                      <span className="crm-grow">{u.subject}</span>
                    </div>
                    <div className="crm-tri-pickers">
                      {u.guess_account_id && (
                        <button className="crm-pill crm-pill-plain crm-btn-quiet"
                                onClick={() => u.guess_account_id && megnyit(u.guess_account_id)}>
                          valószínűleg {accounts.find((a) => a.id === u.guess_account_id)?.name}
                        </button>
                      )}
                      <label className="crm-halvany">
                        <input type="checkbox" checked={!!mindet[u.id]}
                               aria-label={`${u.sender_address}: összes kapcsolat, találgatás nélkül`}
                               onChange={(e) => setMindet({ ...mindet, [u.id]: e.target.checked })} />
                        Összes kapcsolat
                      </label>
                      <select value={kivalasztott} aria-label={`${u.sender_address} hozzárendelése`}
                              onChange={(e) => setValasztott({ ...valasztott, [u.id]: e.target.value })}>
                        <option value="">Válassz kapcsolatot…</option>
                        {lathatoLista.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}{c.accountName && ` — ${c.accountName}`}</option>
                        ))}
                      </select>
                      <button className="crm-btn crm-btn-primary crm-btn-sm"
                              onClick={() => hozzarendel(u, lathatoLista)}
                              disabled={!kivalasztasLathato(kivalasztott, lathatoLista)}>Hozzárendel</button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    </section>
  )
}
