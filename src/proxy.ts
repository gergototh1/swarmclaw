import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME } from '@/lib/auth'
import {
  buildContentSecurityPolicy,
  contentSecurityPolicyHeaderName,
} from '@/lib/content-security-policy'
import {
  buildExtensionInstallCorsHeaders,
  isExtensionInstallCorsPath,
  resolveExtensionInstallCorsOrigin,
} from '@/lib/extension-install-cors'
import { isDevelopmentLikeRuntime, isProductionRuntime } from '@/lib/runtime/runtime-env'
import { hmrSingleton } from '@/lib/shared-utils'

/* ------------------------------------------------------------------ */
/*  Rate-limit state — HMR-safe via globalThis                        */
/* ------------------------------------------------------------------ */

interface RateLimitEntry {
  count: number
  lockedUntil: number
}

const rateLimitMap = hmrSingleton('__swarmclaw_rate_limit__', () => new Map<string, RateLimitEntry>())

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes
const PRUNE_THRESHOLD = 1000

function isRateLimitEnabled(): boolean {
  return isProductionRuntime()
}

/** Prune expired entries when the map grows too large. */
function pruneRateLimitMap() {
  if (rateLimitMap.size <= PRUNE_THRESHOLD) return
  const now = Date.now()
  rateLimitMap.forEach((entry, ip) => {
    if (entry.lockedUntil < now && entry.count < MAX_ATTEMPTS) {
      rateLimitMap.delete(ip)
    }
  })
}

/** Extract client IP from the request. */
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return (request as unknown as { ip?: string }).ip ?? 'unknown'
}

function withExtensionInstallCorsHeaders(pathname: string, origin: string | null, headers?: HeadersInit): Headers {
  const merged = new Headers(headers)
  if (!isExtensionInstallCorsPath(pathname)) return merged
  const corsHeaders = buildExtensionInstallCorsHeaders(origin)
  new Headers(corsHeaders).forEach((value, key) => {
    merged.set(key, value)
  })
  return merged
}

/* ------------------------------------------------------------------ */
/*  Content-Security-Policy — document requests only                   */
/* ------------------------------------------------------------------ */

/**
 * Enforce the policy instead of only reporting it.
 *
 * Off by default, including in production. The policy is inherited by every
 * `about:srcdoc` frame this app creates, and chat renders agent-authored HTML
 * in exactly such a frame (`components/chat/code-block.tsx`,
 * `components/chat/chat-preview-panel.tsx`), so enforcing `script-src` here
 * also stops inline scripts inside those previews. Until that is resolved an
 * operator opts in per install rather than the app deciding for them.
 */
function isCspEnforced(): boolean {
  return process.env.SWARMCLAW_CSP_ENFORCE === '1'
}

/** True for requests that render an HTML document, which is all the policy governs. */
function isDocumentRequest(pathname: string): boolean {
  return !pathname.startsWith('/api/')
}

/**
 * Pass a document request through with a nonce and the policy attached.
 *
 * The nonce goes on the **request** headers as well as the response, because
 * that is where Next reads it from: `getScriptNonceFromHeader` parses the
 * incoming `Content-Security-Policy` (or `-Report-Only`) header and stamps the
 * nonce onto the framework, bundle and inline-bootstrap script tags it emits.
 * `x-nonce` carries no meaning for Next itself; it is the documented way for
 * app code to reach the same value through `headers()`.
 *
 * API responses deliberately get no policy. `/api/extensions/:id/assets/:path*`
 * already sets its own `Content-Security-Policy: sandbox` on `.svg` bodies plus
 * `X-Content-Type-Options: nosniff` on all of them, and a proxy-set header
 * would collide with the first of those. Nothing under `/api/` returns a
 * document, so there is nothing for a page policy to protect there.
 */
function documentResponse(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID())
  const policy = buildContentSecurityPolicy(nonce, { allowEval: isDevelopmentLikeRuntime() })
  const headerName = contentSecurityPolicyHeaderName(isCspEnforced())

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set(headerName, policy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set(headerName, policy)
  return response
}

/* ------------------------------------------------------------------ */
/*  Proxy                                                              */
/* ------------------------------------------------------------------ */

