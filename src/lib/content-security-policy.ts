/**
 * The page-level Content-Security-Policy this app serves on document requests.
 *
 * ## What this policy is for
 *
 * The app shipped without any CSP. Extension pages made that gap worse: the
 * browser-side registry appends a `<script src>` for every installed
 * extension's bundle, so the set of script URLs on a page is now partly
 * determined by whatever is installed. A baseline policy pins down the rest of
 * the page — where scripts, styles, frames and connections may come from — so
 * an injected `<script>` from a stored-XSS-shaped bug (an agent-authored
 * message, a tool result, an extension manifest string) has nowhere to load
 * from and no inline execution path.
 *
 * ## What this policy is NOT for
 *
 * It is **not** extension isolation. An extension bundle is loaded by script
 * tag into this app's own origin and is trusted code by design: it can read the
 * DOM, call every API this app can call, and reach `window.swarmclaw`. The
 * registry's React-identity check is a build-correctness check, not a trust
 * boundary (see `lib/extensions/registry.ts`), and `script-src 'self'` says
 * only "same origin", which every extension bundle is. Anyone who wants real
 * extension isolation needs a different origin and a different mechanism; this
 * header does not provide one and must not be cited as if it did.
 *
 * ## Why not 'strict-dynamic'
 *
 * Under `'strict-dynamic'` a supporting browser **ignores** every host-source
 * expression in `script-src`, `'self'` included, and admits only nonced or
 * hashed scripts plus whatever those scripts go on to inject. That would be
 * strictly stronger — but only while every page is dynamically rendered. Next
 * applies the nonce during server rendering by parsing it out of the request's
 * CSP header, so a statically prerendered page gets no nonce at all and, under
 * `'strict-dynamic'`, would load none of its scripts and render blank. The root
 * layout is `force-dynamic` today, so that holds; a future page, `not-found`,
 * or `global-error` that renders statically would silently become a white
 * screen. Plain `'self'` degrades to "still works" in that case.
 *
 * It also buys nothing here: `'strict-dynamic'` exists to stop a host allowlist
 * from being abused as a script source, and this policy allowlists no host
 * other than the app's own origin. Extension bundles are served from
 * `/api/extensions/<id>/assets/...`, which `'self'` already covers.
 *
 * ## Why there is no report-to / report-uri
 *
 * Console-only, by design. This policy ships report-only so an **operator** can
 * dry-run it on their own install, watch DevTools, and then set
 * `SWARMCLAW_CSP_ENFORCE=1`; it is a per-install switch, not a telemetry
 * channel. `report-to` would need a `Reporting-Endpoints` response header
 * naming a collector URL, and a self-hosted SwarmClaw has nowhere to point one:
 * there is no shared origin across installs, sending violations to a project
 * endpoint would exfiltrate the URLs and inline-script contents of a private
 * self-hosted deployment without consent, and a local collector route would
 * only write reports into a `data/` file nobody reads. `report-uri` is
 * deprecated on top of that.
 *
 * If a report sink is ever wanted, it needs three things together and none of
 * them alone: a route to receive `application/reports+json`, a
 * `Reporting-Endpoints` header emitted next to this policy, and an operator
 * opt-in for where the reports go.
 */

export interface ContentSecurityPolicyOptions {
  /**
   * Allow `eval`. React Refresh and the Next dev overlay reconstruct server
   * stacks with `eval`, so development would report (or, once enforcing, break)
   * on every reload without it. Neither React nor Next uses `eval` in a
   * production build, so this must stay false there.
   */
  allowEval: boolean
}

/**
 * Build the policy for one request.
 *
 * `nonce` must be the same value that ends up in the request's CSP header:
 * Next reads it back out of that header (`getScriptNonceFromHeader`) and stamps
 * it on its own framework, bundle and inline-bootstrap script tags.
 */
export function buildContentSecurityPolicy(nonce: string, options: ContentSecurityPolicyOptions): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`]
  if (options.allowEval) scriptSrc.push("'unsafe-eval'")

  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `script-src ${scriptSrc.join(' ')}`,
    // Tailwind utilities are a stylesheet, but React `style={{...}}` props are
    // inline style attributes and Recharts writes them on every render, so
    // 'unsafe-inline' is load-bearing. A nonce cannot cover a style attribute.
    `style-src 'self' 'unsafe-inline'`,
    // Agents surface remote images, and previews render from object URLs.
    `img-src 'self' data: blob: https: http:`,
    `font-src 'self' data:`,
    // Tool output and message attachments play remote audio and video.
    `media-src 'self' data: blob: https: http:`,
    // The realtime channel is a plain ws:// on PORT+1 for a self-hosted
    // install, wss:// behind TLS. Agents also fetch from the browser.
    `connect-src 'self' data: blob: ws: wss: https: http:`,
    // Chat embeds YouTube, previews uploads, and frames agent-authored HTML.
    `frame-src 'self' data: blob: https: http:`,
    `worker-src 'self' blob:`,
    `form-action 'self'`,
    // Nothing in the app is meant to be embedded, share pages included: a
    // `/s/<token>` link (`app/s/[token]/page.tsx`) is a public revocable page
    // to open, not a widget to frame. Inert while the policy is delivered
    // report-only, since browsers ignore `frame-ancestors` there, so this bites
    // only once `SWARMCLAW_CSP_ENFORCE=1` — see the note on `isCspEnforced` in
    // `proxy.ts`. Allowing embedding again means a separate policy for that
    // route, not a looser directive here.
    `frame-ancestors 'none'`,
  ].join('; ')
  // Deliberately omitted: `upgrade-insecure-requests`. Self-hosted SwarmClaw is
  // reached over plain http on localhost and on a LAN address, and upgrading
  // those to https would break every install that is not behind TLS.
}

/** Response (and request) header name for the policy, given the enforcement mode. */
export function contentSecurityPolicyHeaderName(enforce: boolean): string {
  return enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'
}
