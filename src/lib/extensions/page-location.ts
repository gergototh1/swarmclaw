/**
 * Where inside its own page an extension page is standing.
 *
 * The `/x/[[...slug]]` route already resolves `/x/crm/ugyfelek/a1` to the page
 * declared at `/x/crm`. These helpers hand the remainder to the page and build
 * the URL back from it, so an extension can keep its location in the address
 * bar — which is what lets a reload, a bookmark or (later) a tab return to it.
 */

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

/** The part of `pathname` below `pagePath`, without slashes at either end; '' at the page root. */
export function extensionSubPath(pagePath: string, pathname: string): string {
  if (!pathname.startsWith(`${pagePath}/`)) return ''
  return trimSlashes(pathname.slice(pagePath.length + 1))
}

/** The URL of `subPath` inside the page declared at `pagePath`. */
export function extensionPageHref(pagePath: string, subPath: string): string {
  const rest = trimSlashes(subPath)
  return rest ? `${pagePath}/${rest}` : pagePath
}

/** The document title while an extension page names what it is showing. */
export function pageDocumentTitle(text: string | null, base: string): string {
  const trimmed = text?.trim()
  return trimmed ? `${trimmed} · ${base}` : base
}
