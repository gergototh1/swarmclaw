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
 * EGY LAPON EGY ROSSZ LEVÉL NEM ÁLLÍTHATJA MEG A TÖBBIT. Minden üzenet saját
 * try/catch-ben fut: egy dobott hiba (lekérés, ismeretlen alak) a `failed`
 * számlálóba kerül és névvel a logba, a lap többi levele változatlanul
 * feldolgozódik, és a kurzor a lap végén akkor is előrébb áll, ha közben volt
 * hiba. Egy üzenet önmagában soha nem teheti behúzhatatlanná az összeset.
 */

/** A söprés alapértelmezett Gmail-címkéje és keresési szűrője, ha az operátor nem állított be sajátot. */
const DEFAULT_LABEL = 'INBOX'
const DEFAULT_QUERY = 'newer_than:90d'

/**
 * Ezekkel a címkékkel jelölt levél a saját kimenő postánk, nem bejövő -- a
 * söprés soha nem sorolja be `email_in`-ként, és a besorolatlanba sem teszi.
 *
 * A CRM ma nem támogat `email_out` eseményt (ez a 3. fázis kizárási listáján
 * van), tehát a kimenő levél helye SEHOL nincs -- ez szándékos, nem hiányzó
 * ág. Az alapértelmezett `labelIds` (INBOX) már önmagában kizárja a SENT és a
 * DRAFT mappát, de ez a szűrő azt a helyzetet is fedezi, amikor az operátor a
 * beállított címkét tágítja, vagy egy szál mindkét irányú levelet hoz vissza
 * ugyanazon a listázáson.
 */
const EXCLUDED_LABELS = new Set(['SENT', 'DRAFT'])

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

      const effectiveLabelIds = Array.isArray(labelIds) && labelIds.length
        ? labelIds
        : [String(settings.sopresCimke || DEFAULT_LABEL)]
      const effectiveQ = typeof q === 'string' && q
        ? q
        : String(settings.sopresLekerdezes || DEFAULT_QUERY)

      const lap = await box.list({
        labelIds: effectiveLabelIds,
        q: effectiveQ,
        max,
        cursor: r.getSweepState('gmail')?.cursor || undefined,
      })
      let recorded = 0
      let unmatched = 0
      let failed = 0

      for (const id of lap.ids) {
        try {
          const msg = await box.get({ id })

          // A saját kimenő levelünk soha nem bejövő esemény -- se az
          // idővonalra, se a besorolatlanba.
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

          const talalat = matchMessage({ fromEmail: msg.fromEmail, threadId: msg.threadId }, lookups)

          if (talalat.kind === 'exact' || talalat.kind === 'thread') {
            const { created } = r.recordEvent({
              accountId: talalat.accountId,
              contactId: talalat.contactId || null,
              kind: 'email_in',
              occurredAt: msg.sentAt,
              title: msg.subject || '',
              excerpt: String(msg.text || '').slice(0, 200),
              sourceSystem: 'gmail',
              sourceId: msg.id,
              threadId: msg.threadId || '',
              body: msg.text || '',
            })
            if (created) recorded += 1
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
      r.setSweepState('gmail', { cursor: lap.complete ? '' : (lap.nextCursor || ''), lastSeenAt: new Date().toISOString() })
      return { scanned: lap.ids.length, recorded, unmatched, failed, complete: lap.complete, cursor: lap.nextCursor || '' }
    },
  }
}
