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
 * A TELJES POSTAFIÓKOT SÖPRI, ÉS EZ SZÁNDÉKOS. A Gmailnek nincs `ALL_MAIL`
 * címke-id-je, tehát a teljes postafiók egyetlen módja az, hogy `labelIds`
 * egyáltalán NEM megy a `list` hívásba. Az „üres `labelIds` = teljes
 * postafiók" korábban védőkorlát volt itt; most a kívánt viselkedés. Amit a
 * korlát célzott -- hogy egy futás ne akarja behúzni a fél postafiókot --, azt
 * a `q` (alapból `newer_than:90d`), a `max` keret és a lapozó kurzor együtt
 * elvégzi: egy futás legfeljebb `max` levelet néz meg, a következő futás pedig
 * a kurzorról folytatja.
 *
 * AZ ARCHIVÁLT LEVÉL NÉLKÜL NINCS IDŐVONAL. Az `['INBOX','SENT']`
 * alapértelmezés szerkezetileg vak volt mindenre, amit az operátor elintézett
 * és kiarchivált -- márpedig épp az elintézett ügyfél-levelezés az, amiből egy
 * idővonal áll. Mérve: mind a 8 Dénes Architects levél `IMPORTANT` +
 * `CATEGORY_PERSONAL` címkét visel, INBOX-ot nem, és `in:inbox`-ra nulla
 * találat jön. A CRM pont abból nem látott semmit, amiért van.
 *
 * A GMAIL `labelIds`-E ÉS-KAPCSOLAT -- EZ IGAZ MARAD, CSAK MÁR NEM EZ A KÓD
 * ALAKJA. A `users.messages.list` `labelIds` paramétere metszetet szűr: a
 * levélnek MINDEN felsorolt címkével rendelkeznie kell. Egy levél vagy az
 * INBOX-ban van, vagy a SENT-ben, sosem mindkettőben, tehát egy
 * `list({ labelIds: ['INBOX','SENT'] })` hívás GARANTÁLTAN üres halmazt ad --
 * ettől a hibától nem húzott be a söprés élesben egyetlen levelet sem,
 * miközben minden teszt zöld maradt. Aki valaha címkét ad ennek a kódnak
 * (`runSweep({ labelIds })`), annak ez a szabály újra érvényes: egyszerre
 * csak olyan címkéket soroljon fel, amik EGY levélen együtt előfordulnak.
 *
 * A BEJÖVŐ/KIMENŐ MEGKÜLÖNBÖZTETÉS NEM A LISTÁZÁSON MÚLIK. A `kind` az üzenet
 * saját `SENT` címkéjéből dől el (`msg.labelIds.includes('SENT')`), a `get`
 * válaszából, üzenetenként -- tehát a címke nélküli listázás sem mossa össze
 * a kimenő levelet a bejövővel.
 *
 * A BESOROLATLAN DOBOZ TEENDŐ-LISTA, NEM ARCHÍVUM. Eseményt a teljes söpört
 * halmazból rögzítünk, archiváltból is: ha ISMERT kapcsolattartótól jött, az
 * idővonalra való. A besorolatlanba viszont csak INBOX-ban lévő levél kerül.
 * A besorolatlan sor azt kérdezi az operátortól, hogy „ki ez?", és ennek csak
 * olyan levélnél van értelme, amivel még dolga van. Egy fél éve archivált
 * hírlevélről ugyanezt megkérdezni nem információ, hanem munka. Nem veszítünk
 * vele semmit -- az archivált levél ismert feladótól így is bekerül --, csak
 * nem kérdezünk vissza olyasmiről, amit az operátor már lezárt. A kihagyás
 * nem néma: `skippedUnmatchedArchived` számolja.
 *
 * EGY LAPON EGY ROSSZ LEVÉL NEM ÁLLÍTHATJA MEG A TÖBBIT. Minden üzenet saját
 * try/catch-ben fut: egy dobott hiba (lekérés, ismeretlen alak) a `failed`
 * számlálóba kerül és névvel a logba, a lap többi levele változatlanul
 * feldolgozódik, és a kurzor a lap végén akkor is előrébb áll, ha közben volt
 * hiba. Egy üzenet önmagában soha nem teheti behúzhatatlanná az összeset.
 */

