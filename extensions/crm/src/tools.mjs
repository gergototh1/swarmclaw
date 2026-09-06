import crypto from 'node:crypto'

import { createAttention } from './attention-service.mjs'
import { createSweep } from './sweep.mjs'

/**
 * Amit az ügynök olvashat, és a CRM-2 óta egy dolog, amit elindíthat.
 *
 * MIÉRT VAN EGYÁLTALÁN `tools`, A GMAIL MINTÁJÁVAL SZEMBEN. A gmail
 * szándékosan nem ad eszközt: nem akarta tudni, melyik ügynök hívta. A
 * CRM-nél ez fordítva van. Az `execute(args, ctx)` megkapja a `ctx.session`-t,
 * és a CRM-3 abból tölti a `summary.generated_by_agent_id`-t és a javaslat
 * `agent_id`-ját -- enélkül az idővonalon nem válna el az emberi bejegyzés a
 * gépitől. A CRM-1 még nem ír, de az eszközök itt születnek, hogy a CRM-3 ne
 * egy második felületet nyisson melléjük.
 *
 * A CRM-2 EGY ÍRÓ ESZKÖZT AD, DE NEM TÖRI A SZABÁLYT. A `crm_sweep` nem
 * ítélet, hanem behúzás: idempotens, és amit nem tud biztosan besorolni, azt
 * a besorolatlan sorba teszi, ahol az operátoré a szó. Ugyanazt a törzset
 * hívja, mint az rpc `sweepNow`, hogy a két belépési pont soha ne térjen el.
 *
 * A CRM-3 ÖT ÍRÓ ESZKÖZT AD: jegyzet, összefoglaló, ígéret, ígéret-feladat
 * kötés, javaslat. Egyik `execute` sem továbbítja az `args`-ot szórással a
 * repo felé -- minden mezőt nevesítve olvasunk ki. Egy `coversEventId`
 * spread mellett átcsúszna a `writeSummary`-hoz, és az ügynök állíthatná,
 * hogy többet fedett le, mint amennyit ténylegesen olvasott -- lásd a
 * `writeSummary` megjegyzését a `db.mjs`-ben.
 *
 * AMI NINCS ITT, AZ SZÁNDÉKOSAN NINCS. Ügyfél, kapcsolat és ügy létrehozása
 * és törlése, `deal.stage` és `account.status` állítása, a besorolatlan
 * hozzárendelése, és a javaslat elfogadása mind az operátoré (spec 5.4).
 * A besorolatlan hozzárendelése a tanuló-kapu: ha az ügynök átléphetné,
 * akkor nem volna kapu, és a `crm_sweep` ezt nem érinti. A javaslat
 * elfogadása ugyanez okból hiányzik: az ügynök javasol, az operátor dönt, és
 * az elfogadás az, ami feladatot csinál a javaslatból -- ha az ügynök saját
 * magának fogadhatná el, a javaslat már nem javaslat volna.
 */
