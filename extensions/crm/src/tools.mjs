/**
 * Amit az ügynök olvashat. A CRM-1-ben csak olvasás.
 *
 * MIÉRT VAN EGYÁLTALÁN `tools`, A GMAIL MINTÁJÁVAL SZEMBEN. A gmail
 * szándékosan nem ad eszközt: nem akarta tudni, melyik ügynök hívta. A
 * CRM-nél ez fordítva van. Az `execute(args, ctx)` megkapja a `ctx.session`-t,
 * és a CRM-3 abból tölti a `summary.generated_by_agent_id`-t és a javaslat
 * `agent_id`-ját -- enélkül az idővonalon nem válna el az emberi bejegyzés a
 * gépitől. A CRM-1 még nem ír, de az eszközök itt születnek, hogy a CRM-3 ne
 * egy második felületet nyisson melléjük.
 *
 * AMI NINCS ITT, AZ SZÁNDÉKOSAN NINCS. Ügyfél, kapcsolat és ügy létrehozása
 * és törlése, `deal.stage` és `account.status` állítása, a besorolatlan
 * hozzárendelése, és a javaslat elfogadása mind az operátoré (spec 5.4).
 * A besorolatlan hozzárendelése a tanuló-kapu: ha az ügynök átléphetné,
 * akkor nem volna kapu.
 */
export function createTools(state) {
  const repo = () => {
    if (!state.repo) throw new Error('crm_nincs_tar')
    return state.repo
  }

  return [
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
        const contacts = byEmail
          ? [byEmail]
          : accounts.flatMap((a) => r.listContacts(a.id)).filter((c) => c.name.toLowerCase().includes(q))
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
      description: 'Egy ügyfél eseményei kivonattal, a legfrissebbel kezdve. A teljes szöveget nem hozza; ahhoz a crm_event_body kell.',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          before: { type: 'string', description: 'ISO időpont: ennél korábbiakat adj.' },
          limit: { type: 'number' },
        },
        required: ['accountId'],
      },
      async execute({ accountId, before, limit }) {
        return { events: repo().listEvents({ accountId, before, limit: limit || 50 }) }
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
        return { content: repo().getEventBody(eventId) }
      },
    },
  ]
}