/**
 * A söprés alapértelmezett keresési szűrője, ha az operátor nem állított be
 * sajátot. Címke-alapértelmezés NINCS: címke nélkül a listázás a teljes
 * postafiókot látja (lásd a fájl tetején), és a `q` az, ami a futást
 * időben határolja.
 */
const DEFAULT_QUERY = 'newer_than:90d'

/**
 * A DRAFT-tal jelölt levél se nem bejövő, se nem elküldött -- a `sentAt` rá
 * nem is megbízható --, ezért a söprés ezt a matchMessage-hívás előtt kizárja.
 * A SENT NINCS itt: azt a kimenő ág (lásd lejjebb) külön kezeli, `email_out`
 * eseményként rögzíti, nem hagyja ki.
 */
const EXCLUDED_LABELS = new Set(['DRAFT'])


/**
 * A söprés egyetlen kurzora.
 *
 * EGY MENET, EGY KURZOR. Amíg címkénként külön `list` menet futott, címkénként
 * külön kurzorra is szükség volt (`gmail:INBOX`, `gmail:SENT`), különben az
 * egyik menet a másik lapozásáról folytatta volna, és levelek fölött ugrott
 * volna át. Címke nélkül egyetlen lapozás van, tehát egyetlen sor. Az `:all`
 * utótag szándékos: a régi, címkés sorok érintetlenül maradnak, és egy
 * frissítés nem egy fél postafióknyi lapozás közepéről indul.
 */
