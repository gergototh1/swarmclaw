import { newId } from './ids.mjs'

/**
 * Amit a lap hívhat, `POST /api/extensions/crm.mjs/call/<method>` alatt.
 *
 * A hosztnak ez a szélesebb ajtó: itt van minden művelet, amit a spec 5.4
 * az operátornak tart fenn -- ügyfél és ügy létrehozása, szakaszváltás, a
 * besorolatlan hozzárendelése, a javaslat elfogadása. Az ügynök felülete
 * (src/tools.mjs) ezekből egyet sem visz, és külön fájlban van, hogy egy
 * átvitel a diffből látsszon, ne egy megosztott listából.
 */
export function createRpc(state) {
  const repo = () => {
    if (!state.repo) throw new Error('crm_nincs_tar')
    return state.repo
  }

  const mustAccount = (accountId) => {
    const acc = repo().getAccount(accountId)
    if (!acc) throw new Error('crm_ismeretlen_ugyfel')
    return acc
  }

  const mustDeal = (dealId) => {
    const deal = repo().listDeals({}).find((d) => d.id === dealId)
    if (!deal) throw new Error('crm_ismeretlen_ugy')
    return deal
  }

  const mustContact = (contactId) => {
    const con = repo().getContact(contactId)
    if (!con) throw new Error('crm_ismeretlen_kapcsolat')
    return con
  }

  return {
    /** A lap alapállapota egy hívásból: ügyfelek, nyitott ügyek, besorolatlan, javaslatok. */
    async board() {
      const r = repo()
      return {
        accounts: r.listAccounts({}),
        deals: r.listDeals({ openOnly: true }),
        unmatched: r.listUnmatched(),
        suggestions: r.listSuggestions({ status: 'new' }),
      }
    },

    async account({ accountId }) {
      const r = repo()
      const account = mustAccount(accountId)
      return {
        account,
        contacts: r.listContacts(accountId),
        deals: r.listDeals({ accountId }),
        events: r.listEvents({ accountId, limit: 50 }),
        summary: r.latestSummary(accountId),
        commitments: r.listCommitments({ accountId }),
        lastEventAt: r.lastEventAt(accountId),
      }
    },

    async timeline({ accountId, before, limit }) {
      mustAccount(accountId)
      return { events: repo().listEvents({ accountId, before, limit: limit || 50 }) }
    },

    async eventBody({ eventId }) {
      const r = repo()
      if (!r.getEvent(eventId)) throw new Error('crm_ismeretlen_esemeny')
      return { content: r.getEventBody(eventId) }
    },

    async createAccount(args) { return repo().createAccount(args) },
    async updateAccount({ accountId, ...patch }) {
      mustAccount(accountId)
      return repo().updateAccount(accountId, patch)
    },
    async createContact(args) { return repo().createContact(args) },
    async attachEmail({ contactId, address }) {
      mustContact(contactId)
      return repo().attachEmail(contactId, address, 'manual')
    },

    async createDeal(args) { mustAccount(args.accountId); return repo().createDeal(args) },
    async updateDeal({ dealId, ...patch }) { mustDeal(dealId); return repo().updateDeal(dealId, patch) },
    async closeDeal({ dealId, stage, reason }) {
      mustDeal(dealId)
      if (stage !== 'won' && stage !== 'lost') throw new Error('crm_ismeretlen_ugy_szakasz')
      return repo().closeDeal(dealId, { stage, reason })
    },

    /** Kézi jegyzet. A forrás `manual`, az azonosító az eseményé, tehát mindig új sor. */
    async addNote({ accountId, dealId = null, text, occurredAt }) {
      mustAccount(accountId)
      const at = occurredAt || new Date().toISOString()
      return repo().recordEvent({
        accountId, dealId, kind: 'note', occurredAt: at,
        excerpt: String(text || '').slice(0, 200),
        sourceSystem: 'manual', sourceId: `note:${at}:${newId('n')}`,
        body: text,
      })
    },

    /**
     * A besorolatlan levél hozzárendelése -- és ugyanez a hívás tanítja meg a
     * címet.
     *
     * A tanulás nem külön gomb: ha az lenne, az operátor a felét nem nyomná
     * meg, a besorolatlan sor nem apadna, és néhány hét után abbahagyná az
     * egészet. A megerősítés és a tanulás egy művelet.
     */
    async assignUnmatched({ unmatchedId, contactId }) {
      const r = repo()
      const rows = r.listUnmatched().filter((x) => x.id === unmatchedId)
      if (rows.length === 0) throw new Error('crm_ismeretlen_besorolatlan')
      mustContact(contactId)
      if (rows[0].sender_address) r.attachEmail(contactId, rows[0].sender_address, 'learned')
      return r.resolveUnmatched(unmatchedId)
    },

    async setSuggestionStatus({ suggestionId, status }) {
      if (status !== 'accepted' && status !== 'dismissed') throw new Error('crm_ismeretlen_javaslat_allapot')
      return repo().setSuggestionStatus(suggestionId, status)
    },

    /**
     * Feloldódik-e a postafiók-szerződés, és ha nem, miért.
     *
     * A lap ezt írja ki, nem hallgat: az operátort jobban szolgálja egy
     * megnevezett korlát („áll az email-behúzás, mert a Gmail extension ki van
     * kapcsolva"), mint egy modul, ami csendben nem csinál semmit.
     */
    async mailboxHealth() {
      const handle = state.contracts ? state.contracts.get('gmail', 'mailbox', 1) : null
      if (!handle) {
        return { available: false, reason: state.contracts ? 'nem_oldodik_fel' : 'nincs_contracts' }
      }
      const box = await handle.mailbox()
      return { available: true, address: box.address }
    },
  }
}
