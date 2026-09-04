/**
 * Google OAuth: consent, callback, and refresh.
 *
 * Replaces the Task 7 stub. `getGoogleAccessToken` and `hasGoogleCredential`
 * keep their names and their unconfigured-error contract because `setup(ctx)`
 * already hands both to extensions through `ctx.oauth`.
 *
 * **Two deployments, two clients.** On a VPS the app answers on one fixed
 * public origin, so a Google "Web application" client with that exact redirect
 * URI registered is the right thing. In the Electron desktop app the server
 * binds `127.0.0.1` on whatever port `findFreePort` handed it that launch
 * (`electron/server-lifecycle.ts`), so no fixed redirect URI exists to
 * register and a Web client cannot be used at all. A "Desktop app" client can:
 * Google matches loopback redirect URIs ignoring the port, per RFC 8252 §7.3.
 * `SWARMCLAW_DEPLOY_MODE` picks the pair; the redirect URI is built from the
 * origin the request actually arrived on, which is what makes the varying port
 * work. A VPS has no varying port and already knows its own registered origin,
 * so `SWARMCLAW_PUBLIC_ORIGIN` (for example `https://app.example.com`) overrides
 * that derivation when it is set. Set it on any deployment behind a reverse
 * proxy: nginx's default `proxy_pass` sends the *upstream* address as `Host`,
 * which would otherwise be baked into the redirect URI. In desktop mode it is
 * ignored outright rather than merely left unset, because a stray value there
 * can only name an origin the loopback callback will never arrive on.
 *
 * **What is stored.** Only the refresh token, encrypted, in the credential
 * table under `google-oauth:<purpose>`. Access tokens live in memory until they
 * expire. Neither is logged, and neither is returned in a response body. The one
 * place that reads every credential and writes the plaintext to disk,
 * `pushCredentialsToOpenClaw` in `src/lib/server/openclaw/sync.ts`, skips
 * `google-oauth` rows for exactly that reason.
 *
 * **Disconnecting.** The in-memory access token is a shortcut past a refresh
 * round trip, never past the credential store: every read re-checks that the
 * stored refresh token is still there. A deletion made in this process — the
 * repository delete, and the credential service delete behind
 * `DELETE /api/credentials/:id` — invalidates the credentials cache with it, so
 * access stops on the next call rather than up to an hour later. Two cases fall
 * outside that. A row removed from the database by something other than this
 * process is only noticed once the 90 second credentials cache expires. And a
 * refresh already in flight when the deletion lands still resolves, handing its
 * token to the caller that asked before the delete.
 *
 * **Disconnecting is not revoking.** Nothing here calls Google's `/revoke`
 * endpoint, so the refresh token stays valid at Google until the user withdraws
 * access in their own account settings. What a delete stops is issuance: this
 * app no longer holds a token to present and cannot mint another without a fresh
 * consent, which is the chokepoint that matters. UI copy should say the account
 * was disconnected here, not that access was revoked at Google.
 */

import crypto from 'node:crypto'

import { loadCredential, saveCredential } from '@/lib/server/credentials/credential-repository'
import { log } from '@/lib/server/logger'
import { decryptKey, encryptKey } from '@/lib/server/storage'
import { hmrSingleton } from '@/lib/shared-utils'

const TAG = 'google-oauth'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CALLBACK_PATH = '/api/oauth/google/callback'

/** How long a consent may sit unfinished before its state stops being accepted. */
const STATE_TTL_MS = 10 * 60 * 1000
/** Renew this far before expiry rather than handing out a token about to die. */
const ACCESS_TOKEN_SKEW_MS = 30_000
/** Google always sends `expires_in`; this is only a floor if it ever stops. */
const DEFAULT_ACCESS_TTL_S = 3600

export type FetchImpl = typeof fetch
export type GoogleDeployMode = 'desktop' | 'vps'

export interface GoogleOAuthClient {
  id: string
  secret: string
  mode: GoogleDeployMode
}

interface PendingState {
  purpose: string
  /** PKCE verifier, kept server-side; only its SHA-256 ever leaves this process. */
  verifier: string
  /**
   * The origin the authorization request's `redirect_uri` was built from.
   * Remembered rather than recomputed from the callback request, because Google
   * compares the two `redirect_uri` strings byte for byte and the callback is a
   * second request whose headers a proxy need not reproduce identically.
   */
  origin: string
  expiresAt: number
}

