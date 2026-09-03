/**
 * Google OAuth stub.
 *
 * Extensions receive `ctx.oauth` from `setup(ctx)` so their code can already be
 * written against the final shape, but nothing issues Google tokens yet. Until
 * the credential flow lands, a call fails loudly with a named error instead of
 * returning an empty string that would surface later as an opaque 401.
 */

export class GoogleOAuthNotConfiguredError extends Error {
  readonly purpose: string

  constructor(purpose: string) {
    super(`Google OAuth is not configured, so no access token can be issued for "${purpose}".`)
    this.name = 'GoogleOAuthNotConfiguredError'
    this.purpose = purpose
  }
}

export function getGoogleAccessToken(purpose: string): Promise<string> {
  return Promise.reject(new GoogleOAuthNotConfiguredError(purpose))
}

export function hasGoogleCredential(purpose: string): boolean {
  void purpose
  return false
}
