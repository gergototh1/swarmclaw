/**
 * Begin a Google consent flow.
 *
 * Stays behind the access key on purpose (see `src/proxy.ts`): only someone who
 * is already signed in to this app may mint a `state`, and the callback accepts
 * nothing else.
 */

import { NextResponse } from 'next/server'

import { buildGoogleAuthUrl, resolveCallbackOrigin } from '@/lib/server/oauth/google'

export const dynamic = 'force-dynamic'

/**
 * Purposes this app is willing to ask for, and the scopes each may request.
 * A purpose that is not listed gets no consent URL, so a caller cannot widen
 * the grant by inventing one.
 */
const SCOPES: Record<string, string[]> = {
  aisignal: ['https://www.googleapis.com/auth/gmail.readonly'],
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const purpose = url.searchParams.get('purpose') || ''
  const scopes = Object.prototype.hasOwnProperty.call(SCOPES, purpose) ? SCOPES[purpose] : null
  if (!scopes) return NextResponse.json({ error: 'unknown purpose' }, { status: 400 })

  try {
    const { url: authUrl } = buildGoogleAuthUrl({ purpose, origin: resolveCallbackOrigin(req), scopes })
    return NextResponse.redirect(authUrl, 302)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'oauth_failed' }, { status: 500 })
  }
}
