import type { ComponentType, ReactNode } from 'react'

/** Props the host's `Dropdown` component (`components/shared/dropdown.tsx`) takes. */
export interface HostDropdownProps {
  open: boolean
  onClose: () => void
  children: ReactNode
}

/** Props the host's `DropdownItem` component takes. */
export interface HostDropdownItemProps {
  children: ReactNode
  danger?: boolean
  onClick: () => void
}

/**
 * `window.swarmclaw`, as this bundle sees it.
 *
 * Declared here rather than by augmenting `Window`: the host declares its own
 * `Window.swarmclaw` type, and a second declaration of the same property would
 * conflict with it when the root `tsc` run type-checks this directory alongside
 * the host. Reading it through a cast keeps this bundle free of the host's
 * types, which is also what lets it build on its own.
 */
export interface SwarmclawHostView {
  /** The host's own copies of `react`, `react-dom` and `react/jsx-runtime`. */
  modules: Record<string, unknown>
  registerPage: (pageId: string, component: unknown, opts: { react: unknown; extensionId: string }) => void
  /** Saves HTML as a PDF; absent on a host older than this feature. */
  savePdf?: (input: { html: string; fileName: string }) => Promise<{ status: 'saved' | 'cancelled' | 'printed' }>
  /**
   * Styling-only host components an extension page may render instead of
   * shipping its own (`components/layout/extension-host.tsx`'s `hostUi`).
   * Only the pieces this bundle actually uses are typed here; an older host
   * that predates one of them simply omits the key, so every field is
   * optional and callers must fall back when a field is missing.
   */
  ui?: {
    Dropdown?: ComponentType<HostDropdownProps>
    DropdownItem?: ComponentType<HostDropdownItemProps>
    DropdownSep?: ComponentType<Record<string, never>>
  }
}

/** The host table, or a thrown error naming what is missing. */
export function hostOf(): SwarmclawHostView {
  const host = (window as unknown as { swarmclaw?: SwarmclawHostView }).swarmclaw
  if (!host || typeof host.registerPage !== 'function' || !host.modules) {
    throw new Error('docs: window.swarmclaw is not installed; this bundle must be loaded by the SwarmClaw shell')
  }
  return host
}

/**
 * The React object this bundle's own hooks run against.
 *
 * `scripts/build.mjs` resolves every `react` import here into a read of
 * `window.swarmclaw.modules.react`, so the value returned is the one every
 * component in this directory closes over. That is what makes it the right
 * argument for `registerPage`: the registry's identity check compares it with
 * the host's React, and it would prove nothing for a bundle carrying its own.
 */
export function hostReact(): unknown {
  const react = hostOf().modules.react
  if (!react) throw new Error('docs: host module missing: react')
  return react
}

/**
 * The extension id the loader stamped on this bundle's `<script>` tag.
 *
 * The registry keys pages on the id of the extension file (`docs.mjs`, not
 * `docs`), refuses a registration whose id differs from the tag it injected,
 * and refuses one with no id at all. Read at top-level script scope only:
 * `document.currentScript` is null from any later tick.
 */
export function currentExtensionId(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const script = document.currentScript
  return script instanceof HTMLElement ? script.dataset.extension : undefined
}
