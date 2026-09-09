import { matchMessage } from './matching.mjs'

/**
 * A szerződéstől az eseményig. Az egyetlen fájl, ami a `mailbox` szerződést
 * hívja.
 *
 * IDEMPOTENS, ÉS EZ KÖVETELMÉNY, NEM KÉNYELEM. A `recordEvent` a
 * `(source_system, source_id)` unique indexre bízza a döntést, tehát ugyanaz a
 * levél kétszer behúzva egy sor marad. Ez teszi a söprést újrafuttathatóvá
 * anélkül, hogy bárkinek számon kellene tartania, meddig jutott.
 *
 * AMI NEM BIZTOS, AZ NEM KERÜL AZ IDŐVONALRA. A domain-tipp a besorolatlan
 * sorba megy `guess_account_id`-vel — egy kattintás az operátornak, és a
 * kattintás egyben megtanulja a címet (rpc `assignUnmatched`). Ha a tipp
 * automatikusan besorolna, a `noreply@`, a könyvelő és a külsős alvállalkozó
 * mind az ügyfél idővonalára kerülne, onnan az összefoglalójába.
 *
 * CÍMKÉNKÉNT KÜLÖN MENET, MERT A GMAIL `labelIds`-E ÉS-KAPCSOLAT. A
 * `users.messages.list` `labelIds` paramétere metszetet szűr: a levélnek
 * MINDEN felsorolt címkével rendelkeznie kell. Egy levél vagy az INBOX-ban
 * van, vagy a SENT-ben, sosem mindkettőben, tehát egyetlen
 * `list({ labelIds: ['INBOX','SENT'] })` hívás GARANTÁLTAN üres halmazt ad --
 * pontosan ez volt az a hiba, amitől a söprés élesben egyetlen levelet sem
 * húzott be, miközben minden teszt zöld maradt. A söprés ezért címkénként
 * külön `list` menetet fut, címkénként külön kurzorral
 * (`ext_crm_sweep_state` kulcs: `gmail:<CIMKE>`). Ha valaha egyetlen menetre
 * kellene visszatérni, az csak `q`-ban megfogalmazott `in:inbox OR in:sent`
 * lehet -- de az feloldaná az „üres labelIds = teljes postafiók" védőkorlátot,
 * ezért nem az az út.
 *
 * EGY LAPON EGY ROSSZ LEVÉL NEM ÁLLÍTHATJA MEG A TÖBBIT. Minden üzenet saját
 * try/catch-ben fut: egy dobott hiba (lekérés, ismeretlen alak) a `failed`
 * számlálóba kerül és névvel a logba, a lap többi levele változatlanul
 * feldolgozódik, és a kurzor a lap végén akkor is előrébb áll, ha közben volt
 * hiba. Egy üzenet önmagában soha nem teheti behúzhatatlanná az összeset.
 */

/**
 * A söprés alapértelmezett Gmail-címkéi és keresési szűrője, ha az operátor
 * nem állított be sajátot. A SENT itt is benne van: e nélkül egy friss
 * telepítés (beállítás mentése előtt) nem látná a kimenő leveleket, és a
 * „válasz nélküli levél" jelzés (CRM-3) hallgatna.
 */
const DEFAULT_LABELS = ['INBOX', 'SENT']
const DEFAULT_QUERY = 'newer_than:90d'

/**
 * A DRAFT-tal jelölt levél se nem bejövő, se nem elküldött -- a `sentAt` rá
 * nem is megbízható --, ezért a söprés ezt a matchMessage-hívás előtt kizárja.
 * A SENT NINCS itt: azt a kimenő ág (lásd lejjebb) külön kezeli, `email_out`
 * eseményként rögzíti, nem hagyja ki.
 */
const EXCLUDED_LABELS = new Set(['DRAFT'])

