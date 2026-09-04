import { NextResponse } from 'next/server'
import { getExtensionManager } from '@/lib/server/extensions'
import { log } from '@/lib/server/logger'

export const dynamic = 'force-dynamic'

/**
 * One failure body, carrying the same text twice on purpose.
 *
 * `error` is the structured shape the rest of the API uses. `message` repeats
 * it at the top level because that is the only half a browser caller can read:
 * `api()` (`src/lib/app/api-client.ts`) takes `payload.error` only when it is a
 * string, and otherwise falls back to a top-level `payload.message`. Without
 * this field every failure below reaches the extension author who is debugging
 * their own handler as `Request failed (<status>)`, with the real reason left
 * on the wire and in the server log. Widening `api()` instead would change the
 * error text of every route in the app that answers with this shape.
 */
function rpcFailure(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message }, message }, { status })
}

/**
 * POST /api/extensions/:id/call/:method
 *
 * The one way an extension's browser page reaches its own server-side code.
 * `window.swarmclaw.rpc(extensionId, method, body)`
 * (`src/components/layout/extension-host.tsx`) posts here, and the handler's
 * return value comes back as the JSON body.
 *
 * **The `:id` in the URL says which extension to run, not who is calling.**
 * Every extension bundle on a page shares one browser origin and one
 * `window.swarmclaw`, so any loaded bundle can pass any other extension's id
 * here and invoke its methods. Nothing in this route can tell the two apart —
 * a browser request carries no proof of which script composed it. That is
 * accepted, because extensions are trusted same-process code that could
 * already reach each other's data on the server. Do not add a check here that
 * pretends otherwise, and do not build a permission model on top of `:id` as
 * though it identified the caller.
 *
 * Authentication is the app-wide access-key check in `src/proxy.ts`: the
 * `/api/:path*` matcher covers this path, and it is not in the exempt list
 * (`/api/auth`, `/api/healthz`, inbound webhooks, A2A), so an unauthenticated
 * request is refused with 401 before it ever reaches this file.
 *
 * Statuses: 404 when no such method is callable, 400 when the body is not a
 * JSON object, 500 when the handler throws, 200 otherwise. Every failure body
 * is `{ error: { code, message }, message }` — see `rpcFailure` for why the
 * text appears twice.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; method: string }> }) {
  const { id, method } = await params

  // One 404 for "no such extension", "extension disabled", "no rpc map" and
  // "no such method". The caller gets no way to enumerate what is installed —
  // which holds only because `getRpcHandler` matches own properties of the
  // `rpc` map, so an inherited name like `constructor` is a 404 here exactly as
  // it is for an extension that was never installed.
  const handler = getExtensionManager().getRpcHandler(id, method)
  if (!handler) {
    return rpcFailure(404, 'not_found', `no rpc method "${method}" on extension "${id}"`)
  }

  let body: Record<string, unknown> = {}
  try {
    const text = await req.text()
    // An absent body is an empty object rather than a 400: a handler that takes
    // no arguments should be callable without ceremony.
    const parsed: unknown = text ? JSON.parse(text) : {}
    // Handlers are typed `(body: Record<string, unknown>) => ...`, so an array
    // or a bare `null`/number/string has to be refused rather than passed on.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object')
    }
    body = parsed as Record<string, unknown>
  } catch (err) {
    return rpcFailure(400, 'bad_request', err instanceof Error ? err.message : 'invalid JSON')
  }

  try {
    const result = await handler(body)
    // `NextResponse.json` serialises eagerly, so it stays inside this `try`: a
    // handler that returns something unserialisable (a cycle, a BigInt) becomes
    // the same 500 as one that threw, rather than an unhandled route crash.
    // Only `undefined` becomes `{}`: JSON cannot carry it, and an empty 200 body
    // would make the browser caller throw on parse instead of resolving to
    // "nothing to report". `null` is a value a handler can mean — "looked, found
    // nothing" — and JSON carries it, so it round-trips as itself.
    return NextResponse.json(result === undefined ? {} : result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('extension-rpc', `${id}.${method} failed`, { message })
    return rpcFailure(500, 'internal', message)
  }
}
