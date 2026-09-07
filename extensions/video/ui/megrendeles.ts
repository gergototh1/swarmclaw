import { errorText, isRecord } from './api'

/**
 * Ordering ONE agent turn from the host, in three calls and nothing else.
 *
 * WHY THE PAGE ORDERS INSTEAD OF DOING. The video view already presses the
 * three mechanical levers itself -- open, narrate, render -- because none of
 * them needs judgement: they are service functions the module runs on the
 * spot. Writing a plan and reviewing it are the two steps that are judgement
 * and nothing else, and no rpc method can be added for them, because what
 * they need is a model reading a source and choosing scenes. So the page
 * cannot do them; it can only put them on an agent's queue, which is what
 * this file is.
 *
 * WHY THIS IS A FILE OF ITS OWN, AND WHY IT KNOWS NOTHING. It talks to the
 * HOST -- `/api/agents`, `/api/chats` -- and not to `rpc.mjs`, so it has no
 * business knowing about videos, plans, React or this extension's own rpc
 * shapes. What it takes is an agent's display name, a title for the
 * conversation and one instruction; what it gives back is which of six things
 * happened. `ui/video.tsx` owns every sentence and every video-shaped string.
 *
 * WHY NAME AND NOT ID. The host mints an agent's id on reconcile, so it is
 * different in every install, and nothing in this bundle could hold one.
 * `src/agents.mjs` declares `displayName`, the host stores it as `name`, and
 * that is the one stable handle a page can look up.
 *
 * THREE CALLS AND NO FOURTH. It does not wait for the turn, does not poll for
 * the result and does not parse the stream. What proves the turn worked is
 * that a plan or a verdict appears in the `video` detail on the next load --
 * not anything this file could read.
 *
 * SAME-ORIGIN AND NO KEYS. The page runs inside the host's shell, so the auth
 * cookie travels on a same-origin fetch and this bundle holds and reads no
 * credential of any kind. `fetchImpl` is a parameter with the global as its
 * default, exactly as `loadManagedStatus` takes one, so the tests can drive
 * every failure below with no server.
 *
 * IT NEVER THROWS. Each of the three steps carries its own try/catch and each
 * has its own named answer, so the caller switches on `kind` and needs no
 * catch. A rejection escaping here would leave the button that fired it dark
 * for ever on a state nobody named -- which is the failure mode the whole
 * discriminated union exists to prevent.
 */

export const AGENTS_URL = '/api/agents'
export const CHATS_URL = '/api/chats'

