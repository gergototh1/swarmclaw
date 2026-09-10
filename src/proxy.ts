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
  /** When the most recent failed attempt landed, so old failures can age out. */
  lastFailureAt: number
}

const rateLimitMap = hmrSingleton('__swarmclaw_rate_limit__', () => new Map<string, RateLimitEntry>())

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes
// Failures older than this stop counting toward the budget. Without it the
// count only ever fell back to zero on a successful auth, so the first miss
// after a lockout expired re-locked the bucket for another 15 minutes, and a
// client that never gets its key right keeps an IP locked forever.
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const PRUNE_THRESHOLD = 1000

function isRateLimitEnabled(): boolean {
  return isProductionRuntime()
}

/** Prune expired entries when the map grows too large. */
function pruneRateLimitMap() {
  if (rateLimitMap.size <= PRUNE_THRESHOLD) return
  const now = Date.now()
  rateLimitMap.forEach((entry, ip) => {
    const lockExpired = entry.lockedUntil < now
    const failuresAgedOut = now - entry.lastFailureAt >= FAILURE_WINDOW_MS
    if (lockExpired && failuresAgedOut) {
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
 * Off by default, including in production. **Two** things in the app break
 * under an enforcing `script-src`, both for the same reason: a document loaded
 * from a local scheme inherits the CSP of the document that created it, and
 * neither of these carries this request's nonce. Fixing either one is its own
 * task; neither is fixed here. Whoever flips this flag has to handle both.
 *
 * 1. **`about:srcdoc` chat previews.** Chat renders agent-authored HTML in
 *    `srcdoc` iframes: `src/components/chat/code-block.tsx` (the inline preview)
 *    and `src/components/chat/chat-preview-panel.tsx`. Inline `<script>` inside
 *    those frames stops running. Confirmed in Chrome.
 * 2. **`blob:` "Open in new tab".** `handleOpenTab` in
 *    `src/components/chat/code-block.tsx` wraps the same agent-authored code in
 *    a `Blob` of `text/html` (or `image/svg+xml`) and `window.open`s the object
 *    URL. A `blob:` document inherits its creator's policy exactly the same
 *    way, so that tab loses its inline scripts too — in a new window, where
 *    nobody is watching a console.
 *
 * One further behaviour appears the moment this flips, deliberately rather than
 * as a break: `frame-ancestors 'none'` starts being honoured. A browser ignores
 * `frame-ancestors` in a report-only policy, so today it is inert; enforcing it
 * means `/s/<token>` share pages can no longer be embedded in an iframe
 * anywhere. That is the intended posture — a share link is a public, revocable,
 * read-only page (`src/app/s/[token]/page.tsx`) that promises no embedding
 * contract in either direction — but it is visible to anyone who was framing
 * one. Allowing it again means giving that route its own policy, not loosening
 * this one for the whole app.
 */
function isCspEnforced(): boolean {
  return process.env.SWARMCLAW_CSP_ENFORCE === '1'
}

/**
 * Path prefixes that never serve an HTML document.
 *
 * `/api/` is this app's route handlers. `/.well-known/` is the public A2A
 * discovery endpoint (`src/app/.well-known/agent-card.json/route.ts`), fetched
 * as `application/json` by remote agents. `/_next/` is framework output. The
 * matcher below already skips most of these; the list is repeated here so the
 * decision holds no matter what invokes this module.
 */
const NON_DOCUMENT_PREFIXES = ['/api/', '/.well-known/', '/_next/']

/**
 * Path prefixes that always serve an HTML document, no matter what the dot
 * rule below thinks. `/x/` is the extension-page catch-all
 * (`src/app/x/[[...slug]]/page.tsx`), an *optional catch-all route* that
 * matches every path under it, dots included. `PATH_RE` in
 * `lib/server/extensions/extension-pages.ts` only validates what an
 * extension's `ui.pages` manifest may *declare* — it says nothing about what
 * the route *matches*. So `/x/foo.json` still renders this app's own document
 * HTML (the "no extension owns this page" message, same component tree as a
 * real extension page), and the dot rule alone would misread it as a file and
 * ship it with no policy at all. This app never serves a real static file
 * under `/x/`, so the override is unconditional.
 */
const DOCUMENT_PREFIXES = ['/x/']

/**
 * True for requests that render an HTML document, which is all the policy governs.
 *
 * Keyed on the path rather than on the `Sec-Fetch-Dest: document` request
 * header. The path is server-side data that every client produces, while
 * fetch-metadata headers are absent from older browsers, from non-browser
 * clients, and from anything behind a header-stripping proxy — all of which
 * would silently lose the policy on real pages. The path is also assertable in
 * a unit test without synthesising browser headers.
 *
 * Every *declared* page route in this app is extensionless: `/home`,
 * `/agents/<uuid>`, `/s/<base64url token>`, and the `/x/<slug>` a manifest may
 * register, where the slug is validated as `[a-z0-9][a-z0-9-]*`
 * (`lib/server/extensions/extension-pages.ts`). But `/x/` is served by an
 * optional catch-all, which matches at that prefix regardless of what follows
 * — see `DOCUMENT_PREFIXES` above, which this function checks before the dot
 * rule gets a vote. Everything served out of `public/` and `src/app/icon.svg`
 * has an extension, so outside `/x/`, "a dot in the last segment" is still a
 * reliable "file, not page" test, and it keeps covering assets dropped into
 * `public/` later without listing every directory in there.
 *
 * What it cannot see: a future non-`/api/` route handler at an extensionless
 * path that returns something other than a document. Add its prefix to
 * NON_DOCUMENT_PREFIXES when one appears.
 *
 * Next's own not-found page at a dotted, non-`/x/` path (e.g. `/nope.json`) is
 * misread as a file by the same dot rule, and that miss is not fixed here.
 * Telling it apart from a real dotted file in `public/` needs to know whether
 * the path resolved to an actual asset, and this function runs before Next has
 * looked — that information does not exist yet at this point. Closing the gap
 * without that information would mean dropping the dot rule outside `/x/`
 * entirely, which would also wrap every asset in `public/` (all of which have
 * extensions) in a document policy, breaking the "static asset still does not
 * get a policy" guarantee. The generic not-found page renders no
 * user-controlled content, so unlike `/x/<slug>` there is nothing there for an
 * injected `<script>` to ride in on — the miss is accepted rather than fixed.
 */
function isDocumentRequest(pathname: string): boolean {
  if (NON_DOCUMENT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  if (DOCUMENT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  return !pathname.slice(pathname.lastIndexOf('/') + 1).includes('.')
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
 * Only documents get here. `/api/extensions/:id/assets/:path*` already sets its
 * own `Content-Security-Policy: sandbox` on `.svg` bodies plus
 * `X-Content-Type-Options: nosniff` on all of them, and a proxy-set header
 * would collide with the first of those. Nothing under `/api/`, `/.well-known/`
 * or `public/` returns a document, so a page policy has nothing to protect
 * there and would only be a header a future JSON body inherits by accident.
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
 *  Checks X-Access-Key header or auth cookie on all /api/ routes except /api/auth
 *  and the Google OAuth callback.
 *  The key is validated against the ACCESS_KEY env var.
 *  After 5 failed attempts inside 15 minutes from a single IP, that IP is locked
 *  out for 15 minutes. The lockout is applied only to requests that fail
 *  validation: a request carrying the correct key is never answered with a 429.
 *  See the note at the check below for why.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Page requests were never auth-gated here — the matcher simply did not cover
  // them — and they still are not. This branch reproduces the pass-through the
  // old `!pathname.startsWith('/api/')` allowlist gave them. Documents also pick
  // up the policy; static assets and `/.well-known/` pass through untouched, so
  // they neither carry a page CSP nor fall into the access-key check below.
  if (!pathname.startsWith('/api/')) {
    return isDocumentRequest(pathname) ? documentResponse(request) : NextResponse.next()
  }

  const rateLimitEnabled = isRateLimitEnabled()
  const corsOrigin = resolveExtensionInstallCorsOrigin(request.headers.get('origin'))
  const isWebhookTrigger = request.method === 'POST'
    && /^\/api\/webhooks\/[^/]+\/?$/.test(pathname)
  const isConnectorWebhook = request.method === 'POST'
    && /^\/api\/connectors\/[^/]+\/webhook\/?$/.test(pathname)
  // Google redirects the *browser* here after consent, and in the desktop build
  // that browser is the system one — a different cookie jar from the Electron
  // window that started the flow, so there is no auth cookie to present and no
  // way to add one. Only this exact path, and only GET; `/api/oauth/google/start`
  // stays gated, so a `state` can only be minted by someone already signed in.
  // The handler reads nothing but `code` and `state`, and rejects any `state`
  // that is not one of those single-use, ten-minute, PKCE-bound values.
  const isGoogleOAuthCallback = request.method === 'GET'
    && pathname === '/api/oauth/google/callback'

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
    || isGoogleOAuthCallback
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

  const cookieKey = request.cookies.get(AUTH_COOKIE_NAME)?.value?.trim() || ''
  const headerKey = request.headers.get('x-access-key')?.trim() || ''
  const providedKey = cookieKey || headerKey

  // The key is validated *before* the lockout is consulted, and the lockout is
  // consulted only on the failing branch. The bucket is keyed by source IP, and
  // in the desktop build every client shares 127.0.0.1 — so gating a valid key
  // on the bucket let one misconfigured local program answer the Electron
  // window's own requests with a 429 for 15 minutes at a time. Nothing is given
  // away by letting a correct key through: an attacker who already holds the key
  // has won regardless of how many wrong guesses preceded it, and every wrong
  // guess still lands in the branch below.
  if (providedKey !== accessKey) {
    let remaining = MAX_ATTEMPTS
    if (rateLimitEnabled) {
      const now = Date.now()
      const entry = rateLimitMap.get(clientIp)

      if (entry && entry.lockedUntil > now) {
        const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000)
        return NextResponse.json(
          { error: 'Too many failed attempts. Try again later.', retryAfter },
          {
            status: 429,
            headers: withExtensionInstallCorsHeaders(pathname, corsOrigin, { 'Retry-After': String(retryAfter) }),
          },
        )
      }

      // A bucket whose last failure is older than the window starts over, so an
      // expired lockout hands back a full budget instead of re-locking on the
      // very next miss.
      const current = entry && now - entry.lastFailureAt < FAILURE_WINDOW_MS
        ? entry
        : { count: 0, lockedUntil: 0, lastFailureAt: 0 }

      current.count += 1
      current.lastFailureAt = now
      if (current.count >= MAX_ATTEMPTS) {
        current.lockedUntil = now + LOCKOUT_MS
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
  if (rateLimitEnabled) {
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
    // their own, `.well-known` is the public A2A agent card served as JSON to
    // remote agents, and an RSC prefetch is a payload rather than a document,
    // so none of them needs the header. `isDocumentRequest` above repeats the
    // `.well-known` exclusion and adds the extension rule for `public/` assets;
    // that function, not this regex, is the authority.
    //
    // Each alternative is anchored to a full path segment (`(?:/|$)`) and its
    // dots are escaped. This is the gate that decides whether the proxy module
    // runs at all — unlike `isDocumentRequest`, which only decides what happens
    // once it does — so an unanchored prefix test here is the more dangerous
    // version of the same mistake: without the anchor, `api` as a bare
    // alternative also matches the start of `/apiary`, and an unescaped `.` in
    // `favicon.ico` or `.well-known` matches any character, so `/faviconXico`
    // and `/Xwell-known/...` would silently skip the proxy too. No such route
    // exists in this app today, but the fix does not depend on that staying true.
    {
      source: '/((?!api(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico(?:/|$)|\\.well-known(?:/|$)).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
