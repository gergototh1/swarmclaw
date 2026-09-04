/**
 * Which navigations belong in the system browser rather than in the app window.
 *
 * Kept apart from `main.ts` so it can be tested without an Electron runtime: it
 * is a pure string comparison and nothing here imports `electron`.
 *
 * The case that forced it is Google consent. `/api/oauth/google/start` is an
 * app-origin URL that answers with a 302 to `accounts.google.com`, so a click on
 * it starts inside the window and *navigates out*. Electron's
 * `setWindowOpenHandler` never sees that — it only fires for `window.open` and
 * `target=_blank` — and Google refuses to render its consent screen in an
 * embedded user agent (`disallowed_useragent`). A `will-navigate` handler is
 * what catches it.
 *
 * The comparison is on the origin, not on a prefix of the start URL: the app's
 * own pages must keep loading in the window, and a prefix test would also let
 * `http://127.0.0.1:34560` through for an app on `http://127.0.0.1:3456`.
 */

/**
 * `true` when `target` should be handed to `shell.openExternal` instead of being
 * loaded in the app window. Anything on the app's own origin stays in the window,
 * so in-app navigation is untouched; anything unparseable is refused rather than
 * externalised, so a malformed URL cannot be turned into a shell request.
 */
export function shouldOpenExternally(target: string, appUrl: string): boolean {
  const targetOrigin = originOf(target)
  if (!targetOrigin) return false

  const appOrigin = originOf(appUrl)
  // With no readable app origin there is nothing to compare against, and
  // sending every link to the browser would be worse than sending none.
  if (!appOrigin) return false

  return targetOrigin !== appOrigin
}

/** `http`/`https` origin, or `''` for anything else — including `about:blank`. */
function originOf(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}
