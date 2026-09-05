import type { ManagedStatus } from './api'
import { errorText, readManagedStatus } from './api'

/**
 * Asks the host whether this extension's declared schedules exist.
 *
 * WHY THE PAGE ASKS, AND WHY IT ASKS THE HOST
 * -------------------------------------------
 * The host creates an extension's declared agents and schedules on install, on
 * enable and on upgrade, and again whenever the operator asks -- the Reconcile
 * control on this extension's card in Extensions, or the CLI. That reconcile
 * can fail or skip a declaration, and an operator can delete a schedule by
 * hand, and nothing retries either on its own. So an extension can load, mount
 * this page, render its settings and connect Gmail with no schedule anywhere,
 * and before this the status bar could only say "no sweep has run yet" --
 * true, and not the fact the operator needed, which is that none is going to. The two are told apart here by the same rule the sweep
 * layer is built on: a source that answered "none" and a source that could
 * not be asked are different facts, so the failure of this request is its own
 * state and never reads as "not scheduled".
 *
 * The request goes to the host's own summary endpoint with the same
 * credentials the page itself was served with (the auth cookie travels on a
 * same-origin fetch), so nothing in this bundle holds or reads a key. `fetch`
 * is a parameter so the tests can drive all three states with no server.
 */
export const MANAGED_RESOURCES_URL = '/api/extensions/managed-resources'

export type FetchLike = (input: string, init?: { credentials?: 'same-origin' }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

/** Never throws: a request that failed comes back as `unknown`, with its reason. */
export async function loadManagedStatus(fetchImpl: FetchLike, extensionId: string): Promise<ManagedStatus> {
  try {
    const res = await fetchImpl(MANAGED_RESOURCES_URL, { credentials: 'same-origin' })
    if (!res.ok) return { kind: 'unknown', reason: `a host ${res.status}-tal válaszolt` }
    return readManagedStatus(await res.json(), extensionId)
  } catch (err) {
    return { kind: 'unknown', reason: errorText(err) }
  }
}