export function createTools(state) {
  const repo = () => {
    if (!state.repo) throw new Error('crm_nincs_tar')
    return state.repo
  }

  return [
    {
      name: 'crm_sweep',
      description: 'Behúzza az új leveleket a Gmail-postafiókból az ügyfelek idővonalára. Idempotens: kétszer futtatva nem duplikál. Amit nem tud biztosan ügyfélhez kötni, azt a besorolatlan sorba teszi, ahol az operátor rendeli hozzá.',
      parameters: {
        type: 'object',
        properties: { max: { type: 'number', description: 'Legfeljebb ennyi levelet néz meg egy futásban.' } },
      },
      async execute({ max }) {
        return createSweep(state).runSweep({ max: Number(max) || 50 })
      },
    },
    {
      name: 'crm_search',
      description: 'Ügyfél, kapcsolat és ügy keresése név, email-cím vagy ügycím részlete alapján.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keresett részlet.' } },
        required: ['query'],
      },
      async execute({ query }) {
        const r = repo()
        const q = String(query || '').trim().toLowerCase()
        if (!q) return { accounts: [], contacts: [], deals: [] }

        const byEmail = r.contactByEmail(q)
        const accounts = r.listAccounts({}).filter((a) =>
          a.name.toLowerCase().includes(q) || a.domains.some((d) => d.includes(q)))
        const byName = r.searchContacts(q)
        const contacts = byEmail
          ? [byEmail, ...byName.filter((c) => c.id !== byEmail.id)]
          : byName
        const deals = r.listDeals({}).filter((d) => d.title.toLowerCase().includes(q))
        return { accounts, contacts, deals }
      },
    },
    {
      name: 'crm_account',
      description: 'Egy ügyfél teljes lapja: profil, kapcsolatok, ügyek, utolsó események, az aktuális összefoglaló és hogy elavult-e, valamint a nyitott ígéretek.',
      parameters: {
        type: 'object',
        properties: { accountId: { type: 'string' } },
        required: ['accountId'],
      },
      async execute({ accountId }) {
        const r = repo()
        const account = r.getAccount(accountId)
        if (!account) throw new Error('crm_ismeretlen_ugyfel')
        return {
          account,
          contacts: r.listContacts(accountId),
          deals: r.listDeals({ accountId }),
          events: r.listEvents({ accountId, limit: 20 }),
          summary: r.latestSummary(accountId),
          commitments: r.listCommitments({ accountId, openOnly: true }),
        }
      },
    },
    {
      name: 'crm_timeline',
      description: 'Egy ügyfél eseményei kivonattal, a legfrissebbel kezdve. A teljes szöveget nem hozza; ahhoz a crm_event_body kell. Lapozáshoz a `before` mellé küldd vissza a legutóbb kapott lap LEGRÉGEBBI eseményének id-jét is `beforeId`-ként -- a Gmail időbélyege másodperc-pontos, tehát egybeeshet két esemény, és `beforeId` nélkül egy ilyen egyezés-csoport tagja némán kimaradhat a lapozásból.',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          before: { type: 'string', description: 'ISO időpont: ennél korábbiakat adj.' },
          beforeId: { type: 'string', description: 'A `before` időponthoz tartozó, legutóbb kapott legrégebbi esemény id-je -- a `before`-ral azonos időpontú egyezéseket ez dönti el helyesen.' },
          limit: { type: 'number' },
        },
        required: ['accountId'],
      },
      async execute({ accountId, before, beforeId, limit }) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        return { events: r.listEvents({ accountId, before, beforeId, limit: limit || 50 }) }
      },
    },
    {
      name: 'crm_event_body',
      description: 'Egy esemény teljes szövege: a levél törzse vagy a megbeszélés leirata.',
      parameters: {
        type: 'object',
        properties: { eventId: { type: 'string' } },
        required: ['eventId'],
      },
      async execute({ eventId }) {
        const r = repo()
        if (!r.getEvent(eventId)) throw new Error('crm_ismeretlen_esemeny')
        return { content: r.getEventBody(eventId) }
      },
    },
    {
      name: 'crm_attention',
      description: 'Mi igényel figyelmet, rangsorolva: néma nyitott ügyek, válasz nélküli levelek, és feladat nélküli ígéretek mindkét irányba. A sorrend és az ok determinisztikus -- ne számold újra, és ne találj ki mást; ebből ÍRJ, ne ebből következtess.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Legfeljebb ennyi sort adj vissza.' } },
      },
      async execute({ limit }) {
        return createAttention(state).list({ limit: Number(limit) || 50 })
      },
    },
    {
      name: 'crm_note',
      description: 'Jegyzet az ügyfél idővonalára. Arra való, hogy rögzítsd, amit megtudtál — nem arra, hogy összefoglalj.',
      parameters: {
        type: 'object',
        properties: { accountId: { type: 'string' }, text: { type: 'string' } },
        required: ['accountId', 'text'],
      },
      async execute({ accountId, text }, ctx) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        const at = new Date().toISOString()
        // A `sourceId` a `(source_system, source_id)` egyedi indexbe fut: két
        // jegyzet ugyanattól az ügynöktől ugyanabban az ezredmásodpercben
        // névileg ütközne, és a második `recordEvent` `{ created: false }`-t
        // adna vissza -- csendben eldobva a második jegyzetet. A jegyzet nem
        // idempotens művelet (nem söprés, nem levél-behúzás), tehát ez itt
        // adatvesztés volna, nem védelem. A rövid véletlen utótag ezt zárja
        // ki, miközben az id maga -- ügynök, időbélyeg -- olvasható marad.
        const sourceId = `agent:${ctx?.session?.agentId || 'ismeretlen'}:${at}:${crypto.randomBytes(4).toString('hex')}`
        return r.recordEvent({
          accountId, kind: 'note', occurredAt: at,
          excerpt: String(text || '').slice(0, 200),
          sourceSystem: 'agent',
          sourceId,
          body: String(text || ''),
        })
      },
    },
    {
      name: 'crm_summary_write',
      description: 'Összefoglaló az ügyfélről. Azt írd le, ami az idővonalon tényleg szerepel. A lefedettséget a rendszer bélyegzi rá — nem tudod és nem is kell megadnod.',
      parameters: {
        type: 'object',
        properties: { accountId: { type: 'string' }, text: { type: 'string' } },
        required: ['accountId', 'text'],
      },
      async execute({ accountId, text }, ctx) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        return r.writeSummary({ accountId, text: String(text || ''), agentId: ctx?.session?.agentId || '' })
      },
    },
    {
      name: 'crm_commitment_write',
      description: 'Egy elhangzott ígéret rögzítése egy eseményből. A direction az ígérő oldala: "ours" amit az operátor ígért, "theirs" amit neki ígértek.',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' }, eventId: { type: 'string' }, text: { type: 'string' },
          direction: { type: 'string', enum: ['ours', 'theirs'] },
          dueHint: { type: 'string', description: 'Ha elhangzott határidő, szó szerint.' },
        },
        required: ['accountId', 'eventId', 'text', 'direction'],
      },
      async execute({ accountId, eventId, text, direction, dueHint }) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        if (!r.getEvent(eventId)) throw new Error('crm_ismeretlen_esemeny')
        if (direction !== 'ours' && direction !== 'theirs') throw new Error('crm_ismeretlen_igeret_irany')
        return r.writeCommitment({ accountId, eventId, text: String(text || ''), direction, dueHint: String(dueHint || '') })
      },
    },
    {
      name: 'crm_commitment_link',
      description: 'Egy ígéret összekötése a belőle született feladattal. Ezután az ígéret nem szerepel többé a figyelem-listán.',
      parameters: {
        type: 'object',
        properties: { commitmentId: { type: 'string' }, taskId: { type: 'string' } },
        required: ['commitmentId', 'taskId'],
      },
      async execute({ commitmentId, taskId }) {
        const out = repo().linkCommitmentTask(commitmentId, String(taskId || ''))
        if (!out) throw new Error('crm_ismeretlen_igeret')
        return out
      },
    },
    {
      name: 'crm_suggestion_write',
      description: 'Javaslat az operátornak egy következő lépésre. Te javasolsz, ő dönt — elfogadni nem tudod, és az elfogadás az, ami feladatot csinál belőle.',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' }, text: { type: 'string' },
          reason: { type: 'string', description: 'Egy mondat arról, mire alapozod.' },
          triggerKind: { type: 'string', description: 'A crm_attention sorának kind mezője, ha abból jött.' },
          triggerEventId: { type: 'string' },
          commitmentId: {
            type: 'string',
            description: 'Az ígéret azonosítója -- KÖTELEZŐ megadni, ha a javaslat a figyelem-lista ' +
              'sajat_igeret vagy idegen_igeret sorából jött, különben az ígéret az elfogadás után sem zárul le.',
          },
        },
        required: ['accountId', 'text'],
      },
      async execute({ accountId, text, reason, triggerKind, triggerEventId, commitmentId }, ctx) {
        const r = repo()
        if (!r.getAccount(accountId)) throw new Error('crm_ismeretlen_ugyfel')
        // A `commitmentId` az ügynöktől jön -- ugyanaz az elv, ami miatt a
        // `covers_event_id`-t a `writeSummary` maga bélyegzi, nem a hívó
        // (lásd ott): ha az ügynök adhatna meg bármilyen commitmentId-t
        // ellenőrzés nélkül, egy tévesen (vagy szándékosan) átadott,
        // MÁSIK ügyfélhez tartozó azonosító az operátor elfogadásakor annak
        // az ügyfélnek zárná le csendben egy nyitott ígéretét, akinek
        // semmi köze ehhez a javaslathoz.
        if (commitmentId) {
          const igeret = r.getCommitment(commitmentId)
          if (!igeret) throw new Error('crm_ismeretlen_igeret')
          if (igeret.account_id !== accountId) throw new Error('crm_igeret_mas_ugyfele')
        }
        return r.writeSuggestion({
          accountId, text: String(text || ''), reason: String(reason || ''),
          triggerKind: String(triggerKind || ''), triggerEventId: triggerEventId || null,
          commitmentId: commitmentId || null,
          agentId: ctx?.session?.agentId || '',
        })
      },
    },
  ]
}
