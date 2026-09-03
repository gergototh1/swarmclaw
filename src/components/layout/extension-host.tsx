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
 * `registerPage` rejects it (see `lib/extensions/registry.ts`).
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
 * Install `window.swarmclaw` if it is not there yet, and return it.
 *
 * Idempotent, and safe to call from anywhere in the browser. Any code that
 * loads an extension bundle must call this first rather than assuming
 * `ExtensionHost` already ran: React runs child effects before parent effects,
 * so a page component's effect fires before the shell's.
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
    rpc: (extensionId, method, body) => api(
      'POST',
      `/extensions/${encodeURIComponent(extensionId)}/call/${encodeURIComponent(method)}`,
      body ?? {},
    ),
    ui: hostUi,
  }
  window.swarmclaw = host
  return host
}

// Install at module evaluation time, which in the browser happens when the
// shell imports this file — before any component renders, and therefore before
// any effect that might load a bundle. Guarded because this module is also
// evaluated on the server while rendering the shell.
if (typeof window !== 'undefined') {
  getHostRegistry()
}

/**
 * Mounted once at the top of the dashboard shell. Renders nothing; it exists so
 * the registry is installed for the lifetime of the app even if the module-level
 * install above was undone (a Next.js HMR reload replaces this module).
 */
export function ExtensionHost() {
  useEffect(() => { getHostRegistry() }, [])
  return null
}