/**
 * Vesszős címke-lista szöveggé alakítása tömbbé: vág, üreset dob. Üres
 * bemenetre (nincs beállítás egyik kulcson sem) az alapértelmezett címkéket
 * adja -- SOHA nem üres tömböt, mert a `mailbox.list({ labelIds: [] })`
 * a teljes postafiókot söpörné (lásd a fájl tetején lévő figyelmeztetést).
 */
function parseLabelList(raw) {
  const parsed = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return parsed.length ? parsed : DEFAULT_LABELS
}

/**
 * A söprés kurzorának kulcsa egy címkére.
 *
 * CÍMKÉNKÉNT KÜLÖN SOR, MERT CÍMKÉNKÉNT KÜLÖN LISTÁZÁS VAN. Egy közös kulcs
 * (a régi `'gmail'`) egyetlen `nextCursor`-t tartott, miközben most több,
 * egymástól független lapozás fut: a SENT kurzorával folytatott INBOX-menet
 * levelek fölött ugrana át, és soha semmi nem mondaná meg, melyek fölött.
 * A régi, közös sort a 7-es migráció törli.
 */
function sweepStateKey(label) {
  return `gmail:${String(label)}`
}

export function createSweep(state) {
  const repo = () => {
    if (!state.repo) throw new Error('crm_nincs_tar')
    return state.repo
  }

  /**
   * A postafiók-szerződés kettéosztott hívása.
   *
   * `state.contracts.get` a hoszton KÉT argumentumot vár (extensionId,
   * contract) -- a verziót a `consumes` deklaráció köti (lásd `index.mjs`),
   * `get`-nek nincs harmadik paramétere. Ugyanez a hívásalak, mint az rpc
   * `mailboxHealth`-je.
   */
  const mailbox = () => {
    const handle = state.contracts ? state.contracts.get('gmail', 'mailbox') : null
    if (!handle) throw new Error('crm_nincs_postafiok')
    return handle
  }

  return {
    /** Teszt-varrat: a szerződés-forrás cserélhető. Éles kódból ne olvasd. */
    __state: state,

    /**
     * Egy lap behúzása. `labelIds` és `q` a hívóé, de a gyakorlatban egyik
     * belépési pont (rpc `sweepNow`, ügynök `crm_sweep`) sem ad meg egyiket
     * sem -- ilyenkor a beállított (`sopresCimke`, `sopresLekerdezes`) vagy
     * ennek híján az alapértelmezett érték határolja a listázást, hogy a
     * gomb és az eszköz pontosan ugyanazt csinálja.
     *
     * Egy üresre állított beállítás (`''`) is az alapértelmezettre esik
     * vissza -- a `state.settings()` egy törölt mezőre üres stringet ad,
     * sosem `undefined`-et, tehát az `||` mindkét esetben a helyes ágra visz.
     */
    async runSweep({ labelIds, q, max = 50 } = {}) {
      const r = repo()
      const box = mailbox()
      const settings = (state.settings ? state.settings() : {}) || {}
      const lookups = {
        contactByEmail: (a) => r.contactByEmail(a),
        accountIdByThread: (t) => r.accountIdByThread(t),
        accountsByDomain: (d) => r.accountsByDomain(d),
      }

      // A `sopresCimkek` (többes szám, vesszős lista) az uralkodó kulcs.
      // A régi, egyes számú `sopresCimke` tartalék: az operátor telepítésén
      // ez már be lehet állítva, és e nélkül a tartalék nélkül egy frissítés
      // némán visszaállítaná az alapértékre az ő beállítását.
      const effectiveLabelIds = Array.isArray(labelIds) && labelIds.length
        ? labelIds
        : parseLabelList(settings.sopresCimkek || settings.sopresCimke)
      const effectiveQ = typeof q === 'string' && q
        ? q
        : String(settings.sopresLekerdezes || DEFAULT_QUERY)

      // A SENT hianya NEM egy szuk, kihagyhato eset: a CRM-2 alapertelmezett
      // `sopresCimke`-je pontosan `'INBOX'` volt, tehat barmelyik telepitesen,
      // ahol az operator azt a mezot valaha elmentette, a tartalek-ag egy
      // SENT nelkuli listat ad. Ekkor egyetlen `email_out` esemeny sem kerul
      // az idovonalra, es az `unansweredThreads` -- ami pontosan a kimeno
      // esemeny hianyat keresi -- MINDEN bejovo levelet valasz nelkulinek
      // mond. A CRM-3 zaszloshajo jelzese igy nem elhallgat, hanem
      // forditva: teljes zajja valik, es semmi nem mondja meg, miert. A
      // sopres emiatt fut tovabb (az operator beallitasat nem irjuk felul),
      // de nevesitve naplozzuk, hogy a diagnozis ne az esemenytabla
      // visszafejtesevel kezdodjon.
      if (!effectiveLabelIds.some((l) => String(l).toUpperCase() === 'SENT')) {
        state.log?.warn?.(
          'crm sweep: a felbontott cimkelistaban nincs SENT -- kimeno level nem kerul az idovonalra, '
          + 'es a "valasz nelkuli level" jelzes emiatt minden bejovo levelet valasz nelkulinek fog mondani. '
          + 'Vedd fel a SENT-et a sopresCimkek beallitasba.',
          { labelIds: effectiveLabelIds },
        )
      }

      // A `max` az EGÉSZ futás költségvetése, nem címkénkénti: a `crm_sweep`
      // eszköz leírása és az operátor gombja is egy futásra értett darabszámot
      // ígér, és címkénként külön `max` néma duplázás volna a Gmail-kvótán.
      //
      // AZ EGYENLŐ ELOSZTÁS SZÁNDÉKOS, NEM A KIHASZNÁLTSÁG A CÉL. Egy közös,
      // fogyó keret mellett egy tele INBOX minden futásban elvinné az egészet,
      // és a SENT sosem jutna szóhoz -- ez pedig pont a fenti figyelmeztetés
      // esete: kimenő esemény nélkül az `unansweredThreads` MINDEN bejövő
      // levelet válasz nélkülinek mond. A menet inkább keveset lát mindkét
      // címkéből, mint sokat az egyikből.
      const teljesMax = Math.max(1, Number(max) || 50)
      const cimkenkentiMax = Math.max(1, Math.floor(teljesMax / effectiveLabelIds.length))

      let scanned = 0
      let recorded = 0
      let recordedOut = 0
      let unmatched = 0
      let failed = 0
      let skippedOut = 0
      let complete = true
      const cursors = {}

      for (const label of effectiveLabelIds) {
        const kulcs = sweepStateKey(label)

        // EGY CÍMKE EGY HÍVÁSBAN. Több címke egyetlen `labelIds`-ben metszetet
        // kérne a Gmailtől (ÉS-kapcsolat, lásd a fájl tetején), és az INBOX+SENT
        // metszete mindig üres.
        const lap = await box.list({
          labelIds: [label],
          q: effectiveQ,
          max: cimkenkentiMax,
          cursor: r.getSweepState(kulcs)?.cursor || undefined,
        })
        scanned += lap.ids.length

        for (const id of lap.ids) {
          try {
            const msg = await box.get({ id })

            // A DRAFT-ot a `sentAt` sem tenné megbízhatóvá -- se az
            // idővonalra, se a besorolatlanba nem kerül.
            if ((msg.labelIds || []).some((l) => EXCLUDED_LABELS.has(l))) continue

            // A szolgáltató a `sentAt`-ot deliberáltan `null`-ra hagyja, ha a
            // Gmail `internalDate`-je nem használható -- nem tippel dátumot.
            // Egy kitalált időpont csendben rossz adat volna az idővonalon
            // (lásd a fájl tetején), ezért a levél kimarad, és a `failed`
            // számlálóban látszik, nem egy dobott SQL-hibában.
            if (!msg.sentAt) {
              failed += 1
              state.log?.warn?.('crm sweep: sentAt hianyzik, level kihagyva', { id })
              continue
            }

            // A SENT címke az egyetlen megbízható jel arra, hogy ez a levél tőlünk
            // ment. A feladó címére nem építünk: az operátornak több címe lehet, és
            // egy alias vagy egy megosztott postafiók ugyanúgy tőle jön.
            const kimeno = Array.isArray(msg.labelIds) && msg.labelIds.includes('SENT')
            const kind = kimeno ? 'email_out' : 'email_in'

            const talalat = matchMessage({ fromEmail: msg.fromEmail, threadId: msg.threadId }, lookups)

            // A kimenő levélnél az 1. lépés (pontos cím) szándékosan nem talál
            // -- a feladó te vagy --, tehát a 2. lépés, a szál viszi. Ez helyes:
            // egy kimenő levél oda tartozik, ahova a beszélgetés.
            if (talalat.kind === 'exact' || talalat.kind === 'thread') {
              const { created } = r.recordEvent({
                accountId: talalat.accountId,
                contactId: talalat.contactId || null,
                kind,
                occurredAt: msg.sentAt,
                title: msg.subject || '',
                excerpt: String(msg.text || '').slice(0, 200),
                sourceSystem: 'gmail',
                sourceId: msg.id,
                threadId: msg.threadId || '',
                body: msg.text || '',
              })
              if (created) {
                if (kimeno) recordedOut += 1
                else recorded += 1
              }
              continue
            }

            // Egy kimenő levél, aminek se pontos címe, se szála nincs, a
            // besorolatlanba SEM kerül: a `sender_address` ott a mi saját
            // címünk volna, és az rpc `assignUnmatched` ezt tanulná meg egy
            // ügyfél címeként (`attachEmail`) -- csendben elrontva a jövőbeli
            // címillesztést. Inkább kimarad, mint egy rossz tanulás -- de a
            // kimaradás nem lehet néma: a `skippedOut` számlálóban és a logban
            // is látszik, különben egy sopres nyomtalanul dobhatna el kimenő
            // levelet.
            if (kimeno) {
              skippedOut += 1
              state.log?.warn?.('crm sweep: kimeno level ismeretlen szallal, kihagyva', { id })
              continue
            }

            const { created } = r.recordUnmatched({
              sourceSystem: 'gmail',
              sourceId: msg.id,
              senderAddress: msg.fromEmail || '',
              senderName: msg.fromName || '',
              subject: msg.subject || '',
              excerpt: String(msg.text || '').slice(0, 200),
              receivedAt: msg.sentAt,
              guessAccountId: talalat.kind === 'guess' ? talalat.guessAccountId : null,
              threadId: msg.threadId || '',
            })
            if (created) unmatched += 1
          } catch (err) {
            failed += 1
            state.log?.warn?.('crm sweep: level feldolgozasa sikertelen', {
              id, message: err instanceof Error ? err.message : String(err),
            })
          }
        }

        // A kurzor akkor is előrébb áll, ha a lapon volt hiba -- a hibás
        // levelek elszámoltak a `failed`-ben, de nem tarthatják a kurzort
        // örökre a lap elején.
        const kovetkezo = lap.complete ? '' : (lap.nextCursor || '')
        r.setSweepState(kulcs, { cursor: kovetkezo, lastSeenAt: new Date().toISOString() })
        cursors[label] = kovetkezo
        if (!lap.complete) complete = false
      }

      // `cursors` a régi, egyetlen `cursor` mező helyén: címkénként külön
      // lapozás mellett egyetlen string nem tudná megmondani, MELYIK menet áll
      // hol, és egy „üres, tehát kész" olvasat hazudna, amint az egyik címke
      // még lapoz.
      return { scanned, recorded, recordedOut, unmatched, failed, skippedOut, complete, cursors }
    },
  }
}