interface CachedAccessToken {
  token: string
  expiresAt: number
}

/**
 * The error `setup(ctx)` consumers already catch by name. Task 7 introduced it
 * for the stub; it now means specifically "no client id/secret in the
 * environment", which is still the one condition an extension author can do
 * nothing about at runtime and an operator can fix in a minute.
 */
export class GoogleOAuthNotConfiguredError extends Error {
  readonly purpose: string

  constructor(purpose: string) {
    super(`Google OAuth is not configured, so no access token can be issued for "${purpose}".`)
    this.name = 'GoogleOAuthNotConfiguredError'
    this.purpose = purpose
  }
}

const pendingStates = hmrSingleton('googleOauth_pendingStates', () => new Map<string, PendingState>())
const accessCache = hmrSingleton('googleOauth_accessCache', () => new Map<string, CachedAccessToken>())
/**
 * One in-flight refresh per credential. Without this, an extension that fires
 * several Gmail calls at once sends the same refresh token to Google several
 * times over, which is pure waste and counts against the per-client rate limit.
 * Entries are removed when the request settles, so a failure does not stick.
 */
const refreshInFlight = hmrSingleton('googleOauth_refreshInFlight', () => new Map<string, Promise<string>>())

function envValue(name: string): string {
  const raw = process.env[name]
  return typeof raw === 'string' ? raw.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** `desktop` only when asked for explicitly; a VPS is the deployment that has a fixed origin. */
export function resolveGoogleDeployMode(): GoogleDeployMode {
  return envValue('SWARMCLAW_DEPLOY_MODE') === 'desktop' ? 'desktop' : 'vps'
}

function resolveGoogleClientOrNull(): GoogleOAuthClient | null {
  const mode = resolveGoogleDeployMode()
  const id = mode === 'desktop' ? envValue('GOOGLE_OAUTH_CLIENT_DESKTOP_ID') : envValue('GOOGLE_OAUTH_CLIENT_WEB_ID')
  const secret = mode === 'desktop' ? envValue('GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET') : envValue('GOOGLE_OAUTH_CLIENT_WEB_SECRET')
  if (!id || !secret) return null
  return { id, secret, mode }
}

export function resolveGoogleClient(): GoogleOAuthClient {
  const client = resolveGoogleClientOrNull()
  if (!client) throw new Error('google_oauth_client_missing')
  return client
}

export function credentialIdFor(purpose: string): string {
  return `google-oauth:${purpose}`
}

/** `protocol//host` if the Host header parses as nothing but a host, else `''`. */
function originFromHostHeader(protocol: string, hostHeader: string): string {
  try {
    const url = new URL(`${protocol}//${hostHeader}`)
    // A Host header carries authority and nothing else. Anything that parsed
    // into a path, a query, or credentials was not a host header.
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

/**
 * The origin to build the redirect URI from, for both the consent request and
 * the token exchange — Google requires those two to be byte-identical.
 *
 * **Why not `new URL(request.url).origin`.** Next does not build that URL from
 * the request. `attachRequestMeta` in `next/dist/server/next-server.js` composes
 * it as `${protocol}://${this.fetchHostname}:${this.port}`, where the hostname
 * is the one the server was *started* with, unless `experimental.trustHostHeader`
 * is on (it is not). In the desktop build that is `127.0.0.1` and happens to be
 * right. In the Docker image `HOSTNAME=0.0.0.0`, so the origin would come out as
 * `http://0.0.0.0:3456` and Google would reject the redirect URI outright.
 *
 * So the host is read from the `Host` header, which is what the browser actually
 * asked for and what a reverse proxy is configured to pass through, and the
 * scheme from `X-Forwarded-Proto`, which is the one thing a TLS-terminating
 * proxy knows and the app cannot. `X-Forwarded-Host` is deliberately *not*
 * consulted — that is the header a request can carry through an unaware proxy.
 *
 * An operator who knows the public origin should not rely on any of that:
 * `SWARMCLAW_PUBLIC_ORIGIN` is consulted first and wins outright. A Web client
 * only works with an exactly registered redirect URI, so on a VPS that origin is
 * already a fixed, known string, and nginx's default `proxy_pass` does not even
 * forward the browser's `Host`. A value that is not a plain `http`/`https`
 * origin is ignored rather than half-used, and the header path below applies.
 *
 * Desktop mode does not consult it at all. There the server picks a fresh
 * loopback port each launch, so any fixed origin is the wrong one; honouring a
 * value that happened to be exported in the user's shell would build a redirect
 * URI pointing somewhere else entirely and the callback would never arrive.
 *
 * Forging `Host` gains nothing: `/api/oauth/google/start` is access-key gated, so
 * only a signed-in caller reaches this, and Google matches the redirect URI
 * against the client's own registration — an exact registered URI for a Web
 * client, loopback only for a Desktop one. Neither accepts an attacker's host.
 */
export function resolveCallbackOrigin(request: Request): string {
  const configured = resolveGoogleDeployMode() === 'desktop' ? '' : envValue('SWARMCLAW_PUBLIC_ORIGIN')
  if (configured) {
    const origin = parsePublicOrigin(configured)
    if (origin) return origin
    log.warn(TAG, 'SWARMCLAW_PUBLIC_ORIGIN is not a plain http or https origin, so it was ignored.')
  }

  const requestUrl = new URL(request.url)
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const protocol = forwardedProto === 'https' || forwardedProto === 'http'
    ? `${forwardedProto}:`
    : requestUrl.protocol

  const hostHeader = request.headers.get('host')?.split(',')[0]?.trim() || ''
  return (hostHeader && originFromHostHeader(protocol, hostHeader)) || `${protocol}//${requestUrl.host}`
}

/** An `http(s)` origin and nothing else, or `''` for anything this cannot trust. */
function parsePublicOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    // Scheme, host and port are all a redirect URI may take from this value;
    // a path, query or credentials means the operator meant something else.
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

function dropExpiredStates(now: number): void {
  for (const [key, value] of pendingStates) {
    if (value.expiresAt < now) pendingStates.delete(key)
  }
}

export function buildGoogleAuthUrl(opts: { purpose: string; origin: string; scopes: string[] }): { url: string; state: string } {
  const client = resolveGoogleClient()
  const now = Date.now()
  dropExpiredStates(now)

  const state = crypto.randomBytes(24).toString('base64url')
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  pendingStates.set(state, { purpose: opts.purpose, verifier, origin: opts.origin, expiresAt: now + STATE_TTL_MS })

  const query = new URLSearchParams({
    client_id: client.id,
    redirect_uri: opts.origin + CALLBACK_PATH,
    response_type: 'code',
    scope: opts.scopes.join(' '),
    access_type: 'offline',
    // Without this Google withholds the refresh token on every consent after
    // the first, and the app has no way to act on the account later.
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })

  return { url: `${AUTH_URL}?${query.toString()}`, state }
}

/**
 * `invalidGrantError` is a parameter because `invalid_grant` means something
 * different on each grant type, and the two are not interchangeable to a user:
 * on a refresh the stored token really was revoked or expired, while on an
 * authorization-code exchange it means the code was already used, timed out, or
 * the two `redirect_uri` strings did not match — none of which the user can fix
 * by re-granting access they may never have granted in the first place.
 */
async function postToken(params: Record<string, string>, fetchImpl: FetchImpl, invalidGrantError: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const parsed: unknown = await response.json().catch(() => null)
  const json = asRecord(parsed)
  if (!response.ok) {
    // `invalid_grant` is the one Google failure the caller has to act on rather
    // than retry. Everything else is transient or our own bug.
    if (readString(json, 'error') === 'invalid_grant') throw new Error(invalidGrantError)
    throw new Error('gmail_refresh_failed')
  }
  return json
}

/**
 * Drop a pending state without exchanging anything, for a consent that came back
 * as an error. Without this a cancelled connect leaves a live entry, and its
 * PKCE verifier, in memory for the rest of the ten-minute TTL. Unknown or
 * already-consumed states are a no-op, so a callback with a junk `state` costs
 * nothing.
 */
export function discardGoogleOAuthState(state: string): void {
  if (state) pendingStates.delete(state)
}

export async function handleGoogleCallback(opts: {
  code: string
  state: string
  fetchImpl?: FetchImpl
}): Promise<{ purpose: string }> {
  const pending = pendingStates.get(opts.state)
  if (!pending || pending.expiresAt < Date.now()) throw new Error('oauth_state_invalid')
  // Single use, consumed before the exchange: a replayed callback finds nothing.
  pendingStates.delete(opts.state)

  const client = resolveGoogleClient()
  const json = await postToken({
    code: opts.code,
    client_id: client.id,
    client_secret: client.secret,
    // The origin the auth url used, not one re-derived from this second
    // request: Google compares the two strings byte for byte.
    redirect_uri: pending.origin + CALLBACK_PATH,
    grant_type: 'authorization_code',
    code_verifier: pending.verifier,
  }, opts.fetchImpl ?? fetch, 'oauth_code_invalid')

  const refreshToken = readString(json, 'refresh_token')
  // `prompt=consent` means Google should always send one. If it did not, saving
  // the record anyway would blank a working credential, so fail and keep the
  // old one: the user is still connected and can retry.
  if (!refreshToken) throw new Error('gmail_token_missing')

  const id = credentialIdFor(pending.purpose)
  const existing = loadCredential(id)
  const now = Date.now()
  saveCredential(id, {
    id,
    provider: 'google-oauth',
    name: pending.purpose,
    createdAt: typeof existing?.createdAt === 'number' ? existing.createdAt : now,
    updatedAt: now,
    encryptedKey: encryptKey(refreshToken),
  })
  accessCache.delete(id)
  log.info(TAG, `Connected a Google account for "${pending.purpose}".`, { purpose: pending.purpose, mode: client.mode })

  return { purpose: pending.purpose }
}

async function refreshAccessToken(id: string, client: GoogleOAuthClient, fetchImpl: FetchImpl): Promise<string> {
  const credential = loadCredential(id)
  if (!credential?.encryptedKey) throw new Error('gmail_token_missing')

  let refreshToken: string
  try {
    refreshToken = decryptKey(credential.encryptedKey)
  } catch {
    // CREDENTIAL_SECRET changed since the token was stored; reconnecting is the
    // only fix, and the message must not hint at the ciphertext.
    throw new Error('gmail_token_unreadable')
  }

  const json = await postToken({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }, fetchImpl, 'gmail_token_revoked')

  const token = readString(json, 'access_token')
  if (!token) throw new Error('gmail_refresh_failed')
  const ttl = readNumber(json, 'expires_in') ?? DEFAULT_ACCESS_TTL_S
  accessCache.set(id, { token, expiresAt: Date.now() + ttl * 1000 })
  return token
}

export async function getGoogleAccessToken(purpose: string, fetchImpl: FetchImpl = fetch): Promise<string> {
  // Checked before the credential so an install with no client configured still
  // gets the named error extensions have been catching since Task 7, rather
  // than a `gmail_token_missing` that sends the operator looking in the wrong place.
  const client = resolveGoogleClientOrNull()
  if (!client) throw new GoogleOAuthNotConfiguredError(purpose)

  const id = credentialIdFor(purpose)
  // Checked ahead of the cache, not only inside the refresh. A cached access
  // token stays valid at Google for up to an hour, so returning one after the
  // credential was deleted would keep the user's mailbox readable long after
  // they pressed disconnect. Putting the check on the read path means every
  // caller gets it, whichever route removed the credential.
  if (!loadCredential(id)?.encryptedKey) {
    accessCache.delete(id)
    throw new Error('gmail_token_missing')
  }

  const cached = accessCache.get(id)
  if (cached && cached.expiresAt > Date.now() + ACCESS_TOKEN_SKEW_MS) return cached.token

  const inFlight = refreshInFlight.get(id)
  if (inFlight) return inFlight

  const request = refreshAccessToken(id, client, fetchImpl).finally(() => {
    refreshInFlight.delete(id)
  })
  refreshInFlight.set(id, request)
  return request
}

export function hasGoogleCredential(purpose: string): boolean {
  return Boolean(loadCredential(credentialIdFor(purpose))?.encryptedKey)
}
