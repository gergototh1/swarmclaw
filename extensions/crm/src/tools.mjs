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
 * AMI NINCS ITT, AZ SZÁNDÉKOSAN NINCS. Ügyfél, kapcsolat és ügy létrehozása
 * és törlése, `deal.stage` és `account.status` állítása, a besorolatlan
 * hozzárendelése, és a javaslat elfogadása mind az operátoré (spec 5.4).
 * A besorolatlan hozzárendelése a tanuló-kapu: ha az ügynök átléphetné,
 * akkor nem volna kapu, és a `crm_sweep` ezt nem érinti.
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
  ]
}
