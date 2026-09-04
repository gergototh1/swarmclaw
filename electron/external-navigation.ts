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
 * embedded user agent (`disallowed_useragent`). `will-navigate` sees only the
 * first hop, which is on the app's own origin; the Google URL arrives on
 * `will-redirect`, the event Electron raises for a server-side redirect. Both
 * are wired to this predicate in `main.ts`.
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

/**
 * Fields read off Electron's `will-navigate` / `will-redirect` `details`
 * argument (the non-deprecated one) by {@link shouldExternaliseNavigation}.
 * Named independently of either event's own params interface so this file
 * still imports nothing from `electron`.
 */
export interface NavigationDetails {
  url: string
  isMainFrame: boolean
}

/**
 * `true` when a `will-navigate` or `will-redirect` event should be cancelled
 * and its URL handed to the system browser instead.
 *
 * Gated on `isMainFrame` before the origin check: the app renders cross-origin
 * iframes of its own — a YouTube embed, an arbitrary preview URL — and a
 * redirect inside one of those must stay inside the iframe, not cancel its
 * navigation and open the system browser on page content's say-so. Only a
 * main-frame navigation is ever a candidate for externalising.
 */
export function shouldExternaliseNavigation(details: NavigationDetails, appUrl: string): boolean {
  return details.isMainFrame && shouldOpenExternally(details.url, appUrl)
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
