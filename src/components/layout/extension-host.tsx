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

/**
 * Call an extension's server-side method.
 *
 * `POST /api/extensions/<id>/call/<method>` has no route yet, so an unmatched
 * `/api/**` falls through to Next's HTML not-found page. `api()` then rejects
 * with the whole HTML document as the message, which buries the one fact the
 * author needs. Recognise a non-JSON body and say that instead.
 */
async function callExtensionMethod(extensionId: string, method: string, body?: object): Promise<unknown> {
  const endpoint = `/extensions/${encodeURIComponent(extensionId)}/call/${encodeURIComponent(method)}`
  const unavailable = () => new Error(
    `Extension RPC endpoint is not available: POST /api${endpoint} returned a non-JSON response`,
  )
  let result: unknown
  try {
    result = await api('POST', endpoint, body ?? {})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.trimStart().startsWith('<')) throw unavailable()
    throw err
  }
  // A 200 that is not JSON is the same failure wearing a different status.
  if (typeof result === 'string' && result.trimStart().startsWith('<')) throw unavailable()
  return result
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
