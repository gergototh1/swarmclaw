import type { ItemsPage, ListStatus, Rpc } from './api'
import { errorText, readItemsPage } from './api'

/**
 * What the list is showing: a page, a refusal, or neither yet.
 *
 * `refused` is its own state and not an empty page. `reads.mjs` refuses an
 * argument it cannot honour by name -- a status outside its vocabulary, a
 * search over 200 characters, a limit that is not a whole number -- and an
 * empty list under a refused query would be this page reporting "nothing
 * matches" about a question that was never asked. The message is the one the
 * rpc layer threw, shown as text.
 */
export type ListState =
  | { kind: 'loading' }
  | { kind: 'ok'; page: ItemsPage }
  | { kind: 'refused'; message: string }

export interface ListQuery {
  status: ListStatus
  q: string
  limit: number
}

/** Ask for one page. Never throws: a refusal comes back as a state. */
export async function loadList(rpc: Rpc, query: ListQuery): Promise<ListState> {
  try {
    const page = readItemsPage(await rpc('items', { status: query.status, q: query.q, order: 'recent', limit: query.limit }))
    return { kind: 'ok', page }
  } catch (err) {
    return { kind: 'refused', message: errorText(err) }
  }
}
