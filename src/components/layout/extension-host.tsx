'use client'

import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import { useEffect } from 'react'

import { createExtensionRegistry, type ExtensionRegistry } from '@/lib/extensions/registry'
import { api } from '@/lib/app/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

/**
 * What an extension page bundle sees as `window.swarmclaw`.
 *
 * `modules` is the whole reason this exists: an extension bundle is built
 * separately from the app and must resolve `react`, `react-dom` and
 * `react/jsx-runtime` as externals pointing here. If it bundles its own React,
 * `registerPage` rejects it (see `lib/extensions/registry.ts`) — but only if the
 * bundle hands `registerPage` the binding it imported. Reading
 * `window.swarmclaw.modules.react` back at the call site matches by definition
 * and proves nothing.
 */
export interface SwarmclawHost extends ExtensionRegistry {
  modules: Record<string, unknown>
  rpc: (extensionId: string, method: string, body?: object) => Promise<unknown>
  ui: Record<string, unknown>
}

declare global {
  interface Window {
    swarmclaw?: SwarmclawHost
  }
}

/**
 * Host primitives an extension page may render instead of shipping its own.
 *
 * Deliberately small: these are the styling-only, dependency-free pieces of
 * `components/ui` (plus the `Card` sub-components, without which `Card` has no
 * usable API). Anything stateful or portal-based is left out — an extension that
 * needs a dialog can build one, and exposing them would freeze host internals
 * into a public contract. Note that these render Tailwind classes compiled into
 * the host stylesheet, so an extension gets them styled for free but cannot
 * invent new Tailwind classes of its own.
 */
const hostUi: Record<string, unknown> = {
  Button,
  Badge,
  Input,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
}

// A response body that starts a whole HTML document, as opposed to a fragment.
const HTML_DOCUMENT_START = /^\s*<(?:!doctype\b|html\b|!--)/i

/**
 * Call an extension's server-side method.
 *
 * `POST /api/extensions/<id>/call/<method>` is a real route
 * (`src/app/api/extensions/[id]/call/[method]/route.ts`) and it always answers
 * `application/json` — successes and failures alike. `api()`
 * (`src/lib/app/api-client.ts`) is the one that reads the response content
 * type: a JSON response comes back parsed, and a non-JSON one is the only way a
 * raw body reaches us, as the text of the rejection. So a raw HTML document
 * here means something other than this route answered — a proxy or error page
 * in front of the app, or a build without the route — and that is the case
 * worth naming, because `api()` would otherwise reject with the whole HTML
 * document as the message and bury the one fact the author needs.
 *
 * A 200 is never that case, whatever its value looks like. A handler may return
 * an HTML fragment, and it arrives as an ordinary JSON string; sniffing the
 * first character of the parsed value would report that as a missing endpoint.
 */
async function callExtensionMethod(extensionId: string, method: string, body?: object): Promise<unknown> {
  const endpoint = `/extensions/${encodeURIComponent(extensionId)}/call/${encodeURIComponent(method)}`
  try {
    return await api('POST', endpoint, body ?? {})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (HTML_DOCUMENT_START.test(message)) {
      throw new Error(
        `Extension RPC endpoint is not available: POST /api${endpoint} returned a non-JSON response`,
      )
    }
    throw err
  }
}

/**
 * Install `window.swarmclaw` if it is not there yet, and return it.
 *
 * Idempotent, and safe to call from anywhere in the browser. Any code that
 * loads an extension bundle calls this first, so that loading a bundle never
 * depends on `ExtensionHost` having rendered.
 */
export function getHostRegistry(): SwarmclawHost {
  if (typeof window === 'undefined') {
    throw new Error('The extension registry is browser-only: there is no window to install it on')
  }
  const existing = window.swarmclaw
  if (existing) return existing

  const registry = createExtensionRegistry({ react: React })
  const host: SwarmclawHost = {
    ...registry,
    modules: {
      react: React,
      'react-dom': ReactDOM,
      'react/jsx-runtime': jsxRuntime,
    },
    rpc: callExtensionMethod,
    ui: hostUi,
  }
  window.swarmclaw = host
  return host
}

// Install at module evaluation time, which in the browser happens when the shell
// imports this file — before any component renders, and therefore before any
// effect that might load a bundle. Not because effect ordering would otherwise
// lose the race: `ExtensionHost` is the first sibling before `{children}` in the
// shell, and passive effects flush in fiber-completion order, so its effect
// already runs before any page's. The point is that this install is idempotent
// and costs nothing, and doing it here makes correctness independent of where
// the `<ExtensionHost />` JSX later moves to. Guarded because this module is also
// evaluated on the server while rendering the shell.
if (typeof window !== 'undefined') {
  getHostRegistry()
}

/**
 * Mounted once at the top of the dashboard shell. Renders nothing; it exists so
 * the registry is installed for the lifetime of the app even if the module-level
 * install above was undone (a Next.js HMR reload replaces this module). It is
 * not load-bearing on a cold page load — do not delete the module-level call
 * believing this component covers it.
 */
export function ExtensionHost() {
  useEffect(() => { getHostRegistry() }, [])
  return null
}
