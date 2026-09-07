/**
 * Begin a Google consent flow.
 *
 * Stays behind the access key on purpose (see `src/proxy.ts`): only someone who
 * is already signed in to this app may mint a `state`, and the callback accepts
 * nothing else.
 */

import { NextResponse } from 'next/server'

import { buildGoogleAuthUrl, resolveCallbackOrigin, resolveGoogleDeployMode, type GoogleDeployMode } from '@/lib/server/oauth/google'

export const dynamic = 'force-dynamic'

/**
 * Purposes this app is willing to ask for, and the scopes each may request.
 * A purpose that is not listed gets no consent URL, so a caller cannot widen
 * the grant by inventing one.
 */
const SCOPES: Record<string, string[]> = {
  aisignal: ['https://www.googleapis.com/auth/gmail.readonly'],
  // The smallest single scope that covers reading, searching, drafting,
  // sending a draft and labelling. Labelling is what forces it: applying a
  // label is users.messages.modify, which neither gmail.readonly nor
  // gmail.compose covers. Asking for three narrower scopes alongside it would
  // narrow nothing -- Google grants the union -- and would only put three
  // sentences on the consent screen instead of one.
  //
  // What is deliberately absent: https://mail.google.com/ and gmail.settings.*
  // A token minted for this purpose therefore cannot permanently delete a
  // message or change a mailbox setting, however badly this app misbehaves. It
  // can move a message to the trash, which gmail.modify does cover; that is
  // reversible by the account's owner, permanent deletion is not.
  //
  // STILL UNRECORDED AS OF 2026-09-05, and recorded as unrecorded rather than
  // guessed: the wording Google actually puts on the consent screen for
  // gmail.modify, and whether an unverified project is allowed through it at
  // all (design spec 14, first open point). gmail.modify is a restricted
  // scope, so the app is expected to hit either the unverified-app warning or
  // a block, and which one decides whether an operator can connect a mailbox
  // without going through Google's verification. Nobody has run the flow: the
  // deploy verification of 2026-09-05 covered both deployments without making
  // a single Google request. The first operator to connect a mailbox should
  // paste the screen's own sentence here with the date.
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  // The smallest single scope that inserts a video, and it INSERTS AND
  // NOTHING ELSE. YouTube Data API v3's own scope table accepts
  // youtube.upload for videos.insert alone: videos.update and videos.delete
  // both require youtube or youtube.force-ssl, so a token minted for this
  // purpose cannot edit or remove a video even if this app asked it to --
  // not the uploaded one, and not any other. Deliberately absent are
  // `youtube` (full read/write access to the channel: playlists,
  // subscriptions, comments) and `youtube.force-ssl` (the same, over a scope
  // Google requires for a few additional write calls this app never makes).
  //
  // STILL UNRECORDED AS OF 2026-09-07, and recorded as unrecorded rather than
  // guessed, exactly as the gmail entry above does: nobody has run this flow
  // either. youtube.upload is a sensitive scope with its own verification
  // question, so what is unknown here is the wording Google puts on the
  // consent screen for it, whether an unverified project is let through, and
  // whether the 1600-unit-per-upload cost and 10000-unit daily quota that
  // extensions/publish/src/platform/youtube.mjs refuses from are the numbers
  // a real response actually reports. The first operator to connect a channel
  // should paste the screen's own sentence here with the date.
  publish: ['https://www.googleapis.com/auth/youtube.upload'],
}

/**
 * What the operator has to create, named per deploy mode. Variable *names*
 * only: no value read from the environment is ever put in this response, and
 * the two client types are not interchangeable -- a desktop build picks a fresh
 * loopback port each launch, so it has no fixed redirect URI a Web client could
 * have registered.
 */
const CLIENT_SETUP_HINT: Record<GoogleDeployMode, string> = {
  desktop:
    'Create a Google Cloud OAuth client of type "Desktop app", then set GOOGLE_OAUTH_CLIENT_DESKTOP_ID and GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET and restart the host.',
  vps:
    'Create a Google Cloud OAuth client of type "Web application" with this origin plus /api/oauth/google/callback registered as a redirect URI, then set GOOGLE_OAUTH_CLIENT_WEB_ID and GOOGLE_OAUTH_CLIENT_WEB_SECRET and restart the host.',
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
    const message = err instanceof Error ? err.message : 'oauth_failed'
    // A missing client is the operator's own configuration, not a server fault,
    // and it is the one failure here with a fixed remedy. 409 so a caller can
    // tell it apart from a real 500 and disable its connect control with a
    // sentence rather than sending someone to a blank tab; `mode` and `detail`
    // so an operator who reached this URL directly reads what to create instead
    // of a bare code.
    if (message === 'google_oauth_client_missing') {
      const mode = resolveGoogleDeployMode()
      return NextResponse.json({ error: message, mode, detail: CLIENT_SETUP_HINT[mode] }, { status: 409 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
