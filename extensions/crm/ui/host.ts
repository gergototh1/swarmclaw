/**
 * `window.swarmclaw`, as this bundle sees it.
 *
 * Declared here rather than by augmenting `Window`: the host declares its own
 * `Window.swarmclaw` type in `components/layout/extension-host.tsx`, and a
 * second declaration of the same property would conflict with it when the root
 * `tsc` run type-checks this directory alongside the host. Reading it through
 * a cast keeps this bundle free of the host's types, which is also what lets
 * it build on its own.
 */
export interface SwarmclawHostView {
  /** The host's own copies of `react`, `react-dom` and `react/jsx-runtime`. */
  modules: Record<string, unknown>
  registerPage: (pageId: string, component: unknown, opts: { react: unknown; extensionId: string }) => void
}

/** The host table, or a thrown error naming what is missing. */
export function hostOf(): SwarmclawHostView {
  const host = (window as unknown as { swarmclaw?: SwarmclawHostView }).swarmclaw
  if (!host || typeof host.registerPage !== 'function' || !host.modules) {
    throw new Error('crm: window.swarmclaw is not installed; this bundle must be loaded by the SwarmClaw shell')
  }
  return host
}

/**
 * The React object this bundle's own hooks run against.
 *
 * scripts/build.mjs resolves every `react` import in this bundle into a read of
 * `window.swarmclaw.modules.react`, so the value returned here is the one every
 * component in this directory closes over. That is what makes it the right
 * argument for `registerPage`: the registry's identity check compares it with
 * the host's React, and it would prove nothing for a bundle that carried its
 * own copy -- but this bundle cannot carry one, and test/ui.test.mjs pins that
 * the built output holds no React source.
 */
export function hostReact(): unknown {
  const react = hostOf().modules.react
  if (!react) throw new Error('crm: host module missing: react')
  return react
}

/**
 * The extension id the loader stamped on this bundle's `<script>` tag.
 *
 * The registry keys pages on the id of the extension file (`crm.mjs`, not
 * `crm`), refuses a registration whose id differs from the tag it injected,
 * and refuses one with no id at all. Read at top-level script scope only:
 * `document.currentScript` is null from any later tick.
 */
export function currentExtensionId(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const script = document.currentScript
  return script instanceof HTMLElement ? script.dataset.extension : undefined
}