/** Access key auth proxy with brute-force rate limiting.
 *  Checks X-Access-Key header or auth cookie on all /api/ routes except /api/auth.
 *  The key is validated against the ACCESS_KEY env var.
 *  After 5 failed attempts from a single IP the client is locked out for 15 minutes.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Page requests were never auth-gated here — the matcher simply did not cover
  // them — and they still are not. This branch reproduces the pass-through the
  // old `!pathname.startsWith('/api/')` allowlist gave them and adds the policy.
  if (isDocumentRequest(pathname)) return documentResponse(request)

  const rateLimitEnabled = isRateLimitEnabled()
  const corsOrigin = resolveExtensionInstallCorsOrigin(request.headers.get('origin'))
  const isWebhookTrigger = request.method === 'POST'
    && /^\/api\/webhooks\/[^/]+\/?$/.test(pathname)
  const isConnectorWebhook = request.method === 'POST'
    && /^\/api\/connectors\/[^/]+\/webhook\/?$/.test(pathname)

  if (request.method === 'OPTIONS' && isExtensionInstallCorsPath(pathname)) {
    if (!corsOrigin) {
      return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
    }
    return new NextResponse(null, {
      status: 204,
      headers: buildExtensionInstallCorsHeaders(corsOrigin),
    })
  }

  // A2A endpoints use their own authentication (Authorization: Bearer / x-a2a-access-key)
  const isA2ARoute = pathname === '/api/a2a'
    || pathname.startsWith('/api/a2a/')
    || pathname === '/api/.well-known/agent-card'

  // Only protect API routes (not auth, inbound webhooks, or A2A). Everything
  // reaching this point is under /api/; the document branch returned already.
  if (
    pathname === '/api/auth'
    || pathname === '/api/healthz'
    || isWebhookTrigger
    || isConnectorWebhook
    || isA2ARoute
  ) {
    return NextResponse.next()
  }

  const accessKey = process.env.ACCESS_KEY
  if (!accessKey) {
    // No key configured — allow all (dev mode)
    return NextResponse.next()
  }

  // --- Rate-limit housekeeping ---
  if (rateLimitEnabled) pruneRateLimitMap()

  const clientIp = getClientIp(request)
  const entry = rateLimitEnabled ? rateLimitMap.get(clientIp) : undefined

  // Check lockout before even validating the key
  if (rateLimitEnabled && entry && entry.lockedUntil > Date.now()) {
    const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    return NextResponse.json(
      { error: 'Too many failed attempts. Try again later.', retryAfter },
      {
        status: 429,
        headers: withExtensionInstallCorsHeaders(pathname, corsOrigin, { 'Retry-After': String(retryAfter) }),
      },
    )
  }

  const cookieKey = request.cookies.get(AUTH_COOKIE_NAME)?.value?.trim() || ''
  const headerKey = request.headers.get('x-access-key')?.trim() || ''
  const providedKey = cookieKey || headerKey

  if (providedKey !== accessKey) {
    let remaining = MAX_ATTEMPTS
    if (rateLimitEnabled) {
      const current = rateLimitMap.get(clientIp) ?? { count: 0, lockedUntil: 0 }
      current.count += 1

      if (current.count >= MAX_ATTEMPTS) {
        current.lockedUntil = Date.now() + LOCKOUT_MS
      }

      rateLimitMap.set(clientIp, current)
      remaining = Math.max(0, MAX_ATTEMPTS - current.count)
    }
    return NextResponse.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: withExtensionInstallCorsHeaders(pathname, corsOrigin, { 'X-RateLimit-Remaining': String(remaining) }),
      },
    )
  }

  // Successful auth — clear any prior failed-attempt tracking for this IP
  if (rateLimitEnabled && entry) {
    rateLimitMap.delete(clientIp)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Access-key auth. Kept as its own entry so no header condition can ever
    // let an API request skip the check.
    '/api/:path*',
    // Content-Security-Policy on document requests. `_next/static`,
    // `_next/image` and the favicon are subresources that carry no scripts of
    // their own, and an RSC prefetch is a payload rather than a document, so
    // none of them needs the header.
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
