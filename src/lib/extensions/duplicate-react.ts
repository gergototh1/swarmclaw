/**
 * Recognising the render error a mis-built extension bundle produces.
 *
 * Lives beside the registry rather than inside the `/x/<slug>` route because it
 * is a pure string test over browser wordings, and the only way to keep those
 * wordings honest is to pin them in a test.
 */

/**
 * The wordings a bundle carrying its own React produces on first render.
 *
 * The friendly "Invalid hook call" sentence is only one of the shapes this takes.
 * A second React's hook dispatcher is null while the host renders, and React 19
 * reads through it before reaching that check, so what actually surfaces is a
 * TypeError naming the hook, worded differently by every engine and differently
 * again between React's development and production builds. In the production
 * build the dispatcher is read off a named object, so every engine mentions
 * `ReactSharedInternals`; in the development build the call site is
 * `resolveDispatcher().useState(...)` and there is no object to name, so Firefox
 * and Safari quote the call expression instead. Verified against react 19.2.3.
 */
const DUPLICATE_REACT_WORDINGS: readonly RegExp[] = [
  // React's own check, when a build reaches it.
  /invalid hook call/i,
  // The minified production build reduces that sentence to an error code.
  /#321/,
  // Production builds of every engine: the internals object is named.
  /ReactSharedInternals/,
  // Chrome names only the property, which is `use<Name>` for a hook read and the
  // one-letter dispatcher field in a production build.
  /Cannot read propert(?:y|ies) of null \(reading '(?:use[A-Z]|H\b)/,
  // Firefox: `can't access property "useState", resolveDispatcher(...) is null`.
  /can(?:'|\u2019)t access property "(?:use[A-Z]|H\b)/,
  // Safari: `null is not an object (evaluating 'resolveDispatcher().useState')`.
  /null is not an object \(evaluating '[^']*\.(?:use[A-Z]|H\b)/,
]

/**
 * True for the render error a bundle that carries its own React produces.
 *
 * Heuristic in both directions, and cosmetic in both: an extension component that
 * reads `useFoo` off its own null object matches these wordings and is offered
 * the duplicate-React hint wrongly, and a wording no pattern here anticipates
 * gets the generic hint instead. Nothing else depends on the answer — the title,
 * the extension id, the page id and `error.message` render either way — so this
 * only selects between two hint paragraphs.
 */
export function looksLikeDuplicateReact(message: string): boolean {
  return DUPLICATE_REACT_WORDINGS.some((pattern) => pattern.test(message))
}

