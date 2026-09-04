import { NextResponse } from 'next/server'
import { getExtensionManager } from '@/lib/server/extensions'
import { log } from '@/lib/server/logger'

export const dynamic = 'force-dynamic'

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
 * JSON object, 500 when the handler throws, 200 otherwise.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; method: string }> }) {
  const { id, method } = await params

  // One 404 for "no such extension", "extension disabled", "no rpc map" and
  // "no such method". The caller gets no way to enumerate what is installed.
  const handler = getExtensionManager().getRpcHandler(id, method)
  if (!handler) {
    return NextResponse.json(
      { error: { code: 'not_found', message: `no rpc method "${method}" on extension "${id}"` } },
      { status: 404 },
    )
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
    return NextResponse.json(
      { error: { code: 'bad_request', message: err instanceof Error ? err.message : 'invalid JSON' } },
      { status: 400 },
    )
  }

  try {
    const result = await handler(body)
    // `NextResponse.json` serialises eagerly, so it stays inside this `try`: a
    // handler that returns something unserialisable (a cycle, a BigInt) becomes
    // the same 500 as one that threw, rather than an unhandled route crash.
    // `?? {}` keeps the response parseable for a handler that returns nothing —
    // the browser caller parses the body as JSON either way.
    return NextResponse.json(result ?? {})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('extension-rpc', `${id}.${method} failed`, { message })
    return NextResponse.json({ error: { code: 'internal', message } }, { status: 500 })
  }
}