/** The part of a `Response` this file uses. Keeping it this narrow is what lets a test hand over a plain object. */
export interface HostValasz {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type HostFetch = (input: string, init?: {
  method?: string
  credentials?: 'same-origin'
  headers?: Record<string, string>
  body?: string
}) => Promise<HostValasz>

/**
 * The six outcomes, one per fact.
 *
 * They are deliberately not folded together. "The agent list could not be
 * read" and "there is no agent by that name" are the same distinction
 * `ManagedStatus` draws between `unknown` and `unscheduled`: a question that
 * was answered "none" and a question that could not be put are different
 * facts, and the operator does something different about each -- look at why
 * the host would not answer, or press Reconcile. An agent that exists but is
 * disabled is a third: the host answers 409 on the session, and the fix is on
 * the Agents screen. A session that did not open and an instruction the host
 * refused are the last two, and they are told apart by which call failed.
 */
export type Megrendeles =
  | { kind: 'elment'; agentId: string; sessionId: string }
  | { kind: 'ugynokok_olvashatatlanok'; reason: string }
  | { kind: 'nincs_ilyen_ugynok'; agentNev: string }
  | { kind: 'ugynok_letiltva'; agentNev: string }
  | { kind: 'session_nem_nyilt'; reason: string }
  | { kind: 'uzenet_elutasitva'; reason: string }

/**
 * The host's own fetch, wrapped rather than passed bare: an unbound `fetch` is
 * an illegal invocation in a browser.
 *
 * EXPORTED, AND THE ONLY ONE. `ui/video.tsx` had an identical one-line copy at
 * its own module scope, written for the same reason and used as `VideoView`'s
 * `hostFetch` default; two wrappers around one global is one of them going
 * stale unnoticed. It lives here because this is the file that talks to the
 * host, and it is at module scope rather than inside a component because
 * `VideoView` names it in a `useCallback` dependency list, where a fresh
 * function on every render would rebuild both ordering handlers on every
 * render.
 */
export const HOST_FETCH: HostFetch = (input, init) => fetch(input, init)

const JSON_FEJLEC = { 'content-type': 'application/json' }

/**
 * A refused host answer, said in the host's own words where it has any.
 *
 * `serviceFail` puts one sentence in `{ error }` and every route above uses
 * it, so that sentence is the thing the operator can act on -- "Agent X is
 * disabled", "message or file is required" -- and a status code alone would
 * throw it away. The body is read ONLY on a refusal, which matters for the
 * chat route: a refused call answers with JSON, an accepted one answers with
 * the turn's `text/event-stream`, and reading that is exactly what this page
 * must not do.
 */
async function refuzaltHostSzoveg(res: HostValasz): Promise<string> {
  let torzs: unknown = null
  try {
    torzs = await res.json()
  } catch {
    torzs = null
  }
  if (isRecord(torzs) && typeof torzs.error === 'string' && torzs.error !== '') return `a host ${res.status}-tal válaszolt: ${torzs.error}`
  return `a host ${res.status}-tal válaszolt, és nem küldött hozzá mondatot`
}

type UgynokKereses =
  | { kind: 'megvan'; agentId: string }
  | { kind: 'ugynokok_olvashatatlanok'; reason: string }
  | { kind: 'nincs_ilyen_ugynok'; agentNev: string }
  | { kind: 'ugynok_letiltva'; agentNev: string }

/**
 * The agent with this display name, or which of the three things went wrong.
 *
 * `GET /api/agents` answers with a MAP -- id to agent -- and not a list, so
 * the search runs over the values. `disabled === true` is the host's own test
 * (`isAgentDisabled`), and it is asked here rather than left to the session
 * call so the refusal can name the agent: the host's 409 arrives as a sentence
 * about starting chats, which is a true statement about the wrong subject.
 */
async function keressUgynokot(fetchImpl: HostFetch, agentNev: string): Promise<UgynokKereses> {
  try {
    const res = await fetchImpl(AGENTS_URL, { credentials: 'same-origin' })
    if (!res.ok) return { kind: 'ugynokok_olvashatatlanok', reason: await refuzaltHostSzoveg(res) }
    const torzs = await res.json()
    if (!isRecord(torzs)) return { kind: 'ugynokok_olvashatatlanok', reason: 'a host nem id → ügynök objektummal válaszolt az ügynök-listára' }
    for (const ugynok of Object.values(torzs)) {
      if (!isRecord(ugynok) || ugynok.name !== agentNev) continue
      if (typeof ugynok.id !== 'string' || ugynok.id === '') return { kind: 'ugynokok_olvashatatlanok', reason: `a host válaszában a(z) "${agentNev}" nevű ügynöknek nincs id-je` }
      if (ugynok.disabled === true) return { kind: 'ugynok_letiltva', agentNev }
      return { kind: 'megvan', agentId: ugynok.id }
    }
    return { kind: 'nincs_ilyen_ugynok', agentNev }
  } catch (err) {
    return { kind: 'ugynokok_olvashatatlanok', reason: errorText(err) }
  }
}

type SessionNyitas =
  | { kind: 'megvan'; sessionId: string }
  | { kind: 'session_nem_nyilt'; reason: string }

/**
 * A new conversation with that agent.
 *
 * `agentId` is the one field this call must carry: the session inherits its
 * provider, model, tools and extensions from the agent, and without it the
 * turn would run with none of the video tools. `name` is the title the
 * operator will look for in the chat list, which is why the caller passes a
 * speaking one rather than letting it default to "New Chat".
 *
 * A new session every time, on purpose. Reusing one would mean holding an id
 * across reloads, and each order is one self-contained instruction that
 * carries every id it needs.
 */
async function nyissSessiont(fetchImpl: HostFetch, agentId: string, sessionNev: string): Promise<SessionNyitas> {
  try {
    const res = await fetchImpl(CHATS_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: JSON_FEJLEC,
      body: JSON.stringify({ agentId, name: sessionNev }),
    })
    if (!res.ok) return { kind: 'session_nem_nyilt', reason: await refuzaltHostSzoveg(res) }
    const torzs = await res.json()
    if (!isRecord(torzs) || typeof torzs.id !== 'string' || torzs.id === '') {
      return { kind: 'session_nem_nyilt', reason: 'a host válaszában nincs session-azonosító, így nincs hova küldeni az utasítást' }
    }
    return { kind: 'megvan', sessionId: torzs.id }
  } catch (err) {
    return { kind: 'session_nem_nyilt', reason: errorText(err) }
  }
}

/**
 * The instruction, and the end of this file's involvement.
 *
 * The answer is `text/event-stream`: the turn writing itself out as it runs.
 * Nothing here reads it. `res.ok` is the whole check, and then the response is
 * let go -- NOT aborted, which is the part that is easy to get wrong: a page
 * that tidied up after itself with an `AbortController` would cut the turn the
 * operator has just paid minutes and money for. The proof the turn worked is
 * the plan or the verdict showing up in the next `video` load.
 */
async function kuldjUzenetet(fetchImpl: HostFetch, agentId: string, sessionId: string, uzenet: string): Promise<Megrendeles> {
  try {
    const res = await fetchImpl(`${CHATS_URL}/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: JSON_FEJLEC,
      body: JSON.stringify({ message: uzenet }),
    })
    if (!res.ok) return { kind: 'uzenet_elutasitva', reason: await refuzaltHostSzoveg(res) }
    return { kind: 'elment', agentId, sessionId }
  } catch (err) {
    return { kind: 'uzenet_elutasitva', reason: errorText(err) }
  }
}

/**
 * Find the agent by name, open a conversation with it, hand it one
 * instruction. Never throws; the caller switches on `kind`.
 *
 * `fetchImpl` IS REQUIRED, and used to carry `HOST_FETCH` as a default. The
 * default was dead: the one caller is `VideoView`, which applies the same
 * default at its own `hostFetch` prop -- that is what makes the ordering
 * handlers testable without a DOM -- so it always passes one, and every test
 * passes a double. A second default here would be a second place for the two
 * to drift apart, on the one parameter whose whole point is that a test can
 * replace it.
 */
export async function rendelj(
  { agentNev, sessionNev, uzenet }: { agentNev: string; sessionNev: string; uzenet: string },
  fetchImpl: HostFetch,
): Promise<Megrendeles> {
  const ugynok = await keressUgynokot(fetchImpl, agentNev)
  if (ugynok.kind !== 'megvan') return ugynok
  const session = await nyissSessiont(fetchImpl, ugynok.agentId, sessionNev)
  if (session.kind !== 'megvan') return session
  return kuldjUzenetet(fetchImpl, ugynok.agentId, session.sessionId, uzenet)
}