const SWEEP_KEY_ALL = 'gmail:all'

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
     * Egy lap behúzása. `q` a hívóé, de a gyakorlatban egyik belépési pont
     * (rpc `sweepNow`, ügynök `crm_sweep`) sem ad meg -- ilyenkor a beállított
     * (`sopresLekerdezes`) vagy ennek híján az alapértelmezett érték határolja
     * a listázást, hogy a gomb és az eszköz pontosan ugyanazt csinálja.
     *
     * Egy üresre állított beállítás (`''`) is az alapértelmezettre esik
     * vissza -- a `state.settings()` egy törölt mezőre üres stringet ad,
     * sosem `undefined`-et, tehát az `||` mindkét esetben a helyes ágra visz.
     *
     * `labelIds` szűkítés, nem bővítés: e nélkül a teljes postafiók jön.
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

      // A HÍVÓ CÍMKÉJE FELÜLÍRHATJA A TELJES POSTAFIÓKOT, A BEÁLLÍTÁS NEM.
      // Alapból nem megy `labelIds` a listázásba -- ez húzza be az archivált
      // levelet is (lásd a fájl tetején). A régi `sopresCimkek` /
      // `sopresCimke` beállítást SZÁNDÉKOSAN nem olvassuk: az operátor
      // telepítésén ott `'INBOX'` állhat egy korábbi verzióból, és annak a
      // néma tiszteletben tartása pontosan azt a vakságot állítaná vissza,
      // amit ez a söprés megszüntet. Nevesítve naplózzuk, hogy a mező ne
      // tűnjön hatásosnak.
      const settingsLabels = String(settings.sopresCimkek || settings.sopresCimke || '').trim()
      if (settingsLabels) {
        state.log?.warn?.(
          'crm sweep: a sopresCimkek/sopresCimke beallitas figyelmen kivul marad -- '
          + 'a sopres a teljes postafiokot nezi, kulonben az archivalt level kimaradna. '
          + 'A beallitas torolheto.',
          { sopresCimkek: settingsLabels },
        )
      }

      // A `labelIds` felülírás megmarad a hívónak (rpc `sweepNow`), de üresen
      // marad, ha nem adnak ilyet -- és üres `labelIds` a Gmailnél a teljes
      // postafiók. Aki ad, annak a Gmail ÉS-szemantikájával kell számolnia.
      const explicitLabels = (Array.isArray(labelIds) ? labelIds : [])
        .map((l) => String(l).trim())
        .filter(Boolean)
      const effectiveQ = typeof q === 'string' && q
        ? q
        : String(settings.sopresLekerdezes || DEFAULT_QUERY)

      // TÖBB CÍMKE ÉS-KAPCSOLAT, ÉS EZ EGYSZER MÁR ELESBEN FÁJT. A
      // `users.messages.list` metszetet szűr, tehát `['INBOX','SENT']`
      // garantáltan üres halmaz -- ettől nem húzott be a söprés egyetlen
      // levelet sem, miközben minden teszt zöld volt. A hívó felülírását nem
      // írjuk felül, de nevesítve naplózzuk, hogy a diagnózis ne az
      // eseménytábla visszafejtésével kezdődjön.
      if (explicitLabels.length > 1) {
        state.log?.warn?.(
          'crm sweep: tobb cimke egy listazasban ES-kapcsolat -- csak olyan level jon vissza, '
          + 'amin MINDEGYIK cimke rajta van, es pl. az INBOX+SENT metszete mindig ures.',
          { labelIds: explicitLabels },
        )
      }

      // A felülírt címkelistának saját kurzora van: egy szűkített menet
      // lapozása nem folytatható a teljes postafiók lapozásáról, és fordítva.
      const kulcs = explicitLabels.length ? `gmail:${explicitLabels.join('+')}` : SWEEP_KEY_ALL

      let scanned = 0
      let recorded = 0
      let recordedOut = 0
      let unmatched = 0
      let failed = 0
      let skippedOut = 0
      let skippedUnmatchedArchived = 0

      // EGY MENET. A Gmailnek nincs `ALL_MAIL` címkéje, tehát a teljes
      // postafiók egyetlen módja az, hogy `labelIds` nem megy a hívásba.
      const lap = await box.list({
        ...(explicitLabels.length ? { labelIds: explicitLabels } : {}),
        q: effectiveQ,
        max: Math.max(1, Number(max) || 50),
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
          const cimkek = Array.isArray(msg.labelIds) ? msg.labelIds : []
          const kimeno = cimkek.includes('SENT')
          const kind = kimeno ? 'email_out' : 'email_in'

          const talalat = matchMessage({ fromEmail: msg.fromEmail, threadId: msg.threadId }, lookups)

          // A kimenő levélnél az 1. lépés (pontos cím) szándékosan nem talál
          // -- a feladó te vagy --, tehát a 2. lépés, a szál viszi. Ez helyes:
          // egy kimenő levél oda tartozik, ahova a beszélgetés.
          //
          // Az ILLESZTÉS MAGA VÁLTOZATLAN ARCHIVÁLT LEVÉLRE IS: ha ismert a
          // feladó vagy a szál, az esemény akkor is az idővonalra kerül, ha a
          // levél már rég ki van archiválva. Épp ez a fix lényege.
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

          // A BESOROLATLAN DOBOZ TEENDŐ-LISTA, NEM ARCHÍVUM. Illesztetlen
          // levél csak akkor kerül be, ha az INBOX-ban van, tehát az
          // operátornak még dolga van vele. Egy archivált, ismeretlen feladójú
          // levél (hírlevél, rendszerüzenet) csendben kimarad -- de nem
          // nyomtalanul: a `skippedUnmatchedArchived` számolja.
          if (!cimkek.includes('INBOX')) {
            skippedUnmatchedArchived += 1
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
      const cursor = lap.complete ? '' : (lap.nextCursor || '')
      r.setSweepState(kulcs, { cursor, lastSeenAt: new Date().toISOString() })

      return {
        scanned, recorded, recordedOut, unmatched, failed,
        skippedOut, skippedUnmatchedArchived, complete: Boolean(lap.complete), cursor,
      }
    },
  }
}
