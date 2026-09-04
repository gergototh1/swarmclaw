/**
 * Where Google sends the browser back after consent.
 *
 * Exempt from the access-key check in `src/proxy.ts`, because in the desktop
 * build this request arrives in the user's *system* browser — a different
 * cookie jar from the Electron window that started the flow, so no auth cookie
 * exists to present. The single-use, ten-minute, PKCE-bound `state` is what
 * stands in for it: without one this handler reads no input and writes nothing.
 */

import { NextResponse } from 'next/server'

import { discardGoogleOAuthState, handleGoogleCallback, resolveCallbackOrigin } from '@/lib/server/oauth/google'

export const dynamic = 'force-dynamic'

/** Where to send the browser once a purpose is connected. */
const RETURN_PATH: Record<string, string> = {
  aisignal: '/x/aisignal',
}

/** Google's own error codes are a fixed vocabulary; anything else is not echoed back. */
const KNOWN_CONSENT_ERRORS = new Set([
  'access_denied',
  'admin_policy_enforced',
  'disallowed_useragent',
  'invalid_client',
  'invalid_request',
  'invalid_scope',
  'org_internal',
  'redirect_uri_mismatch',
  'server_error',
  'temporarily_unavailable',
])

function returnUrl(purpose: string, origin: string): URL {
  const path = Object.prototype.hasOwnProperty.call(RETURN_PATH, purpose) ? RETURN_PATH[purpose] : '/home'
  return new URL(`${path}?connected=1`, origin)
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const origin = resolveCallbackOrigin(req)

  // A denied or failed consent comes back with `error` and no `code`. Reported
  // as its own code rather than as a missing parameter, so "I clicked cancel"
  // does not read like a bug in the app.
  const consentError = url.searchParams.get('error') || ''
  if (consentError) {
    // The consent this state was minted for will never complete, so it is dead
    // weight; leaving it would keep it, and its PKCE verifier, alive for the
    // rest of the ten-minute TTL.
    discardGoogleOAuthState(url.searchParams.get('state') || '')
    return NextResponse.json(
      { error: KNOWN_CONSENT_ERRORS.has(consentError) ? consentError : 'oauth_consent_failed' },
      { status: 400 },
    )
  }

  const code = url.searchParams.get('code') || ''
  const state = url.searchParams.get('state') || ''
  if (!code || !state) return NextResponse.json({ error: 'oauth_callback_missing_params' }, { status: 400 })

  try {
    // No `origin` here on purpose: the exchange reuses the one the auth url was
    // built from, so the two redirect_uri strings cannot drift apart.
    const { purpose } = await handleGoogleCallback({ code, state })
    return NextResponse.redirect(returnUrl(purpose, origin), 302)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'oauth_failed' }, { status: 400 })
  }
}
